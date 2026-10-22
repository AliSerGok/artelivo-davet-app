#!/usr/bin/env bash
# SessionStart — record what the tree looked like when THIS session began, so
# /session-review can tell this session's work from everything else.
#
# ⚠️ Nothing here touches the working tree. `git stash create` writes a commit
# object for the current tracked state and leaves files, index and stash list
# alone — other sessions on this repo keep their uncommitted work.
#
# ⚠️ Written ONCE per session id. `resume` and `compact` fire this hook again
# with the same id; overwriting would move the baseline past the work it is
# supposed to measure.
set -u

input=$(cat)
sid=$(printf '%s' "$input" | jq -r '.session_id // empty')
[ -n "$sid" ] || exit 0

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$root" 2>/dev/null || exit 0
base="$root/.claude/session-review"
dir="$base/$sid"

# Let Bash calls in this session find their own review directory.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export CLAUDE_REVIEW_SESSION=$sid" >>"$CLAUDE_ENV_FILE"
fi

if [ ! -f "$dir/baseline.json" ]; then
  mkdir -p "$dir/preimages"
  head=$(git rev-parse HEAD 2>/dev/null || echo "")
  # ⚠️ `git stash create` refreshes and REWRITES the index (taking
  # index.lock) — a parallel session's `git add` can then fail on the lock,
  # or this call can fail and the snapshot silently degrade to HEAD. Run it
  # against a throwaway copy of the index instead.
  real_index=$(git rev-parse --git-path index 2>/dev/null)
  tmp_index=$(mktemp "${TMPDIR:-/tmp}/session-review-index.XXXXXX")
  [ -f "$real_index" ] && cp "$real_index" "$tmp_index"
  snap=$(GIT_INDEX_FILE="$tmp_index" git stash create 2>/dev/null || true)
  rm -f "$tmp_index"
  [ -n "$snap" ] || snap="$head"
  # Keep the snapshot reachable — a dangling stash commit is gc'able.
  [ -n "$snap" ] && git update-ref "refs/session-review/$sid" "$snap" 2>/dev/null
  # Untracked files are not in the stash commit; record their content hashes.
  git ls-files --others --exclude-standard 2>/dev/null | while IFS= read -r p; do
    printf '%s\t%s\n' "$p" "$(git hash-object -- "$p" 2>/dev/null)"
  done >"$dir/untracked.tsv"
  : >"$dir/touched.tsv"
  jq -n --arg sid "$sid" --arg head "$head" --arg snap "$snap" \
    --arg branch "$(git branch --show-current 2>/dev/null)" \
    --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{session:$sid, head:$head, snapshot:$snap, branch:$branch, startedAt:$at}' \
    >"$dir/baseline.json"
fi

# Mark this session alive: track-touch appends to files inside the directory,
# which does not bump the directory's own mtime — without this a session
# resumed after 14 days found itself "old" below and deleted its own record.
touch "$dir"

# Housekeeping: OTHER sessions untouched for 14 days lose their directory and ref.
find "$base" -mindepth 1 -maxdepth 1 -type d -mtime +14 ! -name "$sid" 2>/dev/null | while read -r old; do
  git update-ref -d "refs/session-review/$(basename "$old")" 2>/dev/null
  rm -rf "$old"
done
exit 0
