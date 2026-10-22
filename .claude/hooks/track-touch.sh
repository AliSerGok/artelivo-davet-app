#!/usr/bin/env bash
# PreToolUse Edit|Write — on the FIRST touch of a file in this session, keep a
# copy of it as it was. That copy, not `git diff`, is what /session-review
# diffs against: the working tree here also holds other sessions' uncommitted
# work, and HEAD moves when the user commits mid-task.
#
# ⚠️ Edits made through Bash (sed, heredoc) never reach this hook. The review
# reports such files as "unattributed" instead of guessing whose they are.
set -u

input=$(cat)
sid=$(printf '%s' "$input" | jq -r '.session_id // empty')
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
[ -n "$sid" ] && [ -n "$file" ] || exit 0

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
case "$file" in
  "$root"/*) rel="${file#"$root"/}" ;;
  *) exit 0 ;; # outside the repo (scratchpad, memory) — not reviewable work
esac
case "$rel" in
  .claude/session-review/*|node_modules/*|*/node_modules/*) exit 0 ;;
esac

dir="$root/.claude/session-review/$sid"
[ -d "$dir" ] || exit 0 # no baseline (session predates the hook) — nothing to compare to
touched="$dir/touched.tsv"

if ! cut -f1 "$touched" 2>/dev/null | grep -qxF -- "$rel"; then
  if [ -f "$file" ]; then
    mkdir -p "$dir/preimages/$(dirname "$rel")"
    cp -p "$file" "$dir/preimages/$rel"
    printf '%s\texisted\t%s\n' "$rel" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$touched"
  else
    printf '%s\tnew\t%s\n' "$rel" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$touched"
  fi
  touch "$dir" # still alive — keeps another session's 14-day cleanup off it
fi
exit 0
