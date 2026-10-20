'use strict';
// Claude Status Bar: shows model · effort, 5h usage, context and plugin activity
// for the current Claude Code session, left of the "✻ Claude Code" item.
//
// Data sources (all local, read-only):
//   ~/.claude/projects/<workspace>/<session>.jsonl  model, effort, token usage
//   ~/.claude.json  cachedUsageUtilization          5h / 7d limits, installed MCP servers
//   ~/.claude/claude-statusbar/events/<sid>.jsonl   plugin start/finish, written by activity.sh hook

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const CLAUDE_JSON = path.join(HOME, '.claude.json');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const OUR_DIR = path.join(CLAUDE_DIR, 'claude-statusbar');
const EVENTS_DIR = path.join(OUR_DIR, 'events');

const BAR_CELLS = 8;
const STALE_TOOL_MS = 30 * 60 * 1000; // a tool start with no finish after this long counts as finished
const POLL_MS = 2000;
// Right-aligned items: higher priority sits further left. A high number keeps the whole
// panel left of every other right-side item (Copilot, Claude Code, notifications).
const PRIORITY = 100000;

const COLOR = {
  warn: new vscode.ThemeColor('editorWarning.foreground'),
  error: new vscode.ThemeColor('editorError.foreground'),
  active: new vscode.ThemeColor('charts.green'),
  idle: new vscode.ThemeColor('disabledForeground'),
  sep: new vscode.ThemeColor('disabledForeground'),
};

// ---------- helpers ----------

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function projectDirName(p) {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

function cfg() {
  return vscode.workspace.getConfiguration('claudeStatusBar');
}

function modelName(id) {
  if (!id) return 'Claude';
  const m = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(id);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
}

function contextWindowFor(model) {
  const overrides = cfg().get('contextWindow') || {};
  if (model && overrides[model]) return overrides[model];
  const id = (model || '').toLowerCase();
  if (id.includes('[1m]')) return 1000000;
  if (/haiku|claude-3|opus-4-[015]|sonnet-4-[05]|-4-2025/.test(id)) return 200000;
  return 1000000;
}

function bar(p) {
  const f = Math.max(0, Math.min(BAR_CELLS, Math.round((p / 100) * BAR_CELLS)));
  return '▰'.repeat(f) + '▱'.repeat(BAR_CELLS - f);
}

function levelColor(p) {
  const c = cfg();
  if (p >= c.get('errorThreshold', 90)) return COLOR.error;
  if (p >= c.get('warningThreshold', 70)) return COLOR.warn;
  return undefined;
}

function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 2 : 0).replace(/\.?0+$/, '') + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

function fmtAgo(ms) {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'только что';
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  return `${Math.floor(s / 86400)} д назад`;
}

