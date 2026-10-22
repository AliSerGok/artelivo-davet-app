import { createHmac } from "node:crypto";

import Database from "better-sqlite3";

import { config } from "../config.js";

// ============================================================================
// Yerel veritabanı (SQLite). Uygulama kendi tablolarında tam yetkili.
// ----------------------------------------------------------------------------
// KVKK (Artelivo'nun kilitli kararı: "aday kişisel verisi saklanmaz"):
//   • seen          — taranan HERKES, yalnız profil adresinin özeti. "Bir kez
//                     taranan bir daha taranmasın" bununla; ad/link yok.
//   • candidates    — ad + profil linki, yalnız SEN karar verene kadar.
//   • ig_candidates — o adayın olası Instagram hesapları, aynı süre.
//   • artists       — onayladıkların: taslağa giden yol boyunca gereken kadar.
// Reddedilen aday `seen`'e düşer, satırları silinir.
// ============================================================================

export const db = new Database(config.dbFile);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const MIGRATIONS: string[] = [
  `
  CREATE TABLE seen (
    source   TEXT NOT NULL,
    url_hash TEXT NOT NULL,
    outcome  TEXT NOT NULL,
    at       TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (source, url_hash)
  );
  CREATE TABLE runs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    source     TEXT NOT NULL,
    category   TEXT NOT NULL,
    target     INTEGER NOT NULL,
    status     TEXT NOT NULL DEFAULT 'collecting',
    note       TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE candidates (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    source        TEXT NOT NULL,
    name          TEXT NOT NULL,
    source_url    TEXT NOT NULL,
    city          TEXT,
    works_count   INTEGER,
    bio           TEXT,
    status        TEXT NOT NULL DEFAULT 'collected',
    ig_index      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE ig_candidates (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id  INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    handle        TEXT NOT NULL,
    full_name     TEXT,
    bio           TEXT,
    followers     INTEGER,
    external_url  TEXT,
    from_source   INTEGER NOT NULL DEFAULT 0,
    score         INTEGER,
    reason        TEXT
  );
  CREATE TABLE artists (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    source         TEXT NOT NULL,
    name           TEXT NOT NULL,
    source_url     TEXT NOT NULL,
    instagram_url  TEXT NOT NULL,
    category       TEXT,
    stage          TEXT NOT NULL DEFAULT 'approved',
    selected       INTEGER NOT NULL DEFAULT 0,
    invite_id      TEXT,
    review_url     TEXT,
    report         TEXT,
    error          TEXT,
    approved_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE dm_messages (
    artist_id  INTEGER PRIMARY KEY REFERENCES artists(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'draft',
    error      TEXT,
    sent_at    TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE jobs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL,
    ref_id     INTEGER NOT NULL,
    status     TEXT NOT NULL DEFAULT 'queued',
    error      TEXT,
    not_before TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE events (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    kind   TEXT NOT NULL,
    detail TEXT,
    at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX events_kind_at ON events(kind, at);
  CREATE TABLE usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    purpose       TEXT NOT NULL,
    input_tokens  INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    at            TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // 2026-10-19: ülke ve eser aralığı tura özel (kullanıcı isteği).
  `
  ALTER TABLE runs ADD COLUMN country TEXT NOT NULL DEFAULT 'TR';
  ALTER TABLE runs ADD COLUMN min_works INTEGER;
  ALTER TABLE runs ADD COLUMN max_works INTEGER;
  ALTER TABLE artists ADD COLUMN country TEXT NOT NULL DEFAULT 'TR';
  `,
  // 2026-10-19: yarım kalan Saatchi taraması kaldığı sayfadan sürsün.
  `
  ALTER TABLE runs ADD COLUMN last_page INTEGER NOT NULL DEFAULT 0;
  `,
  // 2026-10-21: Türk olmayanlara mesaj İngilizce (kullanıcı). Ülke yetmez
  // (Türkiye'de yaşayan yabancılar): taslakta Claude tahmin eder, elle değişir.
  `
  ALTER TABLE artists ADD COLUMN dm_lang TEXT;
  `,
  // 2026-10-21: önce yeni oluşturulan mesajlar gönderilir (kullanıcı). Eski
  // satırlarda oluşturulma zamanı yok; son güncelleme yerine geçer.
  `
  ALTER TABLE dm_messages ADD COLUMN created_at TEXT;
  UPDATE dm_messages SET created_at = updated_at;
  `,
  // 2026-10-23: kaynaktaki iletişim bilgileri yalnız bilgi için (kullanıcı);
  // Artelivo'ya gitmez. JSON: { emails, website, socials }.
  `
  ALTER TABLE artists ADD COLUMN contacts TEXT;
  `,
  // 2026-10-23: e-posta varsa DM'e ek olarak davet e-postası (kullanıcı).
  `
  CREATE TABLE email_messages (
    artist_id  INTEGER PRIMARY KEY REFERENCES artists(id) ON DELETE CASCADE,
    to_addr    TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'waiting',
    error      TEXT,
    sent_at    TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // 2026-10-23: Instagram'da mesaja kapalıysa Threads'ten (kullanıcı); hangi kanaldan gitti.
  `
  ALTER TABLE dm_messages ADD COLUMN via TEXT;
  `,
  // 2026-10-23: kim aldı / kim sildi bilinsin (kullanıcı: veri yalnız bu bilgisayarda).
  // Davet kapanınca `artists` satırı yine silinir; buraya yalnız ad ve linkler kalır.
  `
  CREATE TABLE invite_outcomes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    outcome       TEXT NOT NULL,
    name          TEXT NOT NULL,
    instagram_url TEXT,
    source_url    TEXT,
    sent_at       TEXT,
    closed_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
];

function migrate(): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)",
  );
  const row = db.prepare("SELECT version FROM schema_version").get() as
    | { version: number }
    | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare("INSERT INTO schema_version VALUES (0)").run();
  for (; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version];
    if (!sql) continue;
    db.transaction(() => {
      db.exec(sql);
      db.prepare("UPDATE schema_version SET version = ?").run(version + 1);
    })();
  }
}
migrate();

// ─── Yardımcılar ────────────────────────────────────────────────────────────

/** Profil adresinin özeti — sorgu ve dil öneki atılmış haliyle. */
export function urlHash(source: string, url: string): string {
  const normalized = url
    .toLowerCase()
    .replace(/[?#].*$/, "")
    .replace(/\/(en-[a-z]{2})\//, "/")
    .replace(/\/+$/, "");
  return createHmac("sha256", config.hashKey)
    .update(`${source}:${normalized}`)
    .digest("base64url");
}

export function isSeen(source: string, url: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM seen WHERE source = ? AND url_hash = ?")
      .get(source, urlHash(source, url)),
  );
}

/** Özetin sonucu ("approved", "rejected", "works:7"…) — yoksa null. */
export function seenOutcome(source: string, url: string): string | null {
  const row = db
    .prepare("SELECT outcome FROM seen WHERE source = ? AND url_hash = ?")
    .get(source, urlHash(source, url)) as { outcome: string } | undefined;
  return row?.outcome ?? null;
}

export function markSeen(source: string, url: string, outcome: string): void {
  db.prepare(
    `INSERT INTO seen (source, url_hash, outcome) VALUES (?, ?, ?)
     ON CONFLICT(source, url_hash) DO UPDATE SET outcome = excluded.outcome`,
  ).run(source, urlHash(source, url), outcome);
}

/**
 * Olay kaydı ve iş hataları kişi silinince de KALIR: içlerinde kişiyi gösteren
 * Instagram kullanıcı adı / profil adresi olmasın (KVKK; 2026-10-19 incelemesi:
 * DM hatası "@kullanici: …" olarak süresiz duruyordu). E-posta (x@y.com)
 * dokunulmaz: önündeki harf eşleşmeyi engeller.
 */
export function scrubPersonal(text: string): string {
  return text
    .replace(
      /instagram\.com\/(?!(?:explore|accounts|direct|p|reel|reels|stories)\b)[A-Za-z0-9._]{1,30}/gi,
      "instagram.com/…",
    )
    .replace(/(^|[^A-Za-z0-9._%+-])@[A-Za-z0-9._]{1,30}/g, "$1@…");
}

export function logEvent(kind: string, detail?: unknown): void {
  db.prepare("INSERT INTO events (kind, detail) VALUES (?, ?)").run(
    kind,
    detail === undefined
      ? null
      : scrubPersonal(typeof detail === "string" ? detail : JSON.stringify(detail)),
  );
}

/** Eski kayıtlarda kalmış kullanıcı adlarını temizle (her açılışta; ucuz, tekrar zararsız). */
function scrubStoredPersonal(): void {
  const events = db
    .prepare(
      "SELECT id, detail FROM events WHERE detail LIKE '%@%' OR detail LIKE '%instagram.com/%'",
    )
    .all() as Array<{ id: number; detail: string }>;
  const jobs = db
    .prepare(
      "SELECT id, error FROM jobs WHERE error LIKE '%@%' OR error LIKE '%instagram.com/%'",
    )
    .all() as Array<{ id: number; error: string }>;
  db.transaction(() => {
    for (const e of events) {
      const clean = scrubPersonal(e.detail);
      if (clean !== e.detail)
        db.prepare("UPDATE events SET detail = ? WHERE id = ?").run(clean, e.id);
    }
    for (const j of jobs) {
      const clean = scrubPersonal(j.error);
      if (clean !== j.error)
        db.prepare("UPDATE jobs SET error = ? WHERE id = ?").run(clean, j.id);
    }
  })();
}
scrubStoredPersonal();

/** Bugün (yerel gün) bu türden kaç olay yazıldı — günlük sınırlar için. */
export function countToday(kind: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE kind = ? AND date(at, 'localtime') = date('now', 'localtime')`,
    )
    .get(kind) as { n: number };
  return row.n;
}

