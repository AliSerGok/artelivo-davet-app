#!/usr/bin/env node
// /session-review step 1 — what did THIS session change?
//
//   node scripts/review/session-scope.mjs [--session <id>] [--incremental]
//   node scripts/review/session-scope.mjs [--session <id>] --stamp
//
// Diffs every file the session touched against its PRE-IMAGE (the copy taken
// before the session's first edit), never against HEAD: the tree also holds
// other sessions' uncommitted work and the user commits mid-task.
//
// --incremental  diff against the copy taken at the last completed review
//                instead, so a re-run looks only at what changed since then.
// --stamp        record the current state as "reviewed" (run when a review ends).
// --adopt <p,q>  claim files this session changed WITHOUT Edit/Write (a Bash
//                edit), so they join the scope. Their pre-image comes from the
//                baseline snapshot. Only adopt what this session really did —
//                an "unattributed" file may be another session's work.
//
// Writes scope.json + session.diff into the session's review directory and
// prints a summary.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  addedLines,
  arg,
  fileDiff,
  git,
  loadSession,
  resolveSessionId,
  ROOT,
  toRanges,
} from "./lib.mjs";

let session = loadSession(resolveSessionId());

// ── --adopt ────────────────────────────────────────────────────────────────
const adopt = arg("adopt");
if (typeof adopt === "string") {
  const known = new Set(session.touched.map((t) => t.path));
  const lines = [];
  for (const path of adopt.split(",").map((p) => p.trim()).filter(Boolean)) {
    if (known.has(path)) continue;
    // ⚠️ Untracked at session start: it existed, but its content then was
    // never stored (only a hash), so there is no pre-image. Calling it "new"
    // would book whoever wrote it — often another session — as this session's
    // addition. Refuse; the reviewer reads such a file by hand.
    if (session.untracked.has(path)) {
      console.log(
        `Sahiplenilemedi: ${path} — oturum başında git dışıydı, o anki içeriği bilinmiyor. ` +
          "Elle incele; raporda 'eski hali bilinmiyor' diye not et."
      );
      continue;
    }
    let origin = "new";
    if (session.baseline.snapshot) {
      try {
        const content = git(["show", `${session.baseline.snapshot}:${path}`], {
          encoding: "buffer",
        });
        const pre = join(session.dir, "preimages", path);
        mkdirSync(dirname(pre), { recursive: true });
        writeFileSync(pre, content);
        origin = "existed";
      } catch {
        // not tracked at session start → treated as a new file
      }
    }
    lines.push(`${path}\t${origin}\t${new Date().toISOString()}\tadopted\n`);
    console.log(`Sahiplenildi: ${path} (${origin === "existed" ? "başlangıç hali snapshot'tan" : "yeni dosya"})`);
  }
  if (lines.length) {
    writeFileSync(join(session.dir, "touched.tsv"), lines.join(""), { flag: "a" });
    session = loadSession(session.sid);
  }
}

const { dir, baseline, touched } = session;

// ── --stamp ────────────────────────────────────────────────────────────────
if (arg("stamp")) {
  const reviewed = join(dir, "reviewed");
  rmSync(reviewed, { recursive: true, force: true });
  mkdirSync(reviewed, { recursive: true });
  const absent = [];
  for (const { path } of touched) {
    const abs = join(ROOT, path);
    if (existsSync(abs)) {
      mkdirSync(dirname(join(reviewed, path)), { recursive: true });
      cpSync(abs, join(reviewed, path));
    } else absent.push(path);
  }
  writeFileSync(
    join(dir, "reviewed.json"),
    JSON.stringify(
      { at: new Date().toISOString(), files: touched.length, absent },
      null,
      2
    )
  );
  console.log(`Damga basıldı: ${touched.length} dosya incelendi olarak kaydedildi.`);
  process.exit(0);
}

// ── scope ──────────────────────────────────────────────────────────────────
const incremental = Boolean(arg("incremental"));
const reviewedMeta = join(dir, "reviewed.json");
if (incremental && !existsSync(reviewedMeta)) {
  console.error("--incremental: bu oturumda henüz tamamlanmış inceleme yok; tam kapsamla çalıştırın.");
  process.exit(2);
}
const reviewedInfo = incremental ? JSON.parse(readFileSync(reviewedMeta, "utf8")) : null;