function fmtUntil(ms) {
  const m = Math.max(0, Math.round((ms - Date.now()) / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин`;
}

function mdTable(rows) {
  return '| | |\n|:--|--:|\n' + rows.map(([a, b]) => `| ${a} | ${b} |`).join('\n');
}

// ---------- session ----------

function workspacePaths() {
  return (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
}

// Newest transcript among the workspace's project folders (or anywhere if no workspace).
function findSessionFile() {
  let dirs = workspacePaths().map((p) => path.join(PROJECTS_DIR, projectDirName(p)));
  if (!dirs.length) {
    try { dirs = fs.readdirSync(PROJECTS_DIR).map((d) => path.join(PROJECTS_DIR, d)); } catch { dirs = []; }
  }
  let best = null;
  for (const dir of dirs) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const f = path.join(dir, n);
      const t = mtime(f);
      if (!best || t > best.t) best = { file: f, t };
    }
  }
  return best && best.file;
}

// Last main-thread assistant message with usage, read from the end of the file.
function readLastAssistant(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    let chunk = 256 * 1024;
    for (;;) {
      const start = Math.max(0, size - chunk);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n');
      if (start > 0) lines.shift();
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"assistant"')) continue;
        let o;
        try { o = JSON.parse(lines[i]); } catch { continue; }
        const msg = o && o.message;
        if (o.type === 'assistant' && !o.isSidechain && msg && msg.usage && msg.model && msg.model !== '<synthetic>') return o;
      }
      if (start === 0 || chunk >= 16 * 1024 * 1024) return null;
      chunk *= 4;
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// ---------- plugins ----------

function mcpPrefix(serverName) {
  return 'mcp__' + serverName.replace(/[^a-zA-Z0-9_-]/g, '_') + '__';
}

// Plugins and MCP servers the user installed. Claude's built-in ones are left out.
function discoverPlugins() {
  const list = [];
  const seen = new Set();
  const add = (label, match) => {
    const key = label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ label: key, match });
  };
  const cj = readJson(CLAUDE_JSON) || {};
  const servers = new Set(Object.keys(cj.mcpServers || {}));
  for (const ws of workspacePaths()) {
    const proj = (cj.projects || {})[ws] || {};
    Object.keys(proj.mcpServers || {}).forEach((s) => servers.add(s));
    const mcpJson = readJson(path.join(ws, '.mcp.json'));
    if (mcpJson) Object.keys(mcpJson.mcpServers || {}).forEach((s) => servers.add(s));
  }
  for (const s of servers) {
    const prefix = mcpPrefix(s);
    add(s, (ev) => !!ev.tool && ev.tool.startsWith(prefix));
  }
  for (const full of cj.claudeAiMcpEverConnected || []) {
    const prefix = mcpPrefix(full);
    add(full.replace(/^claude\.ai\s+/i, ''), (ev) => !!ev.tool && ev.tool.startsWith(prefix));
  }
  const installed = readJson(path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json')) || {};
  const settings = readJson(path.join(CLAUDE_DIR, 'settings.json')) || {};
  const pluginIds = new Set([
    ...Object.keys(installed.plugins || {}),
    ...Object.entries(settings.enabledPlugins || {}).filter(([, v]) => v).map(([k]) => k),
  ]);
  for (const id of pluginIds) {
    if (id.endsWith('@builtin')) continue;
    const name = id.split('@')[0];
    add(name, (ev) =>
      (!!ev.tool && ev.tool.startsWith(`mcp__plugin_${name}_`)) ||
      (!!ev.skill && ev.skill.startsWith(name + ':')) ||
      (!!ev.agent && ev.agent.startsWith(name + ':')));
  }

  const only = (cfg().get('plugins') || []).map((s) => s.toLowerCase());
  const exclude = (cfg().get('excludePlugins') || []).map((s) => s.toLowerCase());
  return list.filter((p) => (only.length ? only.includes(p.label) : !exclude.includes(p.label)));
}

// Replays the hook log: which plugins are mid-call, how often and when each was used.
function pluginActivity(sessionId, plugins) {
  const stats = new Map(plugins.map((p) => [p.label, { open: new Map(), calls: 0, last: 0 }]));
  if (!sessionId) return stats;
  let text;
  try { text = fs.readFileSync(path.join(EVENTS_DIR, sessionId + '.jsonl'), 'utf8'); } catch { return stats; }
  for (const line of text.split('\n')) {
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (['UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd'].includes(ev.e)) {
      for (const s of stats.values()) s.open.clear();
      continue;
    }
    const p = plugins.find((x) => x.match(ev));
    if (!p) continue;
    const s = stats.get(p.label);
    const key = ev.id || ev.tool || ev.skill || ev.agent;
    if (ev.e === 'PreToolUse') {
      s.open.set(key, ev.t);
      s.calls++;
      s.last = ev.t;
    } else if (ev.e === 'PostToolUse' || ev.e === 'PostToolUseFailure') {
      s.open.delete(key);
      s.last = ev.t;
    }
  }
  const now = Date.now();
  for (const s of stats.values()) {
    for (const [k, t] of s.open) if (now - t > STALE_TOOL_MS) s.open.delete(k);
  }
  return stats;
}

// ---------- usage limits ----------

function readLimits() {
  const cj = readJson(CLAUDE_JSON);
  const u = cj && cj.cachedUsageUtilization;
  if (!u || !u.utilization || !u.utilization.five_hour) return null;
  const f = u.utilization.five_hour;
  const reset = f.resets_at ? Date.parse(f.resets_at) : 0;
  const week = u.utilization.seven_day;
  return {
    five: reset && reset < Date.now() ? 0 : f.utilization,
    fiveReset: reset,
    expired: !!reset && reset < Date.now(),
    week: week ? week.utilization : null,
    fetchedAt: u.fetchedAtMs || 0,
  };
}

// ---------- status bar ----------

class StatusBar {
  constructor() {
    let prio = PRIORITY;
    const make = (id) => vscode.window.createStatusBarItem('claudeStatusBar.' + id, vscode.StatusBarAlignment.Right, (prio -= 0.001));
    this.model = make('model');
    this.sep1 = make('sep1');
    this.five = make('five');
    this.sep2 = make('sep2');
    this.ctx = make('ctx');
    this.sep3 = make('sep3');
    this.pluginPrio = () => (prio -= 0.001);
    this.plugins = [];
    for (const s of [this.sep1, this.sep2, this.sep3]) {
      s.text = '│';
      s.color = COLOR.sep;
      s.name = 'Claude Status Bar separator';
    }
    this.model.name = 'Claude model';
    this.five.name = 'Claude 5h usage';
    this.ctx.name = 'Claude context';
    this.model.command = 'claudeStatusBar.openTranscript';
    this.five.command = { title: 'Usage', command: 'vscode.open', arguments: [vscode.Uri.parse('https://claude.ai/settings/usage')] };
  }

  setPlugins(labels) {
    if (this.plugins.length === labels.length && this.plugins.every((p, i) => p.label === labels[i])) return;
    this.plugins.forEach((p) => p.item.dispose());
    this.plugins = labels.map((label) => {
      const item = vscode.window.createStatusBarItem('claudeStatusBar.plugin.' + label, vscode.StatusBarAlignment.Right, this.pluginPrio());
      item.name = 'Claude plugin ' + label;
      return { label, item };
    });
  }

  render(s) {
    // Model · effort
    this.model.text = `$(sparkle) ${s.modelName}${s.effort ? ' · ' + s.effort : ''}`;
    const mt = new vscode.MarkdownString(undefined, true);
    mt.isTrusted = true;
    mt.appendMarkdown('**Модель**\n\n' + mdTable([
      ['Модель', s.modelName],
      ['ID', `\`${s.modelId || '—'}\``],
      ['Effort', s.effort || '—'],
      ['Сессия', s.sessionId ? `\`${s.sessionId.slice(0, 8)}…\`` : '—'],
      ['Последний ответ', fmtAgo(s.lastAt)],
    ]) + '\n\n[Открыть журнал сессии](command:claudeStatusBar.openTranscript)');
    this.model.tooltip = mt;
    this.model.show();
    this.sep1.show();

    // 5h usage
    const L = s.limits;
    if (L && L.five != null) {
      const p = Math.round(L.five);
      this.five.text = `$(pulse) 5h ${bar(p)} ${p}%`;
      this.five.color = levelColor(p);
    } else {
      this.five.text = '$(pulse) 5h —';
      this.five.color = undefined;
    }
    const ft = new vscode.MarkdownString(undefined, true);
    if (L) {
      const rows = [['Использовано', L.five != null ? Math.round(L.five) + '%' : '—']];
      if (L.fiveReset) rows.push(['Сброс', L.expired ? 'уже прошёл' : 'через ' + fmtUntil(L.fiveReset)]);
      if (L.week != null) rows.push(['Неделя', Math.round(L.week) + '%']);
      rows.push(['Обновлено', fmtAgo(L.fetchedAt)]);
      ft.appendMarkdown('**Usage — окно 5 часов**\n\n' + mdTable(rows) + '\n\nДанные из кеша Claude, он обновляет их сам. Клик откроет страницу лимитов.');
    } else {
      ft.appendMarkdown('**Usage — окно 5 часов**\n\nClaude ещё не сохранил данные о лимитах. Они появятся после следующего запроса.');
    }
    this.five.tooltip = ft;
    this.five.show();
    this.sep2.show();

    // Context
    if (s.ctxUsed != null) {
      const p = Math.min(100, Math.round((s.ctxUsed / s.ctxWindow) * 100));
      this.ctx.text = `$(pie-chart) ctx ${bar(p)} ${p}%`;
      this.ctx.color = levelColor(p);
      const ct = new vscode.MarkdownString(undefined, true);
      const rows = [
        ['Занято', `${fmtTokens(s.ctxUsed)} / ${fmtTokens(s.ctxWindow)}`],
        ['Из кеша', fmtTokens(s.ctxCached || 0)],
      ];
      if (s.autoCompact) rows.push(['Авто-compact', 'около ' + fmtTokens(s.autoCompact)]);
      rows.push(['Ответ модели', fmtTokens(s.outTokens || 0)]);
      ct.appendMarkdown('**Контекст**\n\n' + mdTable(rows));
      this.ctx.tooltip = ct;
    } else {
      this.ctx.text = '$(pie-chart) ctx —';
      this.ctx.color = undefined;
      this.ctx.tooltip = 'В этой папке ещё нет сессии Claude';
    }
    this.ctx.show();

    // Plugins
    this.setPlugins(s.plugins.map((p) => p.label));
    const pt = new vscode.MarkdownString(undefined, true);
    pt.appendMarkdown('**Плагины в этой сессии**\n\n' + mdTable(s.plugins.map((p) => {
      const st = s.activity.get(p.label);
      const on = st.open.size > 0;
      return [`${on ? '●' : '○'} ${p.label}`, `${on ? 'работает сейчас' : fmtAgo(st.last)} · ${st.calls}×`];
    })) + '\n\n● сейчас вызывается · ○ простаивает · × вызовов');
    for (const { label, item } of this.plugins) {
      const on = s.activity.get(label).open.size > 0;
      item.text = `${on ? '●' : '○'} ${label}`;
      item.color = on ? COLOR.active : COLOR.idle;
      item.tooltip = pt;
      item.show();
    }
    if (this.plugins.length) this.sep3.show(); else this.sep3.hide();
  }

  dispose() {
    [this.model, this.sep1, this.five, this.sep2, this.ctx, this.sep3].forEach((i) => i.dispose());
    this.plugins.forEach((p) => p.item.dispose());
  }
}