// ─── Ayarlar ────────────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS = {
  /** Instagram'da günde en fazla kaç DM. */
  igDmPerDay: 10,
  /** DM'ler arası rastgele bekleme (sn). */
  igDmDelayMin: 90,
  igDmDelayMax: 240,
  /** Saatchi'de eser sayısı aralığı. */
  minWorks: 10,
  maxWorks: 30,
  /** Günde en fazla davet e-postası ve aralarındaki bekleme (sn). */
  emailPerDay: 40,
  emailDelayMin: 60,
  emailDelayMax: 180,
  /** "Test DM'i" için kendi Instagram kullanıcı adın. */
  testHandle: "",
} as const;

export type Settings = {
  -readonly [K in keyof typeof DEFAULT_SETTINGS]: (typeof DEFAULT_SETTINGS)[K] extends number
    ? number
    : string;
};

export function getSettings(): Settings {
  const rows = db.prepare("SELECT key, value FROM settings").all() as Array<{
    key: string;
    value: string;
  }>;
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const out: Record<string, number | string> = {};
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    const raw = stored[key];
    out[key] =
      typeof fallback === "number"
        ? raw !== undefined && raw.trim() !== "" && Number.isFinite(Number(raw))
          ? Number(raw)
          : fallback
        : (raw ?? fallback);
  }
  return out as Settings;
}

export function saveSettings(values: Partial<Record<string, string>>): void {
  const upsert = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = values[key];
    if (value !== undefined) upsert.run(key, value.trim());
  }
}