const files = [];
const diffs = [];
for (const t of touched) {
  const current = join(ROOT, t.path);
  let before = t.origin === "existed" ? join(dir, "preimages", t.path) : null;
  if (incremental) {
    const r = join(dir, "reviewed", t.path);
    if (existsSync(r)) before = r;
    else if (reviewedInfo.absent?.includes(t.path)) before = null;
    // touched after the stamp → keep the pre-image as the base
  }
  const after = existsSync(current) ? current : null;
  const d = fileDiff(t.path, before, after);
  const status = !d
    ? "unchanged"
    : !before
      ? "added"
      : !after
        ? "deleted"
        : "modified";
  if (status === "unchanged") {
    files.push({ path: t.path, status });
    continue;
  }
  const added = addedLines(d);
  const removed = d.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
  files.push({ path: t.path, status, added: added.length, removed, addedLines: toRanges(added) });
  diffs.push(d);
}

// ── unattributed: changed since the baseline, but not through this session's Edit/Write
const touchedSet = new Set(touched.map((t) => t.path));
const unattributed = new Set();
if (baseline.snapshot) {
  try {
    for (const p of git(["diff", "--name-only", baseline.snapshot, "--"]).split("\n")) {
      if (!p || touchedSet.has(p)) continue;
      // Untracked at the start, committed since, content unchanged: the
      // snapshot tree lacks it, but nobody touched it — not a change.
      const before = session.untracked.get(p);
      if (before !== undefined && existsSync(join(ROOT, p))) {
        if (git(["hash-object", "--", p]).trim() === before) continue;
      }
      unattributed.add(p);
    }
  } catch {
    /* snapshot unreachable — reported below */
  }
}
for (const p of git(["ls-files", "--others", "--exclude-standard"]).split("\n")) {
  if (!p || touchedSet.has(p)) continue;
  const before = session.untracked.get(p);
  if (before === undefined) unattributed.add(p);
  else {
    const now = git(["hash-object", "--", p]).trim();
    if (now !== before) unattributed.add(p);
  }
}

const changed = files.filter((f) => f.status !== "unchanged");
const scope = {
  session: session.sid,
  baseline,
  mode: incremental ? "incremental" : "full",
  since: incremental ? reviewedInfo.at : baseline.startedAt,
  generatedAt: new Date().toISOString(),
  files,
  unattributed: [...unattributed].sort(),
};
writeFileSync(join(dir, "scope.json"), JSON.stringify(scope, null, 2));
writeFileSync(join(dir, "session.diff"), diffs.join("\n"));

// ── summary ────────────────────────────────────────────────────────────────
const addSum = changed.reduce((n, f) => n + f.added, 0);
const remSum = changed.reduce((n, f) => n + f.removed, 0);
console.log(
  `Oturum ${session.sid} · ${scope.mode === "full" ? "tam" : "artımlı"} kapsam · başlangıç ${scope.since}`
);
console.log(`Değişen: ${changed.length} dosya (+${addSum} / -${remSum})`);
for (const f of changed) console.log(`  ${f.status.padEnd(8)} ${f.path}  +${f.added} -${f.removed}`);
const reverted = files.filter((f) => f.status === "unchanged");
if (reverted.length) console.log(`Dokunuldu ama net değişiklik yok: ${reverted.map((f) => f.path).join(", ")}`);
if (scope.unattributed.length) {
  console.log(
    `\n⚠️ ATANAMADI — başlangıçtan beri değişmiş ama bu oturumun Edit/Write kaydında yok ` +
      `(Bash ile düzenlenmiş olabilir ya da başka oturumun işi): ${scope.unattributed.length}`
  );
  for (const p of scope.unattributed.slice(0, 40)) console.log(`  ? ${p}`);
  if (scope.unattributed.length > 40) console.log(`  … +${scope.unattributed.length - 40}`);
}
console.log(`\nDiff: ${join(dir, "session.diff")}`);
