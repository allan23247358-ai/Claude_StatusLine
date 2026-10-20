# Claude Status Bar

VS Code extension that shows the current Claude Code session in the status bar, left of every other right-side item:

```
✦ Opus 5.5 · medium │ ⌁ 5h ▰▱▱▱▱▱▱▱ 7% │ ◔ ctx ▰▱▱▱▱▱▱▱ 12% │ ● pencil ○ gamma
```

- **Model · effort** comes from the session transcript.
- **5h**: usage of the 5-hour limit, read from Claude's cache in `~/.claude.json`.
- **ctx**: context used by the last reply, compared with the model's window (1M by default, 200k for Haiku).
- **● / ○**: whether a plugin or MCP server you installed is being called right now.

From 70% the text turns yellow, from 90% red. Hover any item for details.

## Install

1. Build and install the extension:
   ```sh
   npx @vscode/vsce package --allow-missing-repository
   code --install-extension claude-statusbar-*.vsix
   ```
2. Install the activity hook (needed for ● / ○; requires `jq`):
   ```sh
   mkdir -p ~/.claude/claude-statusbar
   cp hooks/activity.sh ~/.claude/claude-statusbar/activity.sh
   ```
3. Add it to `~/.claude/settings.json` under `"hooks"`:
   ```json
   "PreToolUse":         [{ "matcher": "mcp__.*|Skill|Agent", "hooks": [{ "type": "command", "command": "bash ~/.claude/claude-statusbar/activity.sh" }] }],
   "PostToolUse":        [{ "matcher": "mcp__.*|Skill|Agent", "hooks": [{ "type": "command", "command": "bash ~/.claude/claude-statusbar/activity.sh" }] }],
   "PostToolUseFailure": [{ "matcher": "mcp__.*|Skill|Agent", "hooks": [{ "type": "command", "command": "bash ~/.claude/claude-statusbar/activity.sh" }] }],
   "UserPromptSubmit":   [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/claude-statusbar/activity.sh" }] }],
   "Stop":               [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/claude-statusbar/activity.sh" }] }],
   "StopFailure":        [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/claude-statusbar/activity.sh" }] }],
   "SessionEnd":         [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/claude-statusbar/activity.sh" }] }]
   ```
4. Reload the VS Code window.

## Settings

| Setting | Default | What it does |
|:--|:--|:--|
| `claudeStatusBar.plugins` | `[]` | Plugins to show. Empty shows every plugin and MCP server you installed. |
| `claudeStatusBar.excludePlugins` | `["Claude Docs"]` | Plugins to hide. |
| `claudeStatusBar.contextWindow` | `{}` | Context window per model ID, e.g. `{"claude-opus-5-5": 1000000}`. |
| `claudeStatusBar.warningThreshold` | `70` | Percent at which text turns yellow. |
| `claudeStatusBar.errorThreshold` | `90` | Percent at which text turns red. |