// ---------- state ----------

function collect() {
  const file = findSessionFile();
  const sessionId = file ? path.basename(file, '.jsonl') : null;
  const last = file ? readLastAssistant(file) : null;
  const settings = readJson(path.join(CLAUDE_DIR, 'settings.json')) || {};

  const modelId = (last && last.message.model) || null;
  const modelSettings = (settings.modelSettings || {})[modelId] || {};
  const effort = (last && (last.perTurnEffort || last.effort)) ||
    modelSettings.effortLevel || settings.effortLevel || null;

  let ctxUsed = null, ctxCached = 0, outTokens = 0;
  if (last) {
    const u = last.message.usage;
    ctxCached = u.cache_read_input_tokens || 0;
    ctxUsed = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + ctxCached;
    outTokens = u.output_tokens || 0;
  }
  const ctxWindow = contextWindowFor(modelId);

  const plugins = discoverPlugins();
  return {
    file,
    sessionId,
    modelId,
    modelName: modelName(modelId),
    effort,
    lastAt: last ? Date.parse(last.timestamp) : 0,
    ctxUsed,
    ctxCached,
    ctxWindow,
    outTokens,
    autoCompact: modelSettings.autoCompactWindow || null,
    limits: readLimits(),
    plugins,
    activity: pluginActivity(sessionId, plugins),
  };
}

