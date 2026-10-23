import { db, logEvent, scrubPersonal } from "../db/index.js";

// ============================================================================
// Tek kuyruk, tek işçi: işler SIRAYLA çalışır, biri bitmeden diğeri başlamaz
// (kullanıcı kuralı: taslaklar tek tek). Kuyruk veritabanında durur;
// uygulama kapanıp açılınca kaldığı yerden sürer.
// ============================================================================

export type JobKind = "collect" | "igsearch" | "draft" | "dm" | "sync" | "discover" | "email" | "threads";

export interface Job {
  id: number;
  kind: JobKind;
  ref_id: number;
  status: string;
  error: string | null;
  not_before: string | null;
}

/** İş "ertesi güne ertelendi" gibi bir sonuç döndürebilir. */
export type JobOutcome = { deferUntil: Date } | void;

type Handler = (refId: number) => Promise<JobOutcome>;
const handlers = new Map<JobKind, Handler>();

export function registerJob(kind: JobKind, handler: Handler): void {
  handlers.set(kind, handler);
}

export function enqueue(kind: JobKind, refId: number): void {
  const open = db
    .prepare(
      "SELECT 1 FROM jobs WHERE kind = ? AND ref_id = ? AND status IN ('queued','running')",
    )
    .get(kind, refId);
  if (open) return;
  db.prepare("INSERT INTO jobs (kind, ref_id) VALUES (?, ?)").run(kind, refId);
  wake();
}

// "Durduruldu" bilgisi veritabanında durur: Instagram engeliyle duran kuyruk,
// uygulama kapatılıp açılınca kendiliğinden açılıp DM göndermesin. Ayar
// formunun anahtarlarında (DEFAULT_SETTINGS) değil; saveSettings ona dokunmaz.
const PAUSED_KEY = "queuePaused";

function storedPaused(): boolean {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(PAUSED_KEY) as { value: string } | undefined;
  return row?.value === "1";
}

export const queueState = {
  paused: storedPaused(),
  current: null as Job | null,
  /** Arayüzden bir iş (giriş, test DM'i) arka plan sekmesini kullanıyor. */
  uiBusy: false,
};

/** Arka plan sekmesini arayüz için ayırır; bu sürede kuyruk yeni iş başlatmaz. */
export async function withBrowserForUi<T>(fn: () => Promise<T>): Promise<T> {
  queueState.uiBusy = true;
  try {
    return await fn();
  } finally {
    queueState.uiBusy = false;
    wake();
  }
}

let timer: NodeJS.Timeout | null = null;
let running = false;

function wake(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void tick(), 200);
}

function nextJob(): Job | undefined {
  const head = db
    .prepare(
      `SELECT * FROM jobs WHERE status = 'queued'
         AND (not_before IS NULL OR not_before <= datetime('now'))
       ORDER BY id LIMIT 1`,
    )
    .get() as Job | undefined;
  if (head?.kind !== "dm") return head;
  // Sıra DM'ye gelince önce en yeni oluşturulan mesaj gider (kullanıcı, 2026-10-21).
  return db
    .prepare(
      `SELECT j.* FROM jobs j LEFT JOIN dm_messages m ON m.artist_id = j.ref_id
        WHERE j.kind = 'dm' AND j.status = 'queued'
          AND (j.not_before IS NULL OR j.not_before <= datetime('now'))
        ORDER BY m.created_at DESC, j.id LIMIT 1`,
    )
    .get() as Job | undefined;
}

function msUntilNextDeferred(): number {
  const row = db
    .prepare(
      `SELECT MIN(not_before) AS at FROM jobs WHERE status = 'queued' AND not_before IS NOT NULL`,
    )
    .get() as { at: string | null };
  if (!row.at) return 60_000;
  // not_before UTC, saniye çözünürlüklü ("2026-10-23 00:37:23").
  const ms = Date.parse(`${row.at.replace(" ", "T")}Z`) - Date.now() + 1000;
  return Math.min(60_000, Math.max(1000, ms));
}

async function tick(): Promise<void> {
  if (running || queueState.paused) return;
  if (queueState.uiBusy) {
    timer = setTimeout(() => void tick(), 1000);
    return;
  }
  const job = nextJob();
  if (!job) {
    // Ertelenmiş iş varsa vaktinde uyan (en geç bir dakika): sabit 60 sn,
    // 30–50 sn'lik Instagram beklemesini hep ~60 sn'ye çıkarıyordu (2026-10-23).
    timer = setTimeout(() => void tick(), msUntilNextDeferred());
    return;
  }
  const handler = handlers.get(job.kind);
  running = true;
  queueState.current = job;
  db.prepare(
    "UPDATE jobs SET status = 'running', updated_at = datetime('now') WHERE id = ?",
  ).run(job.id);
  try {
    if (!handler) throw new Error(`İşleyici yok: ${job.kind}`);
    const outcome = await handler(job.ref_id);
    if (outcome && "deferUntil" in outcome) {
      db.prepare(
        `UPDATE jobs SET status = 'queued', not_before = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(
        outcome.deferUntil.toISOString().replace("T", " ").slice(0, 19),
        job.id,
      );
      logEvent("job_deferred", {
        job: job.kind,
        ref: job.ref_id,
        until: outcome.deferUntil.toISOString(),
      });
    } else {
      db.prepare(
        "UPDATE jobs SET status = 'done', error = NULL, updated_at = datetime('now') WHERE id = ?",
      ).run(job.id);
      // Arayüz bunu "Taslak hazır: …" gibi bir bildirime çevirir.
      logEvent("job_done", { job: job.kind, ref: job.ref_id });
    }
  } catch (error) {
    // İş satırı kişi silinince de kalır: kullanıcı adı yazılmaz (KVKK).
    const message = scrubPersonal(
      error instanceof Error ? error.message : String(error),
    );
    db.prepare(
      "UPDATE jobs SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(message, job.id);
    logEvent("job_failed", { job: job.kind, ref: job.ref_id, message });
  } finally {
    running = false;
    queueState.current = null;
    wake();
  }
}

/** Uygulama açılırken: yarıda kalan işleri kuyruğa geri al. */
export function startQueue(): void {
  db.prepare(
    "UPDATE jobs SET status = 'queued' WHERE status = 'running'",
  ).run();
  wake();
}

export function pauseQueue(paused: boolean): void {
  queueState.paused = paused;
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(PAUSED_KEY, paused ? "1" : "0");
  if (!paused) wake();
}

export function retryJob(id: number): void {
  db.prepare(
    "UPDATE jobs SET status = 'queued', error = NULL, not_before = NULL WHERE id = ? AND status = 'failed'",
  ).run(id);
  wake();
}

export function cancelJob(id: number): void {
  db.prepare(
    "UPDATE jobs SET status = 'cancelled' WHERE id = ? AND status IN ('queued','failed')",
  ).run(id);
}

/** Yarın sabah 09:00 (yerel) — günlük sınır dolunca. */
export function tomorrowMorning(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}
