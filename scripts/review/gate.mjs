#!/usr/bin/env node
// /session-review step 2 — the deterministic gates, scoped to this session.
//
//   node scripts/review/gate.mjs [--session <id>] [--skip-tsc]
//
// Needs scope.json from session-scope.mjs. Three gates:
//
//   tsc         `tsc --noEmit` on the project (tsconfig covers src/ only).
//               Each error is placed: on a line this session added, elsewhere
//               in a touched file, or in an untouched file (a regression
//               through a changed type — or another session's work).
//   migrations  src/db/index.ts `MIGRATIONS` is append-only: an existing DB
//               has already run every entry up to its schema_version, so an
//               edited or removed entry never runs there — the fresh DB and
//               the user's DB silently diverge.
//   invariants  scripts/review/invariants.json — locked decisions held by a
//               single line of code (API key stripped from `claude -p`, server
//               bound to 127.0.0.1…). A pattern present in the pre-image and
//               gone now blocks.
//
// ⚠️ There is no verify gate: scripts/try-*.ts write to data/ (the real DB)
// and drive the logged-in browser. Never run them from a review.
//
// Writes gate.json beside scope.json. Exit 1 when a gate blocks.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, normalize, relative } from "node:path";

import { arg, loadSession, resolveSessionId, ROOT } from "./lib.mjs";

const session = loadSession(resolveSessionId());
const scopePath = join(session.dir, "scope.json");
if (!existsSync(scopePath)) {
  console.error("scope.json yok — önce: node scripts/review/session-scope.mjs");
  process.exit(2);
}
const scope = JSON.parse(readFileSync(scopePath, "utf8"));
const changed = scope.files.filter((f) => f.status !== "unchanged");
const changedSet = new Set(changed.map((f) => f.path));
const addedByFile = new Map(changed.map((f) => [f.path, expand(f.addedLines ?? [])]));

function expand(ranges) {
  const s = new Set();
  for (const r of ranges) {
    const [a, b = a] = r.split("-").map(Number);
    for (let i = a; i <= b; i++) s.add(i);
  }
  return s;
}

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: process.env });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}

function place(file, line) {
  if (!changedSet.has(file)) return "untouched-file";
  return addedByFile.get(file)?.has(line) ? "added-line" : "touched-file";
}

/** The file as it was at the base of this scope (pre-image, or last review). */
function baseText(path) {
  const pre = join(session.dir, "preimages", path);
  const rev = join(session.dir, "reviewed", path);
  const base = scope.mode === "incremental" && existsSync(rev) ? rev : pre;
  return existsSync(base) ? readFileSync(base, "utf8") : null;
}

function currentText(path) {
  const abs = join(ROOT, path);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

// ── tsc ────────────────────────────────────────────────────────────────────
async function tscGate() {
  if (arg("skip-tsc")) return { skipped: true };
  const { code, out } = await run("pnpm", ["exec", "tsc", "--noEmit", "--pretty", "false"], ROOT);
  const errors = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
    if (!m) continue;
    const file = normalize(relative(ROOT, join(ROOT, m[1])));
    const ln = Number(m[2]);
    errors.push({ file, line: ln, code: m[4], message: m[5], where: place(file, ln) });
  }
  const crashed = code !== 0 && errors.length === 0;
  // tsconfig includes src/ only — a touched .ts elsewhere is not type-checked.
  const unchecked = changed
    .filter((f) => f.status !== "deleted" && /\.tsx?$/.test(f.path) && !f.path.startsWith("src/"))
    .map((f) => f.path);
  return { ok: code === 0, errors, unchecked, ...(crashed ? { output: out.slice(-2000) } : {}) };
}

// ── migrations ─────────────────────────────────────────────────────────────
const DB_FILE = "src/db/index.ts";

function migrationEntries(src) {
  const start = src.indexOf("const MIGRATIONS");
  if (start === -1) return null;
  const open = src.indexOf("[", src.indexOf("=", start));
  const close = src.indexOf("\n];", open);
  if (open === -1 || close === -1) return null;
  return [...src.slice(open + 1, close).matchAll(/`([\s\S]*?)`/g)].map((m) => m[1].trim());
}