function activate(context) {
  const bar = new StatusBar();
  let current = null;
  let timer = null;

  const refresh = () => {
    try {
      current = collect();
      bar.render(current);
    } catch (e) {
      console.error('[claude-statusbar]', e);
    }
  };
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 150);
  };

  // Instant updates where the folders exist, plus a slow poll for everything else.
  const watchers = [];
  const watch = (dir) => {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    try { watchers.push(fs.watch(dir, soon)); } catch {}
  };
  watch(EVENTS_DIR);
  for (const ws of workspacePaths()) {
    const d = path.join(PROJECTS_DIR, projectDirName(ws));
    if (fs.existsSync(d)) watch(d);
  }
  const poll = setInterval(refresh, POLL_MS);

  context.subscriptions.push(
    bar,
    { dispose: () => { clearInterval(poll); clearTimeout(timer); watchers.forEach((w) => w.close()); } },
    vscode.commands.registerCommand('claudeStatusBar.refresh', refresh),
    vscode.commands.registerCommand('claudeStatusBar.openTranscript', async () => {
      if (!current || !current.file) return vscode.window.showInformationMessage('В этой папке ещё нет сессии Claude.');
      const doc = await vscode.workspace.openTextDocument(current.file);
      const ed = await vscode.window.showTextDocument(doc, { preview: true });
      const end = doc.lineAt(doc.lineCount - 1).range.end;
      ed.revealRange(new vscode.Range(end, end));
    }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('claudeStatusBar')) refresh(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
  );
  refresh();
}

function deactivate() {}

module.exports = { activate, deactivate };
