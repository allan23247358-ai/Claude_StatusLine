#!/usr/bin/env bash
# Logs tool start/finish and turn boundaries for the VS Code status bar extension.
in=$(cat)
dir=~/.claude/claude-statusbar/events
mkdir -p "$dir"
line=$(jq -c '{t:(now*1000|floor), e:.hook_event_name, sid:(.session_id // "unknown"), tool:(.tool_name // null), id:(.tool_use_id // null), skill:(.tool_input.skill // null), agent:(.tool_input.subagent_type // null)}' <<<"$in" 2>/dev/null) || exit 0
sid=$(jq -r .sid <<<"$line")
printf '%s\n' "$line" >> "$dir/$sid.jsonl"
[ "$(jq -r .e <<<"$line")" = UserPromptSubmit ] && find "$dir" -name '*.jsonl' -mtime +7 -delete 2>/dev/null
exit 0