function migrationGate() {
  if (!changedSet.has(DB_FILE)) return { checked: false };
  const before = baseText(DB_FILE);
  const now = currentText(DB_FILE);
  if (!before) return { checked: false, note: "eski hali yok (yeni dosya)" };
  const pre = migrationEntries(before);
  const cur = now ? migrationEntries(now) : null;
  if (!pre) return { checked: false, note: "eski halde MIGRATIONS bulunamadı" };
  if (!cur) return { checked: true, ok: false, problems: ["MIGRATIONS dizisi artık okunamıyor"] };
  const problems = [];
  pre.forEach((sql, i) => {
    if (cur[i] === undefined) problems.push(`#${i + 1} silindi`);
    else if (cur[i] !== sql) problems.push(`#${i + 1} değiştirildi (mevcut DB'de zaten çalışmış; yeniden çalışmaz)`);
  });
  return { checked: true, ok: !problems.length, problems, before: pre.length, after: cur.length };
}

// ── invariants ─────────────────────────────────────────────────────────────
function invariantGate() {
  const { rules } = JSON.parse(readFileSync(join(ROOT, "scripts/review/invariants.json"), "utf8"));
  const out = [];
  for (const r of rules) {
    if (!changedSet.has(r.file)) continue;
    const re = new RegExp(r.pattern);
    const before = baseText(r.file);
    const now = currentText(r.file);
    const had = before !== null && re.test(before);
    const has = now !== null && re.test(now);
    out.push({ ...r, status: has ? "held" : had ? "broken" : "absent-before" });
  }
  return { rules: out };
}

// ── main ───────────────────────────────────────────────────────────────────
if (!changed.length) {
  console.log("Bu oturumda net değişiklik yok — kapı çalıştırılmadı.");
  process.exit(0);
}

const tsc = await tscGate();
const migrations = migrationGate();
const invariants = invariantGate();
const gate = { generatedAt: new Date().toISOString(), scopeMode: scope.mode, tsc, migrations, invariants };
writeFileSync(join(session.dir, "gate.json"), JSON.stringify(gate, null, 2));

let blocking = false;
console.log("── tsc");
if (tsc.skipped) console.log("  atlandı (--skip-tsc)");
else if (tsc.ok) console.log("  ✓ temiz");
else {
  blocking = true;
  console.log(`  ✗ ${tsc.errors.length} hata${tsc.output ? " (tsc çıktısı ayrıştırılamadı, gate.json'a bakın)" : ""}`);
  for (const e of tsc.errors.slice(0, 15)) console.log(`    [${e.where}] ${e.file}:${e.line} ${e.code} ${e.message}`);
}
if (tsc.unchecked?.length) console.log(`  △ tsconfig dışında, denetlenmedi: ${tsc.unchecked.join(", ")}`);

console.log("── migrations (yalnız sona eklenir)");
if (!migrations.checked) console.log(`  · ${DB_FILE} ${migrations.note ?? "değişmedi"}`);
else if (migrations.ok) console.log(`  ✓ ${migrations.before} → ${migrations.after} kayıt, eskiler aynen`);
else {
  blocking = true;
  for (const p of migrations.problems) console.log(`  ✗ ${p}`);
}

console.log("── kilitli kararlar (invariants.json)");
if (!invariants.rules.length) console.log("  · ilgili dosya değişmedi");
for (const r of invariants.rules) {
  if (r.status === "broken") blocking = true;
  const mark = r.status === "held" ? "✓" : r.status === "broken" ? "✗" : "?";
  console.log(`  ${mark} ${r.file} — ${r.why}${r.status === "absent-before" ? " (eski halde de yoktu)" : ""}`);
}

console.log(`\nSonuç: ${blocking ? "KAPI KAPALI — engelleyici deterministik bulgu var" : "kapı açık"} · ${join(session.dir, "gate.json")}`);
process.exit(blocking ? 1 : 0);
