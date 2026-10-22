// Shared plumbing for /session-review's deterministic steps.
//
// The data these read is written by two hooks (.claude/hooks/session-baseline.sh
// and track-touch.sh) into .claude/session-review/<session_id>/:
//   baseline.json  — HEAD, a `git stash create` snapshot, branch, start time
//   untracked.tsv  — untracked files at session start, with content hashes
//   touched.tsv    — every file this session edited through Edit/Write
//   preimages/     — each touched file as it was BEFORE this session's first edit
//   reviewed/      — each touched file as it was at the last completed review
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const REVIEW_DIR = join(ROOT, ".claude/session-review");

export function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

export function git(args, opts = {}) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

/** Resolve which session to review: --session, then the hook-exported env. */
export function resolveSessionId() {
  const explicit = arg("session");
  if (typeof explicit === "string") return explicit;
  if (process.env.CLAUDE_REVIEW_SESSION) return process.env.CLAUDE_REVIEW_SESSION;
  const known = existsSync(REVIEW_DIR)
    ? readdirSync(REVIEW_DIR)
        .filter((d) => existsSync(join(REVIEW_DIR, d, "baseline.json")))
        .map((d) => ({ d, t: statSync(join(REVIEW_DIR, d, "touched.tsv")).mtimeMs }))
        .sort((a, b) => b.t - a.t)
    : [];
  console.error(
    "Oturum kimliği verilmedi (--session <id>) ve CLAUDE_REVIEW_SESSION yok.\n" +
      (known.length
        ? "Bilinen oturumlar (son dokunulan önce):\n" +
          known
            .slice(0, 8)
            .map(({ d, t }) => `  ${d}  ${new Date(t).toISOString()}`)
            .join("\n")
        : "Hiç oturum kaydı yok — SessionStart hook'u bu oturumdan sonra eklendiyse kayıt yeni oturumda başlar.")
  );
  process.exit(2);
}

export function loadSession(sid) {
  const dir = join(REVIEW_DIR, sid);
  const baselinePath = join(dir, "baseline.json");
  if (!existsSync(baselinePath)) {
    console.error(`Oturum kaydı yok: ${dir}`);
    process.exit(2);
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const touched = readTsv(join(dir, "touched.tsv")).map(([path, origin, at]) => ({
    path,
    origin, // "existed" | "new"
    at,
  }));
  const untracked = new Map(readTsv(join(dir, "untracked.tsv")));
  return { sid, dir, baseline, touched, untracked };
}

function readTsv(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
}

/** Unified diff between two files (either may be null = absent). */
export function fileDiff(rel, beforePath, afterPath) {
  const res = spawnSync(
    "git",
    [
      "diff",
      "--no-index",
      "--no-color",
      "--unified=3",
      "--",
      beforePath ?? "/dev/null",
      afterPath ?? "/dev/null",
    ],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  // exit 1 = differences, 0 = identical
  const text = res.stdout ?? "";
  if (!text) return "";
  // Rewrite the temp/pre-image paths in the headers to the repo path.
  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("diff --git ")) return `diff --git a/${rel} b/${rel}`;
      if (line.startsWith("--- ") && beforePath) return `--- a/${rel}`;
      if (line.startsWith("+++ ") && afterPath) return `+++ b/${rel}`;
      return line;
    })
    .join("\n");
}

/** Current-file line numbers that the diff adds or changes. */
export function addedLines(diff) {
  const lines = [];
  let cur = 0;
  for (const line of diff.split("\n")) {
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      cur = Number(h[1]);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) lines.push(cur++);
    else if (line.startsWith("-") && !line.startsWith("---")) continue;
    else cur++;
  }
  return lines;
}

export function toRanges(nums) {
  const out = [];
  for (const n of nums) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`));
}

export function rel(abs) {
  return relative(ROOT, abs);
}
