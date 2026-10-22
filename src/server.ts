import { createHash } from "node:crypto";
import { execFile } from "node:child_process";

import { serve } from "@hono/node-server";
import { type Context, Hono } from "hono";

import { usageSummary } from "./ai/claude.js";
import { ArtelivoError, artelivo } from "./artelivo/client.js";
import { config, missingConfig } from "./config.js";
import {
  DEFAULT_SETTINGS,
  countToday,
  db,
  getSettings,
  logEvent,
  markSeen,
  saveSettings,
} from "./db/index.js";
import {
  type Artist,
  closedCounts,
  prepareDm,
  queueEmail,
  setStage,
  syncWithArtelivo,
} from "./jobs/handlers.js";
import { bestEmail, readContacts, trustedEmail, urlKey } from "./contacts/index.js";
import { verifySmtp } from "./mail/index.js";
import {
  cancelJob,
  enqueue,
  type Job,
  pauseQueue,
  queueState,
  retryJob,
  withBrowserForUi,
  startQueue,
} from "./jobs/queue.js";
import { DM_MAX, isLoggedIn, sendDm, splitForDm } from "./instagram/index.js";
import {
  closeBrowserIfOpen,
  openUiWindow,
  pruneScreenshots,
  workTab,
} from "./lib/browser.js";
import { reviewStatus, startReview, stopReview } from "./review/index.js";
import { COUNTRIES, countryByIso } from "./sources/countries.js";
import { SOURCES, sourceOf } from "./sources/index.js";
import {
  badge,
  emptyState,
  html,
  type Raw,
  page,
  pageHeader,
  progressBar,
  raw,
  steps,
  type Tone,
} from "./ui/html.js";

const app = new Hono();
const ORIGINS = new Set([
  `http://127.0.0.1:${config.port}`,
  `http://localhost:${config.port}`,
]);

// Yalnız bu bilgisayardan, yalnız bu sayfadan: başka bir site tarayıcı üzerinden
// buraya form gönderip DM attıramasın (CSRF), DNS yeniden bağlama işlemesin.
app.use("*", async (c, next) => {
  const host = c.req.header("host") ?? "";
  if (!ORIGINS.has(`http://${host}`)) return c.text("Forbidden", 403);
  if (c.req.method !== "GET") {
    const origin = c.req.header("origin");
    if (!origin || !ORIGINS.has(origin)) return c.text("Forbidden", 403);
  }
  await next();
});

type FlashTone = "ok" | "info" | "warn" | "bad";

/**
 * Düğmenin sonucu: yönlendirmeden önce bir çerez bırakılır, açılan sayfa onu
 * sağ altta bildirim olarak gösterir (kullanıcı, 2026-10-19: "butona basınca
 * bir şey olduğu belli olmuyor").
 */
function back(
  c: Context,
  url: string,
  title: string,
  text = "",
  tone: FlashTone = "ok",
): Response {
  c.header(
    "Set-Cookie",
    `davet_flash=${encodeURIComponent(JSON.stringify({ title, text, tone }))}; Path=/; Max-Age=60; SameSite=Strict`,
  );
  return c.redirect(url);
}

/** Sanatçının yolculuğu: Onaylandı → Taslak → Önizleme → Mesaj → Gönderildi → Profili aldı. */
const STEP_LABELS = ["Onay", "Taslak", "Önizleme", "Mesaj", "Gönderildi", "Aldı"];

const STAGE: Record<
  string,
  { label: string; tone: Tone; step: number; state?: "active" | "failed" }
> = {
  approved: { label: "Taslak bekliyor", tone: "neutral", step: 0 },
  scraping: { label: "Saatchi okunuyor", tone: "progress", step: 0, state: "active" },
  extracting: { label: "Taslak hazırlanıyor", tone: "progress", step: 0, state: "active" },
  drafted: { label: "Önizleme onayı bekliyor", tone: "info", step: 1 },
  draft_failed: { label: "Taslak hatası", tone: "bad", step: 0, state: "failed" },
  ineligible: { label: "Uygun değil", tone: "warn", step: 0, state: "failed" },
  preview_approved: { label: "Önizleme onaylı", tone: "ok", step: 2 },
  dm_ready: { label: "Mesaj hazır", tone: "info", step: 3 },
  dm_sent: { label: "DM gönderildi", tone: "ok", step: 4 },
  claimed: { label: "Profili aldı", tone: "ok", step: 5 },
  declined: { label: "İstemedi", tone: "neutral", step: 4 },
  expired: { label: "Süresi doldu", tone: "neutral", step: 4 },
  withdrawn: { label: "Taslak silindi", tone: "neutral", step: 1 },
};
/**
 * Düğmenin geldiği sayfaya (sekmesiyle) dön: "/artists?tab=onaylanan"dan
 * basılan düğme sonucu yine o sekmede gösterilir.
 */
function backPath(c: Context, fallback: string): string {
  const ref = c.req.header("referer") ?? "";
  try {
    const url = new URL(ref);
    if (ORIGINS.has(url.origin) && url.pathname === new URL(fallback, url.origin).pathname) {
      return url.pathname + url.search;
    }
  } catch {
    // geçersiz referer
  }
  return fallback;
}

interface TabDef {
  key: string;
  label: string;
  stages: string[] | null;
  /** Bağlantı taraması yapılmış mı (verilmezse fark etmez). */
  scanned?: boolean;
}

/**
 * Sanatçılar sekmeleri (kullanıcı, 2026-10-20). Sıra = akışın sırası; her
 * sanatçı tek bir akış sekmesinde. Önizlemesi onaylanan, bağlantısı taranmadan
 * mesaja geçmez (kullanıcı, 2026-10-23: taranan/taranmayan ayrı).
 */
const ARTIST_TABS: TabDef[] = [
  { key: "bekleyen", label: "Taslağı oluşturulmayan", stages: ["approved", "draft_failed", "ineligible", "scraping", "extracting"] },
  { key: "olusturulan", label: "Taslağı oluşturulan", stages: ["drafted"] },
  { key: "taranmayan", label: "Bağlantısı taranmayan", stages: ["preview_approved"], scanned: false },
  { key: "taranan", label: "Bağlantısı taranan", stages: ["preview_approved"], scanned: true },
  { key: "hazir", label: "Mesajı hazır", stages: ["dm_ready"] },
  { key: "gonderilen", label: "Mesaj gönderilen", stages: ["dm_sent", "claimed", "declined", "expired", "withdrawn"] },
  { key: "tumu", label: "Tümü", stages: null },
];

function tabBar(base: string, tabs: Array<{ key: string; label: string; count: number }>, active: string): Raw {
  return html`<nav class="tabs">
    ${tabs.map(
      (t) => html`<a href="${base}?tab=${t.key}" class="tab${t.key === active ? " on" : ""}">${t.label}<span>${t.count}</span></a>`,
    )}
  </nav>`;
}

const stageOf = (stage: string) =>
  STAGE[stage] ?? { label: stage, tone: "neutral" as Tone, step: 0 };

const ids = (body: Record<string, unknown>): number[] => {
  const v = body["ids"];
  const list = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return list.map(Number).filter((n) => Number.isInteger(n) && n > 0);
};

const openInDefaultBrowser = (url: string) => execFile("open", [url], () => {});
const handleOf = (url: string) =>
  url.replace(/^https:\/\/(www\.)?instagram\.com\//, "@").replace(/\/$/, "");
const one = <T>(sql: string, ...args: unknown[]) =>
  db.prepare(sql).get(...args) as T | undefined;
const countOf = (sql: string, ...args: unknown[]) =>
  (db.prepare(sql).get(...args) as { n: number }).n;
const categoryLabel = (source: string, category: string) =>
  sourceOf(source).categories.find((x) => x.value === category)?.label ?? category;

// ─── Durum ──────────────────────────────────────────────────────────────────

/**
 * Ekranda görünen verinin parmak izi. Sayfa her 3 sn'de durum sorarken bunu
 * da alır; değiştiyse içeriği kendiliğinden yeniler (kullanıcı, 2026-10-19:
 * "sayfayı hep yenilemek gerekiyor"). Tablolar küçük; tam okuma ucuz.
 */
function dataVersion(): string {
  const row = db
    .prepare(
      `SELECT
         (SELECT group_concat(id || ':' || status || ':' || coalesce(note,'') || ':' || last_page, '|') FROM runs) AS runs,
         (SELECT group_concat(run_id || ':' || status || ':' || n, '|') FROM (SELECT run_id, status, COUNT(*) AS n FROM candidates GROUP BY run_id, status)) AS candidates,
         (SELECT group_concat(id || ':' || stage || ':' || coalesce(invite_id,'') || ':' || coalesce(error,'') || ':' || coalesce(updated_at,''), '|') FROM artists) AS artists,
         (SELECT group_concat(artist_id || ':' || status || ':' || coalesce(error,'') || ':' || length(text), '|') FROM dm_messages) AS dms,
         (SELECT group_concat(id || ':' || status || ':' || coalesce(not_before,''), '|') FROM (SELECT id, status, not_before FROM jobs ORDER BY id DESC LIMIT 100)) AS jobs,
         (SELECT COALESCE(MAX(id), 0) FROM events) AS events`,
    )
    .get() as Record<string, unknown>;
  const job = queueState.current as Job | null;
  return createHash("sha1")
    .update(JSON.stringify([row, queueState.paused, job?.id ?? null, reviewStatus().active]))
    .digest("hex")
    .slice(0, 12);
}

const artistName = (id: number) =>
  one<{ name: string }>("SELECT name FROM artists WHERE id = ?", id)?.name ?? `#${id}`;

/**
 * Toplu işin ilerlemesi: sırada/çalışan en eski bu türden işten bu yana
 * eklenenler ("4/18", "3 tamam, 14 kaldı"). Tek işse null.
 */
function batchOf(kind: string): { position: string; tally: string } | null {
  const b = one<{ total: number; done: number; failed: number; left: number }>(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(status = 'done'), 0) AS done,
            COALESCE(SUM(status = 'failed'), 0) AS failed,
            COALESCE(SUM(status = 'queued'), 0) AS left
       FROM jobs
      WHERE kind = ? AND status != 'cancelled'
        AND created_at >= (SELECT MIN(created_at) FROM jobs WHERE kind = ? AND status IN ('queued','running'))`,
    kind,
    kind,
  );
  if (!b || b.total <= 1) return null;
  const tally = [`${b.done} tamam`, ...(b.failed ? [`${b.failed} hatalı`] : []), `${b.left} kaldı`];
  return { position: `${b.done + b.failed + 1}/${b.total}`, tally: tally.join(", ") };
}

/** Çalışan işin insan diliyle anlatımı (üstteki "şu an" şeridi). */
function describeJob(job: Job): { title: string; detail: string; since: string | null } {
  const since =
    one<{ updated_at: string }>("SELECT updated_at FROM jobs WHERE id = ?", job.id)
      ?.updated_at ?? null;
  if (job.kind === "collect") {
    const run = one<{ source: string; category: string; country: string; target: number; last_page: number }>(
      "SELECT source, category, country, target, last_page FROM runs WHERE id = ?",
      job.ref_id,
    );
    const found = countOf("SELECT COUNT(*) AS n FROM candidates WHERE run_id = ?", job.ref_id);
    return {
      title: run
        ? `${sourceOf(run.source).label} taranıyor · ${categoryLabel(run.source, run.category)} · ${countryByIso(run.country).label}`
        : "Kaynak taranıyor",
      detail: run ? `${found}/${run.target} aday bulundu · sayfa ${run.last_page + 1}` : "",
      since,
    };
  }
  if (job.kind === "igsearch") {
    return { title: `Adaylar onaya hazırlanıyor · tur #${job.ref_id}`, detail: "", since };
  }
  if (job.kind === "draft") {
    const a = one<{ name: string; stage: string }>("SELECT name, stage FROM artists WHERE id = ?", job.ref_id);
    const detail =
      a?.stage === "scraping"
        ? "1/3 · Saatchi profili ve eserleri okunuyor"
        : a?.stage === "extracting"
          ? "2/3 · Claude taslağı hazırlıyor, sonra Artelivo'ya gönderilecek"
          : "Artelivo'da açık taslak aranıyor";
    const name = a?.name ?? `#${job.ref_id}`;
    const b = batchOf("draft");
    return { title: b ? `Taslak ${b.position}: ${name} · ${b.tally}` : `Taslak: ${name}`, detail, since };
  }
  if (job.kind === "discover") {
    // Toplu taramada sırayla, biri bitmeden diğeri başlamaz; sayaç bunu gösterir.
    const name = artistName(job.ref_id);
    const b = batchOf("discover");
    return {
      title: b ? `Bağlantı taraması ${b.position}: ${name} · ${b.tally}` : `Bağlantılar taranıyor: ${name}`,
      detail: "Saatchi, Instagram bio'su, siteler ve platform profilleri (en çok 15 sayfa)",
      since,
    };
  }
  if (job.kind === "email") {
    const to = one<{ to_addr: string }>("SELECT to_addr FROM email_messages WHERE artist_id = ?", job.ref_id)?.to_addr;
    return { title: `Davet e-postası: ${artistName(job.ref_id)}`, detail: to ? `→ ${to}` : "", since };
  }
  if (job.kind === "threads") {
    return { title: `Threads mesajı: ${artistName(job.ref_id)}`, detail: "Instagram'dan gitmedi, Threads deneniyor", since };
  }
  if (job.kind === "dm") {
    return {
      title: `Instagram mesajı: ${artistName(job.ref_id)}`,
      detail: "Sahiplenme linki alınıyor, mesaj gönderiliyor",
      since,
    };
  }
  return { title: "Artelivo'dan durumlar çekiliyor", detail: "", since };
}

const JOB_LABEL: Record<string, string> = {
  collect: "Tarama",
  igsearch: "Aday hazırlığı",
  draft: "Taslak",
  dm: "Instagram mesajı",
  sync: "Durum yenileme",
  discover: "Bağlantı keşfi",
  email: "Davet e-postası",
  threads: "Threads mesajı",
};

/** Olay → bildirim. Adlar olay kaydında yok (KVKK); o an tablolardan okunur. */
function toastOf(
  kind: string,
  detail: Record<string, unknown>,
): { title: string; text: string; tone: FlashTone } | null {
  const ref = Number(detail.ref ?? 0);
  if (kind === "job_done") {
    if (detail.job === "draft") {
      const a = one<{ name: string; stage: string; error: string | null }>(
        "SELECT name, stage, error FROM artists WHERE id = ?",
        ref,
      );
      if (!a) return null;
      if (a.stage === "draft_failed")
        return { title: `Taslak oluşturulamadı: ${a.name}`, text: (a.error ?? "").slice(0, 200), tone: "bad" };
      if (a.stage === "ineligible")
        return { title: `Uygun değil: ${a.name}`, text: (a.error ?? "").slice(0, 200), tone: "warn" };
      return { title: `Taslak hazır: ${a.name}`, text: "Sanatçılar'dan önizlemeyi açıp onayla.", tone: "ok" };
    }
    if (detail.job === "collect") return { title: "Tarama bitti", text: `Tur #${ref}`, tone: "info" };
    if (detail.job === "igsearch") {
      const n = countOf("SELECT COUNT(*) AS n FROM candidates WHERE run_id = ? AND status = 'ready'", ref);
      return { title: `Onaya hazır: ${n} aday`, text: `Turlar → tur #${ref} → "Onaya başla"`, tone: "ok" };
    }
    if (detail.job === "email") {
      const to = one<{ to_addr: string; status: string }>("SELECT to_addr, status FROM email_messages WHERE artist_id = ?", ref);
      if (to?.status === "sent") return { title: `E-posta gönderildi: ${artistName(ref)}`, text: to.to_addr, tone: "ok" };
      return null;
    }
    if (detail.job === "discover") {
      const c = readContacts(one<{ contacts: string | null }>("SELECT contacts FROM artists WHERE id = ?", ref)?.contacts);
      return {
        title: `Bağlantılar tarandı: ${artistName(ref)}`,
        text: `${c.emails.length} e-posta · ${c.links.length} link · ${c.pages} sayfa`,
        tone: c.emails.length ? "ok" : "info",
      };
    }
    if (detail.job === "dm" || detail.job === "threads") {
      const status = one<{ status: string }>("SELECT status FROM dm_messages WHERE artist_id = ?", ref)?.status;
      if (status === "sent") return { title: `Mesaj gönderildi: ${artistName(ref)}`, text: "", tone: "ok" };
      if (status === "unverified")
        return { title: `Gönderim doğrulanamadı: ${artistName(ref)}`, text: "Mesajlar'da kontrol et.", tone: "warn" };
      return null;
    }
    return null;
  }
  if (kind === "job_failed") {
    const who = ["draft", "dm", "discover", "email", "threads"].includes(String(detail.job)) ? `: ${artistName(ref)}` : ` #${ref}`;
    return {
      title: `${JOB_LABEL[String(detail.job)] ?? "İş"} başarısız${who}`,
      text: String(detail.message ?? "").slice(0, 200),
      tone: "bad",
    };
  }
  // DM'ler arası kısa bekleme bildirim değil (üst şerit "sırada" der); yalnız
  // güne taşan erteleme (günlük sınır, Instagram uyarısı) bildirilir.
  if (
    kind === "job_deferred" &&
    detail.job === "dm" &&
    (!detail.until || Date.parse(String(detail.until)) - Date.now() > 2 * 3600 * 1000)
  )
    return { title: `Mesaj yarına ertelendi: ${artistName(ref)}`, text: "Günlük sınır ya da Instagram uyarısı — yarın 09:00'dan sonra gider.", tone: "warn" };
  if (kind === "ig_blocked")
    return { title: "Instagram engel gösterdi", text: "Gönderim durduruldu. Instagram'ı elle açıp kontrol et.", tone: "bad" };
  if (kind === "review_empty") return { title: "Onaylanacak aday yok", text: "", tone: "info" };
  if (kind === "review_failed")
    return { title: "Onay penceresi açılamadı", text: String(detail.message ?? "").slice(0, 200), tone: "bad" };
  if (kind === "ig_search_box_failed")
    return { title: "Instagram araması yazılamadı", text: "Sağ pencerede aramayı elle yap.", tone: "warn" };
  if (kind === "image_upload_failed")
    return { title: "Bir görsel yüklenemedi", text: String(detail.reason ?? ""), tone: "warn" };
  if (kind === "sync_failed") return { title: "Artelivo'dan durumlar alınamadı", text: "", tone: "warn" };
  return null;
}

/**
 * Önizleme onayını çabuk yakala: onay bekleyen taslak varken arayüz açık
 * olduğu sürece en çok 30 sn'de bir Artelivo'ya bakılır (eskiden 10 dk —
 * kullanıcı onayladığı halde "onaylamadı" görüyordu, 2026-10-19).
 */
let lastQuickSync = 0;
let quickSyncRunning = false;
function quickSyncIfWaiting(): void {
  if (quickSyncRunning || Date.now() - lastQuickSync < 30_000 || !config.artelivo.agentKey) return;
  const waiting = countOf(
    "SELECT COUNT(*) AS n FROM artists WHERE invite_id IS NOT NULL AND stage = 'drafted'",
  );
  if (!waiting) return;
  lastQuickSync = Date.now();
  quickSyncRunning = true;
  void syncWithArtelivo()
    .catch(() => {})
    .finally(() => {
      quickSyncRunning = false;
    });
}

app.get("/api/status", (c) => {
  quickSyncIfWaiting();
  const job = queueState.current as Job | null;
  const queued = countOf("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'");
  const lastEvent = countOf("SELECT COALESCE(MAX(id), 0) AS n FROM events");
  const sinceParam = c.req.query("since");
  const events: Array<{ title: string; text: string; tone: FlashTone }> = [];
  if (sinceParam !== undefined) {
    const rows = db
      .prepare("SELECT kind, detail FROM events WHERE id > ? ORDER BY id LIMIT 20")
      .all(Number(sinceParam) || 0) as Array<{ kind: string; detail: string | null }>;
    for (const row of rows) {
      let detail: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(row.detail ?? "{}") as unknown;
        if (parsed && typeof parsed === "object") detail = parsed as Record<string, unknown>;
      } catch {
        // düz metin ayrıntı
      }
      const t = toastOf(row.kind, detail);
      if (t) events.push(t);
    }
  }
  return c.json({
    version: dataVersion(),
    paused: queueState.paused,
    current: job ? describeJob(job) : null,
    queued,
    // Sıradaki zamanı gelmemiş iş (DM arası bekleme, yarına ertelenen): ne zaman.
    nextAt:
      one<{ t: string | null }>(
        "SELECT MIN(not_before) AS t FROM jobs WHERE status = 'queued' AND not_before > datetime('now')",
      )?.t ?? null,
    dmToday: countToday("ig_dm"),
    dmLimit: getSettings().igDmPerDay,
    review: reviewStatus().active,
    counts: {
      runs: countOf("SELECT COUNT(*) AS n FROM candidates WHERE status = 'ready'"),
      artists: countOf("SELECT COUNT(*) AS n FROM artists WHERE stage IN ('approved','drafted','preview_approved')"),
      messages: countOf("SELECT COUNT(*) AS n FROM dm_messages WHERE status IN ('draft','unverified')"),
      jobs: countOf("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running','failed')"),
    },
    events,
    lastEvent,
  });
});

// ─── Turlar ─────────────────────────────────────────────────────────────────

const RUN_STATUS: Record<string, { label: string; tone: Tone }> = {
  collecting: { label: "Taranıyor", tone: "progress" },
  searching: { label: "Adaylar hazırlanıyor", tone: "progress" },
  ready: { label: "Onay bekliyor", tone: "info" },
  done: { label: "Bitti", tone: "ok" },
};

app.get("/", (c) => {
  const runs = db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 50").all() as Array<{
    id: number;
    source: string;
    category: string;
    target: number;
    status: string;
    note: string | null;
    country: string;
    min_works: number | null;
    max_works: number | null;
    created_at: string;
  }>;
  const missing = missingConfig();
  const settings = getSettings();
  const review = reviewStatus();
  return c.html(
    page(
      "Turlar",
      "/",
      html`
        ${pageHeader(
          "Turlar",
          "Kaynaktan sanatçı topla, sonra her adayı Instagram'ıyla yan yana görüp onayla.",
          review.active
            ? html`<form method="post" action="/review/stop" class="inline"><button class="secondary" data-busy="Kapatılıyor">Onay penceresini kapat</button></form>`
            : undefined,
        )}
        ${missing.length
          ? html`<div class="callout bad"><b>Eksik ayar:</b> ${missing.join(", ")} · <a href="/settings">Ayarlar</a></div>`
          : ""}
        <form method="post" action="/runs" class="card">
          <h2>Yeni tur</h2>
          <div class="form-grid">
            <label class="field">Kaynak ve branş
              <select name="target_source">
                ${Object.values(SOURCES).map(
                  (src) => html`<optgroup label="${src.label}">${src.categories.map(
                    (cat) => html`<option value="${src.id}:${cat.value}">${cat.label}</option>`,
                  )}</optgroup>`,
                )}
              </select>
            </label>
            <label class="field">Kaç sanatçı
              <input name="target" type="number" min="1" max="500" value="20" />
            </label>
            <label class="field">Ülke
              <select name="country">
                ${COUNTRIES.map((x) => html`<option value="${x.iso}">${x.label}</option>`)}
              </select>
            </label>
            <label class="field">Eser sayısı (en az – en çok)
              <span class="range">
                <input name="min_works" type="number" min="0" max="10000" value="${settings.minWorks}" />–
                <input name="max_works" type="number" min="0" max="10000" value="${settings.maxWorks}" />
              </span>
            </label>
            <button class="primary" data-busy="Başlatılıyor">Taramayı başlat</button>
          </div>
          <p class="muted small" style="margin:10px 0 0">Daha önce bakılan kişiler atlanır. Tarama arka planda sürer; üstteki şeritte izleyebilirsin.</p>
        </form>
        <div class="card flush">
          ${runs.length
            ? html`<table>
                <thead><tr><th>Tur</th><th>Filtre</th><th>Durum</th><th>İlerleme</th><th></th></tr></thead>
                <tbody>
                ${runs.map((r) => {
                  const ready = countOf("SELECT COUNT(*) AS n FROM candidates WHERE run_id = ? AND status = 'ready'", r.id);
                  const total = countOf("SELECT COUNT(*) AS n FROM candidates WHERE run_id = ?", r.id);
                  const running = Boolean(
                    one("SELECT 1 FROM jobs WHERE ref_id = ? AND kind IN ('collect','igsearch') AND status IN ('queued','running')", r.id),
                  );
                  const st = RUN_STATUS[r.status] ?? { label: r.status, tone: "neutral" as Tone };
                  const stalled = canResume(r);
                  return html`<tr>
                    <td class="nowrap"><b>#${r.id}</b><div class="muted small">${r.created_at.slice(0, 16)}</div></td>
                    <td>
                      <b>${sourceOf(r.source).label} · ${categoryLabel(r.source, r.category)}</b>
                      <div class="muted small">${countryByIso(r.country).label} · ${r.min_works ?? settings.minWorks}–${r.max_works ?? settings.maxWorks} eser · hedef ${r.target}</div>
                    </td>
                    <td>${stalled ? badge("Yarıda kaldı", "warn") : badge(st.label, running ? "progress" : st.tone)}</td>
                    <td style="min-width:170px">
                      ${r.status === "collecting"
                        ? html`${progressBar(total, r.target)}<div class="muted small" style="margin-top:4px">${total}/${r.target} aday</div>`
                        : html`<div class="small">${ready ? html`<b>${ready}</b> aday onay bekliyor` : r.status === "done" ? "Tüm adaylara karar verildi" : ""}</div>
                            ${r.note && (stalled || r.status === "searching") ? html`<div class="muted small">${r.note}</div>` : ""}`}
                    </td>
                    <td class="nowrap" style="text-align:right">
                      ${ready
                        ? html`<form method="post" action="/runs/${r.id}/review" class="inline"><button class="primary" data-busy="Pencereler açılıyor">Onaya başla (${ready})</button></form>`
                        : ""}
                      ${stalled
                        ? html`<form method="post" action="/runs/${r.id}/resume" class="inline"><button class="secondary" data-busy="Sıraya alınıyor">Devam ettir</button></form>`
                        : ""}
                      <form method="post" action="/runs/${r.id}/delete" class="inline" onsubmit="return confirm('Tur #${r.id} ve karar verilmemiş adayları silinsin mi?')">
                        <button class="danger" title="Turu sil">Sil</button>
                      </form>
                    </td>
                  </tr>`;
                })}
                </tbody>
              </table>`
            : emptyState("Henüz tur yok", "Yukarıdan branş ve ülke seçip ilk taramayı başlat.")}
        </div>
      `,
    ),
  );
});

app.post("/runs", async (c) => {
  const body = await c.req.parseBody();
  // "kaynak:branş" — her kaynağın kendi branş listesi tek kutuda.
  const [source = "", category = ""] = String(body["target_source"] ?? "").split(":");
  const target = Math.max(1, Math.min(500, Number(body["target"] ?? 20)));
  const country = String(body["country"] ?? "TR");
  const minWorks = Math.max(0, Math.floor(Number(body["min_works"])));
  const maxWorks = Math.max(0, Math.floor(Number(body["max_works"])));
  if (
    !SOURCES[source] ||
    !sourceOf(source).categories.some((x) => x.value === category) ||
    !COUNTRIES.some((x) => x.iso === country)
  ) {
    return back(c, "/", "Tur başlatılamadı", "Kaynak, branş ya da ülke geçersiz.", "bad");
  }
  if (!Number.isFinite(minWorks) || !Number.isFinite(maxWorks) || minWorks > maxWorks) {
    return back(c, "/", "Tur başlatılamadı", "Eser aralığı geçersiz: en az ≤ en çok olmalı.", "bad");
  }
  const run = db
    .prepare(
      "INSERT INTO runs (source, category, target, country, min_works, max_works) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(source, category, target, country, minWorks, maxWorks);
  enqueue("collect", Number(run.lastInsertRowid));
  return back(
    c,
    "/",
    `Tur #${run.lastInsertRowid} başladı`,
    `${categoryLabel(source, category)} · ${countryByIso(country).label} · ${target} sanatçı aranıyor.${queueState.paused ? " Kuyruk durdurulmuş — İşler'den sürdür." : ""}`,
    queueState.paused ? "warn" : "ok",
  );
});

/** Yarım kalmış tur: toplanıyor/aranıyor görünür ama sırada ya da çalışan işi yok. */
function canResume(run: { id: number; status: string }): boolean {
  if (!["collecting", "searching"].includes(run.status)) return false;
  return !one(
    "SELECT 1 FROM jobs WHERE ref_id = ? AND kind IN ('collect','igsearch') AND status IN ('queued','running')",
    run.id,
  );
}

// Saatchi taraması kaldığı sayfadan (last_page), aday hazırlığı kalan kişiden sürer.
app.post("/runs/:id/resume", (c) => {
  const id = Number(c.req.param("id"));
  const run = one<{ id: number; status: string }>("SELECT id, status FROM runs WHERE id = ?", id);
  if (!run || !canResume(run)) return back(c, "/", "Bu tur zaten sürüyor", "", "info");
  db.prepare(
    "UPDATE jobs SET status = 'cancelled' WHERE ref_id = ? AND kind IN ('collect','igsearch') AND status = 'failed'",
  ).run(id);
  enqueue(run.status === "collecting" ? "collect" : "igsearch", id);
  // Kuyruğu AÇMAZ: durmuşsa (Instagram engeli ya da elle) açınca bekleyen
  // DM'ler de gider — o karar yalnız İşler'deki "Kuyruğu sürdür"ün.
  return queueState.paused
    ? back(c, "/jobs", `Tur #${id} sıraya alındı`, "Kuyruk durduruldu: başlaması için \"Kuyruğu sürdür\".", "warn")
    : back(c, "/", `Tur #${id} kaldığı yerden sürüyor`);
});

app.post("/runs/:id/review", async (c) => {
  // Beklemeden dön: yönetim penceresi istek sürerken asılı kalmasın.
  const runId = Number(c.req.param("id"));
  void startReview(runId)
    .then((opened) => {
      if (!opened) logEvent("review_empty", { run: runId });
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[onay] açılamadı:", message);
      logEvent("review_failed", { run: runId, message });
    });
  return back(c, "/", "Onay pencereleri açılıyor", "Solda Saatchi, sağda Instagram. Bu pencere küçülür, bitince geri gelir.", "info");
});
app.post("/review/stop", async (c) => {
  await stopReview();
  return back(c, "/", "Onay penceresi kapatıldı", "", "info");
});
app.post("/runs/:id/delete", (c) => {
  const runId = Number(c.req.param("id"));
  // "Bir kez taranan bir daha taranmaz": tur silinse de adayları özet olarak
  // kalır (ad/link değil), sonraki turlarda yeniden gelmez.
  db.transaction(() => {
    const rows = db
      .prepare("SELECT source, source_url FROM candidates WHERE run_id = ?")
      .all(runId) as Array<{ source: string; source_url: string }>;
    for (const row of rows) markSeen(row.source, row.source_url, "run_deleted");
    db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
  })();
  return back(c, "/", `Tur #${runId} silindi`, "Adayları bir daha taranmaz.", "info");
});

// ─── Sanatçılar ─────────────────────────────────────────────────────────────

interface AuditRow {
  ok: "ok" | "warn" | "bad" | "none";
  label: string;
  detail: string;
}

function reportNotes(report: string | null): {
  warn: string;
  audit: AuditRow[];
  notes: Array<{ level: string; text: string }>;
} {
  try {
    const r = report
      ? (JSON.parse(report) as {
          needsReview?: boolean;
          report?: { droppedWorks?: string[]; failedImages?: unknown[]; works?: number; images?: number };
          audit?: AuditRow[];
          notes?: Array<{ level: string; text: string }>;
        })
      : null;
    const bits = [
      r?.needsReview ? "Aynı web sitesi başka bir profilde — önizlemede onay ister" : "",
      r?.report?.droppedWorks?.length ? `${r.report.droppedWorks.length} eser düştü` : "",
      r?.report?.failedImages?.length ? `${r.report.failedImages.length} görsel inmedi` : "",
    ].filter(Boolean);
    return { warn: bits.join(" · "), audit: r?.audit ?? [], notes: r?.notes ?? [] };
  } catch {
    return { warn: "", audit: [], notes: [] };
  }
}

const AUDIT_MARK: Record<AuditRow["ok"], string> = { ok: "✓", warn: "⚠", bad: "✗", none: "–" };

/** Taslağın kaynağa karşı denetimi: özet satırı + açılır ayrıntı. */
function auditView(key: string, audit: AuditRow[], notes: Array<{ level: string; text: string }>): Raw | string {
  if (!audit.length && !notes.length) return "";
  const bad = audit.filter((a) => a.ok === "bad").length;
  const warn = audit.filter((a) => a.ok === "warn").length + notes.filter((n) => n.level === "warn").length;
  const ok = audit.filter((a) => a.ok === "ok").length;
  return html`<details class="audit" data-key="${key}">
    <summary class="${bad ? "bad" : warn ? "warn" : "ok"}">Denetim: ✓ ${ok}${warn ? ` · ⚠ ${warn}` : ""}${bad ? ` · ✗ ${bad}` : ""}</summary>
    <ul>
      ${audit.map((a) => html`<li class="a-${a.ok}"><b>${AUDIT_MARK[a.ok]} ${a.label}</b> <span>${a.detail}</span></li>`)}
      ${notes.map((n) => html`<li class="a-${n.level === "warn" ? "warn" : "none"}"><b>${n.level === "warn" ? "⚠" : "ℹ"} Not</b> <span>${n.text}</span></li>`)}
    </ul>
  </details>`;
}

app.get("/artists", (c) => {
  const rows = db.prepare("SELECT * FROM artists ORDER BY id DESC").all() as Array<
    Artist & { report: string | null; error: string | null; updated_at: string; contacts: string | null }
  >;
  const closed = closedCounts();
  const closedLabel: Record<string, string> = {
    claimed: "profili aldı",
    declined: "istemedi",
    expired: "süresi doldu",
    withdrawn: "taslak silindi",
  };
  const scanned = new Set(rows.filter((r) => readContacts(r.contacts).discoveredAt).map((r) => r.id));
  const inTab = (t: TabDef, r: { id: number; stage: string }) =>
    (!t.stages || t.stages.includes(r.stage)) && (t.scanned === undefined || t.scanned === scanned.has(r.id));
  const counts = ARTIST_TABS.map((t) => ({ ...t, count: rows.filter((r) => inTab(t, r)).length }));
  // Sekme seçilmediyse: akışta işi olan ilk sekme.
  const requested = ARTIST_TABS.find((t) => t.key === c.req.query("tab"));
  const tab = requested ?? counts.find((t) => t.count > 0 && t.key !== "tumu") ?? ARTIST_TABS[0]!;
  const shown = rows.filter((r) => inTab(tab, r));
  const can = (action: "draft" | "preview" | "discover" | "dm") =>
    tab.key === "tumu" ||
    (action === "draft" && tab.key === "bekleyen") ||
    (action === "preview" && ["olusturulan", "taranmayan", "taranan"].includes(tab.key)) ||
    (action === "discover" && ["taranmayan", "taranan", "hazir", "gonderilen"].includes(tab.key)) ||
    (action === "dm" && ["taranan", "hazir"].includes(tab.key));
  // Akıştaki adımın düğmesi öne çıkar.
  const lead = (action: string) =>
    ({ bekleyen: "draft", olusturulan: "preview", taranmayan: "discover", taranan: "dm" })[tab.key] === action
      ? "primary"
      : "secondary";
  const HINT: Record<string, string> = {
    bekleyen: "Seç → Taslak oluştur. Taslaklar sırayla, kişi başı ~3 dk.",
    olusturulan: "Önizlemeleri aç, her birinde Onayla — onaylananlar kendiliğinden yan sekmeye geçer.",
    taranmayan: "Önizlemesi onaylananlar. Seç → Bağlantıları tara; taranan yan sekmeye geçer. Tarama hiçbir şey göndermez.",
    taranan: "Sonuç her satırın Bağlantılar kutusunda. Seç → Mesaj hazırla.",
    hazir: "Mesajı yazıldı; Mesajlar sayfasında okunup sen gönder deyince gider.",
    gonderilen: "Mesajı gitmiş sanatçılar; sahiplenen / istemeyen / süresi dolan burada görünür, sonra kayıtları silinir.",
    tumu: "Bütün sanatçılar.",
  };
  return c.html(
    page(
      "Sanatçılar",
      "/artists",
      html`
        ${pageHeader(
          "Sanatçılar",
          "Onayladığın sanatçılar. Seç → taslak oluştur → önizlemede onayla → mesaj hazırla.",
        )}
        ${tabBar("/artists", counts, tab.key)}
        <p class="muted small tab-hint">${HINT[tab.key] ?? ""}</p>
        <form method="post" class="card flush">
          <div class="selbar">
            <span class="selcount zero" data-selcount>Seçim yok</span>
            ${can("draft") ? html`<button class="${lead("draft")}" formaction="/artists/draft" data-needs-selection data-busy="Sıraya alınıyor">Taslak oluştur</button>` : ""}
            ${can("preview") ? html`<button class="${lead("preview")}" formaction="/artists/open-previews" data-needs-selection data-busy="Açılıyor">Önizlemeleri aç</button>` : ""}
            ${can("discover") ? html`<button class="${lead("discover")}" formaction="/artists/discover" data-needs-selection data-busy="Sıraya alınıyor">🔗 Bağlantıları tara</button>` : ""}
            ${can("dm") ? html`<button class="${lead("dm")}" formaction="/artists/prepare-dm" data-needs-selection data-busy="Claude mesajları yazıyor">Mesaj hazırla</button>` : ""}
            <span style="margin-left:auto"></span>
            <button class="subtle" formaction="/artists/sync" data-busy="Yenileniyor">↻ Artelivo'dan durumları yenile</button>
          </div>
          ${shown.length
            ? html`<table>
                <thead><tr><th style="width:36px"><input type="checkbox" data-check-all aria-label="Hepsini seç" /></th><th>Sanatçı</th><th>Durum</th><th>Yolculuk</th><th></th></tr></thead>
                <tbody>
                ${shown.map((a) => {
                  const st = stageOf(a.stage);
                  const { warn, audit, notes } = reportNotes(a.report);
                  return html`<tr>
                    <td><input type="checkbox" name="ids" value="${a.id}" /></td>
                    <td class="person">
                      <b>${a.name}</b>
                      <span class="muted small"><a href="${a.source_url}" target="_blank">Saatchi</a> · <a href="${a.instagram_url}" target="_blank">${handleOf(a.instagram_url)}</a>${a.category ? ` · ${categoryLabel(a.source, a.category)}` : ""}</span>
                      ${linksView(a)}
                    </td>
                    <td>
                      ${badge(st.label, st.tone)}
                      ${a.error ? html`<div class="note bad">${a.error}</div>` : ""}
                      ${warn ? html`<div class="note warn">${warn}</div>` : ""}
                      ${auditView(`audit-${a.id}`, audit, notes)}
                    </td>
                    <td>${steps(STEP_LABELS, st.step, st.state ?? "idle")}</td>
                    <td class="nowrap" style="text-align:right">
                      ${a.review_url ? html`<a class="btn subtle" href="${a.review_url}" target="_blank">Önizleme ↗</a>` : ""}
                      ${a.invite_id ? html`<a class="btn subtle" href="/artists/${a.id}/edit">Düzenle</a>` : ""}
                      <button class="danger" formaction="/artists/${a.id}/delete" data-busy="Siliniyor"
                        onclick="return confirm('${a.invite_id ? "Artelivo'daki taslak ve bu kayıt silinsin mi?" : "Kayıt silinsin mi?"}')">Sil</button>
                    </td>
                  </tr>`;
                })}
                </tbody>
              </table>`
            : rows.length
              ? emptyState("Bu sekmede kimse yok", "Diğer sekmelere bak.")
              : emptyState("Henüz onaylanan sanatçı yok", html`Turlar'da bir turu <b>Onaya başla</b> ile aç.`)}
        </form>
        ${Object.keys(closed).length
          ? html`<p class="muted small">Kapanan davetler (kişisel verileri silindi): ${Object.entries(closed)
              .map(([k, n]) => `${n} ${closedLabel[k] ?? k}`)
              .join(" · ")}</p>`
          : ""}
      `,
    ),
  );
});

app.post("/artists/draft", async (c) => {
  let queued = 0;
  let skipped = 0;
  for (const id of ids(await c.req.parseBody({ all: true }))) {
    const a = one<{ stage: string; invite_id: string | null }>("SELECT stage, invite_id FROM artists WHERE id = ?", id);
    if (a && !a.invite_id && ["approved", "draft_failed", "ineligible"].includes(a.stage)) {
      setStage(id, "approved", { error: null });
      enqueue("draft", id);
      queued++;
    } else {
      skipped++;
    }
  }
  if (!queued) {
    return back(c, backPath(c, "/artists"), "Taslak oluşturulacak kimse yok", "Seçtiklerinin taslağı zaten var ya da hazırlanıyor.", "info");
  }
  return back(
    c,
    "/artists",
    `${queued} taslak sıraya alındı`,
    `Tek tek hazırlanır (kişi başı ~3 dk); üstteki şeritte izle.${skipped ? ` ${skipped} kişinin taslağı zaten vardı.` : ""}`,
  );
});

app.post("/artists/discover", async (c) => {
  let n = 0;
  for (const id of ids(await c.req.parseBody({ all: true }))) {
    enqueue("discover", id);
    n++;
  }
  return back(
    c,
    backPath(c, "/artists"),
    n ? `${n} sanatçının bağlantıları taranacak` : "Seçim yok",
    n ? "Kişi başı en çok 15 sayfa; sonuç Bağlantılar kutusunda. Tarama bir şey göndermez; e-posta bulunursa Mesajlar'dan sen gönderirsin." : "",
    n ? "ok" : "info",
  );
});

app.post("/messages/:id/email", (c) => {
  const id = Number(c.req.param("id"));
  return queueEmail(id)
    ? back(c, backPath(c, "/messages"), `E-posta sıraya alındı: ${artistName(id)}`)
    : back(c, backPath(c, "/messages"), "E-posta sıraya alınamadı", "Adres yok ya da zaten gönderildi.", "warn");
});

app.post("/artists/open-previews", async (c) => {
  let opened = 0;
  for (const id of ids(await c.req.parseBody({ all: true }))) {
    const a = one<{ review_url: string | null }>("SELECT review_url FROM artists WHERE id = ?", id);
    // Önizleme yönetici oturumu ister: ana tarayıcında (Artelivo'ya girişli) açılır.
    if (a?.review_url) {
      openInDefaultBrowser(a.review_url);
      opened++;
    }
  }
  return opened
    ? back(c, backPath(c, "/artists"), `${opened} önizleme ana tarayıcında açıldı`, "Her birinde \"Onayla\"; buradaki durum kendiliğinden güncellenir.", "info")
    : back(c, backPath(c, "/artists"), "Açılacak önizleme yok", "Seçtiklerinin henüz taslağı yok.", "warn");
});

app.post("/artists/sync", async (c) => {
  try {
    await syncWithArtelivo();
    return back(c, backPath(c, "/artists"), "Durumlar güncellendi");
  } catch (e) {
    logEvent("sync_failed", String(e));
    return back(c, backPath(c, "/artists"), "Artelivo'ya ulaşılamadı", String(e).slice(0, 200), "bad");
  }
});

// Hatalar kişinin kendi satırına (artists.error) yazılır, olay günlüğüne değil:
// kayıt silinince hata da gider, günlükte ad birikmez.
const setArtistError = (id: number, message: string) =>
  db.prepare("UPDATE artists SET error = ? WHERE id = ?").run(message, id);

app.post("/artists/prepare-dm", async (c) => {
  await syncWithArtelivo().catch(() => {});
  let failed = 0;
  let ok = 0;
  for (const id of ids(await c.req.parseBody({ all: true }))) {
    const a = one<{ stage: string }>("SELECT stage FROM artists WHERE id = ?", id);
    if (!a) continue;
    if (!["preview_approved", "dm_ready"].includes(a.stage)) {
      setArtistError(id, "Mesaj hazırlanmadı: önizleme henüz onaylanmadı.");
      failed++;
      continue;
    }
    try {
      await prepareDm(id);
      ok++;
    } catch (e) {
      setArtistError(id, `Mesaj hazırlanamadı: ${e instanceof Error ? e.message : e}`);
      failed++;
    }
  }
  if (failed && !ok)
    return back(c, backPath(c, "/artists"), "Mesaj hazırlanamadı", `${failed} kişi — satırlardaki nota bak (önizleme onaylı olmalı).`, "bad");
  return back(
    c,
    "/messages",
    `${ok} mesaj hazır`,
    failed ? `${failed} kişininki hazırlanamadı (Sanatçılar'da notu var). Okuyup gönder.` : "Okuyup istersen düzelt, sonra gönder.",
    failed ? "warn" : "ok",
  );
});

app.post("/artists/:id/delete", async (c) => {
  const id = Number(c.req.param("id"));
  const a = one<{ invite_id: string | null; name: string; source: string; source_url: string }>(
    "SELECT invite_id, name, source, source_url FROM artists WHERE id = ?",
    id,
  );
  if (!a) return c.redirect("/artists");
  const dm = one<{ status: string }>("SELECT status FROM dm_messages WHERE artist_id = ?", id);
  if (dm?.status === "sending") {
    return back(c, backPath(c, "/artists"), `Şu an mesajı gönderiliyor: ${a.name}`, "Gönderim bitince sil.", "warn");
  }
  // DM gitti (ya da gitmiş olabilir): link sanatçıda — davete dokunulmaz.
  const delivered = Boolean(dm && ["sent", "unverified"].includes(dm.status));
  // Sırada bekleyen DM'i iptal et: silinen kişiye mesaj gitmesin.
  db.prepare("UPDATE jobs SET status = 'cancelled' WHERE kind = 'dm' AND ref_id = ? AND status = 'queued'").run(id);

  let remote: "none" | "deleted" | "kept" = "none";
  if (a.invite_id) {
    try {
      await artelivo.remove(a.invite_id);
      remote = "deleted";
    } catch (error) {
      if (error instanceof ArtelivoError && error.status === 404) {
        remote = "deleted"; // zaten yok
      } else if (error instanceof ArtelivoError && error.code === "ALREADY_SENT") {
        // INVITED: "Mesaj hazırla" linki aldı. DM gitmediyse davet geri
        // çekilir (link anahtarıyla) — Artelivo'da sahipsiz kalmasın ve süre
        // dolunca kişi "cevap vermedi" diye listeye girmesin (2026-10-19).
        if (delivered) {
          remote = "kept";
        } else {
          try {
            await artelivo.withdraw(a.invite_id);
            remote = "deleted";
          } catch (withdrawError) {
            if (withdrawError instanceof ArtelivoError && withdrawError.status === 404 && withdrawError.code === "NOT_FOUND") {
              remote = "deleted";
            } else {
              return back(c, backPath(c, "/artists"), `Silinemedi: ${a.name}`, `Artelivo'daki davet geri çekilemedi: ${String(withdrawError).slice(0, 200)}`, "bad");
            }
          }
        }
      } else {
        return back(c, backPath(c, "/artists"), `Silinemedi: ${a.name}`, String(error).slice(0, 200), "bad");
      }
    }
  }
  db.transaction(() => {
    // Elle silinen kişi sonraki taramalarda yeniden aday olmasın.
    markSeen(a.source, a.source_url, "deleted_by_admin");
    db.prepare("DELETE FROM dm_messages WHERE artist_id = ?").run(id);
    db.prepare("DELETE FROM artists WHERE id = ?").run(id);
  })();
  return back(
    c,
    "/artists",
    `Silindi: ${a.name}`,
    remote === "deleted"
      ? "Artelivo'daki taslak/davet de silindi."
      : remote === "kept"
        ? "Mesaj gitmişti: davet sanatçıda kalır (isterse kendisi siler; yoksa 30 gün sonra düşer)."
        : "",
    remote === "kept" ? "warn" : "info",
  );
});

app.get("/artists/:id/edit", async (c) => {
  const id = Number(c.req.param("id"));
  const a = one<Artist>("SELECT * FROM artists WHERE id = ?", id);
  if (!a?.invite_id) return c.redirect("/artists");
  const record = await artelivo.get(a.invite_id).catch((e: unknown) => ({ error: String(e) }));
  const example = JSON.stringify(
    { bio: "…", content: { avatarImageUrl: "https://… ya da upload:<id> ya da draft:<key>" } },
    null,
    2,
  );
  return c.html(
    page(
      `${a.name} — düzenle`,
      "/artists",
      html`
        ${pageHeader(
          a.name,
          html`Taslağı düzenle. Gönderdiğin alanlar değişir, göndermediklerin kalır; bir bölüm (works, exhibitions…) gönderilirse <b>bütünüyle</b> değişir. Var olan görseli korumak için <code>draft:&lt;key&gt;</code>.`,
          html`<a class="btn secondary" href="/artists">← Sanatçılar</a>`,
        )}
        <form method="post" class="card">
          <h2>Değişiklik (JSON)</h2>
          <textarea name="patch" style="min-height:220px;font:12px ui-monospace,Menlo,monospace">${example}</textarea>
          <div class="row" style="margin-top:10px"><button class="primary" data-busy="Kaydediliyor">Kaydet</button><a class="btn secondary" href="/artists">Vazgeç</a></div>
        </form>
        <div class="card">
          <h2>Şu anki taslak</h2>
          <pre style="white-space:pre-wrap;font:12px ui-monospace,Menlo,monospace;margin:0">${JSON.stringify(record, null, 2)}</pre>
        </div>
      `,
    ),
  );
});

app.post("/artists/:id/edit", async (c) => {
  const id = Number(c.req.param("id"));
  const a = one<Artist>("SELECT * FROM artists WHERE id = ?", id);
  if (!a?.invite_id) return c.redirect("/artists");
  const body = await c.req.parseBody();
  try {
    const patch = JSON.parse(String(body["patch"] ?? "{}")) as unknown;
    const out = await artelivo.patch(a.invite_id, patch);
    setStage(id, "drafted", { report: JSON.stringify({ report: out.report }), error: null });
    return back(c, "/artists", `Taslak güncellendi: ${a.name}`, "Önizlemeyi yeniden onaylaman gerekir.");
  } catch (error) {
    return back(c, `/artists/${id}/edit`, "Kaydedilemedi", String(error).slice(0, 300), "bad");
  }
});

// ─── Mesajlar ───────────────────────────────────────────────────────────────

const DM_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Gönderilmedi", tone: "neutral" },
  waiting: { label: "Sırada", tone: "progress" },
  sending: { label: "Gönderiliyor", tone: "progress" },
  sent: { label: "Gönderildi", tone: "ok" },
  failed: { label: "Hata", tone: "bad" },
  unverified: { label: "Doğrulanamadı — gitmiş olabilir", tone: "warn" },
};

/** Mesaj kartında davet e-postasının durumu (adres keşifte bulunduysa). */
function emailLine(m: {
  artist_id: number;
  status: string;
  name: string;
  contacts: string | null;
  email_to: string | null;
  email_status: string | null;
  email_error: string | null;
  email_sent_at: string | null;
}) {
  // Gidecek adres yalnız güvenilir olanlardan seçilir (queueEmail ile aynı kural).
  const best = bestEmail(readContacts(m.contacts, m.name));
  if (!m.email_to && !best) return "";
  const st = m.email_status ? (DM_STATUS[m.email_status] ?? { label: m.email_status, tone: "neutral" as Tone }) : null;
  const canSend = best && !["sent", "sending", "waiting", "unverified"].includes(m.email_status ?? "");
  return html`<div class="row small">
    <span>✉ E-posta: <b>${m.email_to ?? best?.value ?? ""}</b></span>
    ${st ? badge(st.label, st.tone) : m.status === "draft" ? html`<span class="muted">mesajla birlikte gider</span>` : ""}
    ${m.email_sent_at ? html`<span class="muted">${m.email_sent_at}</span>` : ""}
    ${canSend && (m.email_status || m.status !== "draft") ? html`<button class="subtle" form="email_${m.artist_id}" data-busy="Sıraya alınıyor">E-postayı gönder</button>` : ""}
  </div>
  ${m.email_error ? html`<div class="note ${m.email_status === "failed" ? "bad" : "warn"}">${m.email_error}</div>` : ""}`;
}

app.get("/messages", (c) => {
  const rows = db
    .prepare(
      `SELECT m.*, a.name, a.instagram_url, a.stage, a.dm_lang, a.contacts,
              e.to_addr AS email_to, e.status AS email_status, e.error AS email_error, e.sent_at AS email_sent_at
         FROM dm_messages m JOIN artists a ON a.id = m.artist_id
         LEFT JOIN email_messages e ON e.artist_id = m.artist_id
        ORDER BY m.created_at DESC`,
    )
    .all() as Array<{
    artist_id: number;
    text: string;
    status: string;
    error: string | null;
    sent_at: string | null;
    name: string;
    instagram_url: string;
    dm_lang: string | null;
    via: string | null;
    contacts: string | null;
    email_to: string | null;
    email_status: string | null;
    email_error: string | null;
    email_sent_at: string | null;
  }>;
  const s = getSettings();
  const today = countToday("ig_dm");
  // Sekmeler (kullanıcı, 2026-10-20): gönderilmeyen / gönderilen.
  const unsent = rows.filter((m) => m.status !== "sent");
  const sent = rows.filter((m) => m.status === "sent");
  const tabKey = c.req.query("tab") === "gonderilen" ? "gonderilen" : "gonderilmeyen";
  const shown = tabKey === "gonderilen" ? sent : unsent;
  return c.html(
    page(
      "Mesajlar",
      "/messages",
      html`
        ${pageHeader(
          "Instagram mesajları",
          html`Her mesaj kişiye özel; davet linki mesajın içinde (hazırlanırken alındı, 30 gün geçerli). Bugün ${today}/${s.igDmPerDay} DM.`,
        )}
        ${queueState.paused
          ? html`<div class="callout warn"><b>Kuyruk durduruldu.</b> Gönderilen mesajlar sırada bekler — İşler'den sürdür.</div>`
          : ""}
        ${tabBar("/messages", [
          { key: "gonderilmeyen", label: "Gönderilmeyen", count: unsent.length },
          { key: "gonderilen", label: "Gönderilen", count: sent.length },
        ], tabKey)}
        <form method="post" action="/messages/send" class="card flush">
          <div class="selbar" ${tabKey === "gonderilen" ? raw('style="display:none"') : ""}>
            <label class="row"><input type="checkbox" data-check-all /> <span class="selcount zero" data-selcount>Seçim yok</span></label>
            <button class="primary" data-needs-selection data-busy="Sıraya alınıyor">Seçilileri gönder</button>
            <span class="muted small">Mesajlar sırayla, aralarında ${s.igDmDelayMin}–${s.igDmDelayMax} sn beklenerek gider.</span>
          </div>
          ${shown.length
            ? html`<div style="padding:16px;display:grid;gap:14px">
              ${shown.map((m) => {
                const st = DM_STATUS[m.status] ?? { label: m.status, tone: "neutral" as Tone };
                const locked = ["sent", "unverified", "sending", "waiting"].includes(m.status);
                return html`<div class="card msg" style="margin:0">
                  <div class="msg-head">
                    <label class="row">
                      <input type="checkbox" name="ids" value="${m.artist_id}" ${locked ? raw("disabled") : ""} />
                      <b>${m.name}</b> <a class="muted" href="${m.instagram_url}" target="_blank">${handleOf(m.instagram_url)}</a>
                    </label>
                    <span>${badge(m.dm_lang === "en" ? "İngilizce" : "Türkçe", "neutral")} ${badge(st.label, st.tone)}${m.via === "threads" ? html` ${badge("Threads'ten", "info")}` : ""}${m.sent_at ? html` <span class="muted small">${m.sent_at}</span>` : ""}</span>
                  </div>
                  ${m.error ? html`<div class="note bad">${m.error}</div>` : ""}
                  ${emailLine(m)}
                  ${(() => {
                    const parts = splitForDm(m.text);
                    return html`<div class="muted small">${m.text.length} karakter · Instagram'a ${parts.length} mesaj olarak gider (${parts.map((p) => p.length).join(" + ")}; her biri en çok ${DM_MAX})</div>`;
                  })()}
                  <textarea name="text_${m.artist_id}" form="save_${m.artist_id}" ${locked ? raw("readonly") : ""}>${m.text}</textarea>
                  ${m.status === "waiting"
                    ? html`<div class="row"><span class="muted small">Sırada — gitmeden düzenlemek için önce sıradan çıkar.</span>
                        <button class="secondary" form="unqueue_${m.artist_id}" data-busy="Çıkarılıyor">Sıradan çıkar</button></div>`
                    : ""}
                  ${m.status === "unverified"
                    ? html`<div class="row"><span class="note warn">Önce Instagram'da sohbete bak.</span>
                        <button class="secondary" form="confirm_${m.artist_id}" data-busy="Kaydediliyor">Gönderildi say</button>
                        <button class="danger" form="resend_${m.artist_id}" onclick="return confirm('Aynı kişiye ikinci bir mesaj gidebilir. Emin misin?')">Yine de tekrar gönder</button></div>`
                    : ""}
                  ${locked
                    ? ""
                    : html`<div class="row">
                        <button class="secondary" form="save_${m.artist_id}" data-busy="Kaydediliyor">Kaydet</button>
                        <button class="subtle" form="rewrite_${m.artist_id}" data-busy="Claude yeniden yazıyor">↻ Yeniden yaz</button>
                        <button class="subtle" form="lang_${m.artist_id}" data-busy="Claude yeniden yazıyor">${m.dm_lang === "en" ? "Türkçe yaz" : "İngilizce yaz"}</button>
                        <span style="margin-left:auto"></span>
                        <button class="danger" form="delete_${m.artist_id}" data-busy="Siliniyor"
                          onclick="return confirm('Mesaj silinsin mi? Sanatçı Sanatçılar sayfasında kalır; yeniden mesaj hazırlanabilir.')">Mesajı sil</button>
                      </div>`}
                </div>`;
              })}
            </div>`
            : tabKey === "gonderilen"
              ? emptyState("Henüz gönderilen mesaj yok", "")
              : emptyState("Gönderilecek mesaj yok", html`Sanatçılar › <b>Bağlantısı taranan</b> sekmesinde seçip <b>Mesaj hazırla</b>.`)}
        </form>
        ${rows.map(
          (m) => html`<form id="save_${m.artist_id}" method="post" action="/messages/${m.artist_id}/save"></form>
            <form id="rewrite_${m.artist_id}" method="post" action="/messages/${m.artist_id}/rewrite"></form>
            <form id="lang_${m.artist_id}" method="post" action="/messages/${m.artist_id}/lang"></form>
            <form id="confirm_${m.artist_id}" method="post" action="/messages/${m.artist_id}/confirm-sent"></form>
            <form id="resend_${m.artist_id}" method="post" action="/messages/${m.artist_id}/resend"></form>
            <form id="unqueue_${m.artist_id}" method="post" action="/messages/${m.artist_id}/unqueue"></form>
            <form id="delete_${m.artist_id}" method="post" action="/messages/${m.artist_id}/delete"></form>
            <form id="email_${m.artist_id}" method="post" action="/messages/${m.artist_id}/email"></form>`,
        )}
      `,
    ),
  );
});

app.post("/messages/:id/save", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.parseBody();
  const text = String(body[`text_${id}`] ?? "").trim();
  if (text) {
    db.prepare(
      "UPDATE dm_messages SET text = ?, updated_at = datetime('now') WHERE artist_id = ? AND status != 'sent'",
    ).run(text, id);
  }
  return back(c, backPath(c, "/messages"), `Kaydedildi: ${artistName(id)}`);
});

// "Doğrulanamadı" mesajlar: sen sohbete bakıp karar verirsin.
app.post("/messages/:id/confirm-sent", (c) => {
  const id = Number(c.req.param("id"));
  db.prepare(
    "UPDATE dm_messages SET status = 'sent', sent_at = COALESCE(sent_at, datetime('now')), error = NULL WHERE artist_id = ? AND status = 'unverified'",
  ).run(id);
  setStage(id, "dm_sent", { error: null });
  return back(c, backPath(c, "/messages"), `Gönderildi olarak işaretlendi: ${artistName(id)}`);
});
app.post("/messages/:id/resend", (c) => {
  const id = Number(c.req.param("id"));
  db.prepare(
    "UPDATE dm_messages SET status = 'waiting', error = NULL WHERE artist_id = ? AND status = 'unverified'",
  ).run(id);
  enqueue("dm", id);
  return back(c, backPath(c, "/messages"), `Yeniden sıraya alındı: ${artistName(id)}`, "", "warn");
});

// Sıradaki (henüz gitmemiş) mesajı geri al: düzenlenebilir olur.
app.post("/messages/:id/unqueue", (c) => {
  const id = Number(c.req.param("id"));
  if (["dm", "threads", "email"].includes(queueState.current?.kind ?? "") && queueState.current?.ref_id === id) {
    return back(c, backPath(c, "/messages"), "Şu an gönderiliyor", "Geri alınamaz; bitmesini bekle.", "warn");
  }
  // Davet e-postası da geri çekilir: mesajla birlikte sıraya girmişti.
  db.prepare("UPDATE jobs SET status = 'cancelled' WHERE kind IN ('dm','threads','email') AND ref_id = ? AND status = 'queued'").run(id);
  db.prepare("UPDATE dm_messages SET status = 'draft', error = NULL WHERE artist_id = ? AND status = 'waiting'").run(id);
  db.prepare("DELETE FROM email_messages WHERE artist_id = ? AND status = 'waiting'").run(id);
  return back(c, backPath(c, "/messages"), `Sıradan çıkarıldı: ${artistName(id)}`, "Düzenleyip yeniden gönderebilirsin.", "info");
});

// Gönderilmemiş mesaj silinir (kullanıcı, 2026-10-23); sanatçı mesaj öncesi
// aşamaya döner. Sıradaki önce sıradan çıkarılır, gitmiş/gidiyor olan silinmez.
app.post("/messages/:id/delete", (c) => {
  const id = Number(c.req.param("id"));
  const res = db.prepare("DELETE FROM dm_messages WHERE artist_id = ? AND status IN ('draft','failed')").run(id);
  if (!res.changes) {
    return back(c, backPath(c, "/messages"), "Silinemedi", "Mesaj sırada ya da gönderilmiş; sıradakini önce sıradan çıkar.", "warn");
  }
  db.prepare("UPDATE jobs SET status = 'cancelled' WHERE kind IN ('dm','threads','email') AND ref_id = ? AND status = 'queued'").run(id);
  db.prepare("DELETE FROM email_messages WHERE artist_id = ? AND status NOT IN ('sent','sending','unverified')").run(id);
  db.prepare("UPDATE artists SET stage = 'preview_approved' WHERE id = ? AND stage = 'dm_ready'").run(id);
  return back(c, backPath(c, "/messages"), `Mesaj silindi: ${artistName(id)}`, "Sanatçılar › Bağlantısı taranan/taranmayan sekmesinde.", "info");
});

// Mesaj dili elle değişir (Türkiye'de yaşayan yabancı, yurt dışındaki Türk):
// dil satıra yazılır, mesaj o dilde yeniden yazılır; olmazsa eski dile döner.
app.post("/messages/:id/lang", async (c) => {
  const id = Number(c.req.param("id"));
  const before = one<{ dm_lang: string | null }>("SELECT dm_lang FROM artists WHERE id = ?", id)?.dm_lang ?? null;
  const next = before === "en" ? "tr" : "en";
  db.prepare("UPDATE artists SET dm_lang = ? WHERE id = ?").run(next, id);
  try {
    await prepareDm(id);
    return back(c, backPath(c, "/messages"), `${next === "en" ? "İngilizce" : "Türkçe"} yazıldı: ${artistName(id)}`);
  } catch (e) {
    db.prepare("UPDATE artists SET dm_lang = ? WHERE id = ?").run(before, id);
    return back(c, backPath(c, "/messages"), "Yeniden yazılamadı", e instanceof Error ? e.message : String(e), "bad");
  }
});
app.post("/messages/:id/rewrite", async (c) => {
  const id = Number(c.req.param("id"));
  try {
    await prepareDm(id);
    return back(c, backPath(c, "/messages"), `Yeniden yazıldı: ${artistName(id)}`);
  } catch (e) {
    return back(c, backPath(c, "/messages"), "Yeniden yazılamadı", e instanceof Error ? e.message : String(e), "bad");
  }
});

app.post("/messages/send", async (c) => {
  let n = 0;
  let mails = 0;
  for (const id of ids(await c.req.parseBody({ all: true }))) {
    db.prepare(
      "UPDATE dm_messages SET status = 'waiting', error = NULL WHERE artist_id = ? AND status IN ('draft','failed')",
    ).run(id);
    enqueue("dm", id);
    // E-posta bulunduysa davet e-postası da (kullanıcı, 2026-10-23).
    if (queueEmail(id)) mails++;
    n++;
  }
  if (!n) return back(c, backPath(c, "/messages"), "Seçili mesaj yok", "", "info");
  return back(
    c,
    "/messages",
    `${n} mesaj sıraya alındı${mails ? ` · ${mails} e-posta` : ""}`,
    queueState.paused ? "Kuyruk durduruldu — İşler'den sürdürünce gider." : "Sırayla gidecek; her biri bitince haber veririm.",
    queueState.paused ? "warn" : "ok",
  );
});

// ─── Davet sonuçları ────────────────────────────────────────────────────────

/**
 * Kim profilini aldı, kim sildi, kim henüz karar vermedi (kullanıcı, 2026-10-23).
 * Kapananlar `invite_outcomes`'tan; o tablodan önce kapananların adı yok, yalnız sayısı.
 */
app.get("/outcomes", async (c) => {
  let syncError = "";
  if (config.artelivo.agentKey) {
    await syncWithArtelivo().catch((e: unknown) => {
      syncError = String(e).slice(0, 200);
    });
  }
  type Row = { name: string; instagram_url: string | null; source_url: string | null; sent_at: string | null; at: string };
  const closedRows = (outcome: string) =>
    db
      .prepare(
        `SELECT name, instagram_url, source_url, sent_at, closed_at AS at
         FROM invite_outcomes WHERE outcome = ? ORDER BY closed_at DESC`,
      )
      .all(outcome) as Row[];
  const pending = db
    .prepare(
      `SELECT a.name, a.instagram_url, a.source_url, COALESCE(m.sent_at, e.sent_at) AS sent_at,
              COALESCE(m.sent_at, e.sent_at, a.updated_at) AS at
       FROM artists a
       LEFT JOIN dm_messages m ON m.artist_id = a.id
       LEFT JOIN email_messages e ON e.artist_id = a.id
       WHERE a.stage = 'dm_sent' ORDER BY at ASC`,
    )
    .all() as Row[];
  const closed = closedCounts();

  const section = (title: string, hint: string, tone: Tone, rows: Row[], outcome: string | null, atLabel: string) => {
    const unnamed = outcome ? Math.max(0, (closed[outcome] ?? 0) - rows.length) : 0;
    return html`<div class="card flush">
      <div style="padding:14px 14px 0"><h2>${title} ${badge(String(rows.length + unnamed), tone)}</h2><p class="muted small">${hint}</p></div>
      ${rows.length
        ? html`<table>
            <thead><tr><th>Sanatçı</th><th>Mesaj gitti</th><th>${atLabel}</th></tr></thead>
            <tbody>
            ${rows.map(
              (r) => html`<tr>
                <td><b>${r.name}</b>
                  <div class="muted small">${r.instagram_url ? html`<a href="${r.instagram_url}" target="_blank">${handleOf(r.instagram_url)}</a>` : ""}${r.instagram_url && r.source_url ? " · " : ""}${r.source_url ? html`<a href="${r.source_url}" target="_blank">Kaynak</a>` : ""}</div></td>
                <td class="muted small nowrap">${r.sent_at ?? "—"}</td>
                <td class="muted small nowrap">${r.at}</td>
              </tr>`,
            )}
            </tbody>
          </table>`
        : unnamed
          ? ""
          : html`<p class="muted small" style="padding:0 14px 14px">Henüz kimse yok.</p>`}
      ${unnamed
        ? html`<p class="muted small" style="padding:0 14px 14px">+ ${unnamed} kişi daha — bu sayfadan önce kapandığı için adı tutulmadı.</p>`
        : ""}
    </div>`;
  };

  return c.html(
    page(
      "Davet sonuçları",
      "/outcomes",
      html`
        ${pageHeader("Davet sonuçları", "Mesajı giden sanatçılar profil taslağına ne yaptı. Sayfa açılırken Artelivo'dan güncellenir.")}
        ${syncError ? html`<div class="callout warn"><div><b>Artelivo'ya ulaşılamadı</b> — son bilinen durum gösteriliyor. ${syncError}</div></div>` : ""}
        ${section("Onayladı", "Profilini aldı; artık Artelivo'da.", "ok", closedRows("claimed"), "claimed", "Aldığı an")}
        ${section("Sildi", "Taslağı istemedi; Artelivo'dan silindi.", "bad", closedRows("declined"), "declined", "Sildiği an")}
        ${section("Beklemede", "Mesajı gitti, henüz karar vermedi (en eski önce).", "info", pending, null, "Bekliyor (başlangıç)")}
      `,
    ),
  );
});

// ─── İşler ──────────────────────────────────────────────────────────────────

const JOB_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: "Sırada", tone: "neutral" },
  running: { label: "Çalışıyor", tone: "progress" },
  done: { label: "Bitti", tone: "ok" },
  failed: { label: "Hata", tone: "bad" },
  cancelled: { label: "İptal", tone: "neutral" },
};

const EVENT_LABEL: Record<string, string> = {
  collect_done: "Tarama bitti",
  draft_created: "Taslak oluşturuldu",
  draft_adopted: "Var olan taslak bağlandı",
  ig_dm: "Instagram mesajı denendi",
  ig_blocked: "Instagram engel gösterdi",
  invite_closed: "Davet kapandı",
  job_done: "İş bitti",
  job_failed: "İş başarısız",
  job_deferred: "İş ertelendi",
  review_approved: "Aday onaylandı",
  review_rejected: "Aday reddedildi",
  review_empty: "Onaylanacak aday yok",
  review_failed: "Onay penceresi açılamadı",
  review_step: "Onay penceresi",
  ig_search_box_failed: "Instagram araması yazılamadı",
  image_upload_failed: "Görsel yüklenemedi",
  profile_unreadable: "Profil okunamadı",
  sync_failed: "Durum yenilenemedi",
  discover_done: "Bağlantılar tarandı",
  facebook_login_needed: "Facebook giriş istedi (keşif)",
  ig_profile_visit: "Instagram profili okundu (keşif)",
  ig_profile_visit_skipped: "Instagram profili okunmadı — günlük sınır (keşif)",
  email_sent: "Davet e-postası gönderildi",
};

/**
 * Sanatçının tüm bağlantıları tek açılır kutuda: kaynak, Instagram, önizleme,
 * keşifte bulunan e-postalar ve linkler (nerede bulundukları ile).
 */
function linksView(a: {
  id: number;
  name: string;
  source: string;
  source_url: string;
  instagram_url: string;
  review_url: string | null;
  contacts: string | null;
}) {
  const c = readContacts(a.contacts, a.name);
  const bare = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "").replace(/\/$/, "");
  const fixed: Array<{ label: string; href: string; text: string }> = [
    { label: sourceOf(a.source).label, href: a.source_url, text: bare(a.source_url) },
    { label: "Instagram", href: a.instagram_url, text: handleOf(a.instagram_url) },
    ...(a.review_url ? [{ label: "Önizleme", href: a.review_url, text: "Taslağı aç" }] : []),
  ];
  // Zaten bilinen kaynak profili ve Instagram tekrar listelenmez (sorgu parametresi farkı sayılmaz).
  const known = new Set([a.source_url, a.instagram_url].map((u) => urlKey(u).replace(/\?.*$/, "")));
  const links = c.links.filter((l) => !known.has(urlKey(l.url).replace(/\?.*$/, "")));
  const row = (label: string, value: Raw | string, from = "") =>
    html`<li><b>${label}</b><div>${value}${from ? html`<small>${from}</small>` : ""}</div></li>`;
  const total = fixed.length + c.emails.length + links.length;
  const state = c.discoveredAt
    ? `${c.emails.length} e-posta`
    : "taranmadı";
  return html`<details class="audit links" data-key="links-${a.id}">
    <summary>🔗 Bağlantılar (${total}) <span class="muted">· ${state}</span></summary>
    <ul>
      ${fixed.map((r) => row(r.label, html`<a href="${r.href}" target="_blank" title="${r.href}">${r.text}</a>`))}
      ${c.emails.map((e) =>
        row(
          "E-posta",
          html`<a href="mailto:${e.value}">${e.value}</a>`,
          `${e.from}${trustedEmail(e) ? (e.nameMatch ? "" : " · adla eşleşmiyor") : " · davet gönderilmez (sanatçıya ait olduğu belli değil)"}`,
        ),
      )}
      ${c.phones.map((p) => {
        // wa.me uluslararası numara ister: 0 ile başlayan 11 hane Türkiye sayılır.
        const d = p.value.replace(/\D/g, "");
        const wa = p.value.startsWith("+") ? d : d.length === 11 && d.startsWith("0") ? `90${d.slice(1)}` : null;
        return row(
          "Telefon",
          html`<a href="tel:${p.value}">${p.value}</a>${wa ? html` · <a href="https://wa.me/${wa}" target="_blank">WhatsApp</a>` : ""}`,
          p.from,
        );
      })}
      ${links.map((l) => row(l.label, html`<a href="${l.url}" target="_blank" title="${l.url}">${bare(l.url)}</a>`, l.from))}
      <li class="foot">${c.discoveredAt ? `Son tarama: ${c.discoveredAt.slice(0, 16).replace("T", " ")} UTC · ${c.pages} sayfa açıldı` : "Henüz taranmadı — seçip “Bağlantıları tara”."}</li>
    </ul>
  </details>`;
}

function jobSubject(j: Job) {
  if (j.kind === "dm" || j.kind === "threads") {
    // Gitmeyen mesajı elle kontrol etmek için profil linki (kullanıcı, 2026-10-21).
    const a = one<{ name: string; instagram_url: string }>(
      "SELECT name, instagram_url FROM artists WHERE id = ?",
      j.ref_id,
    );
    if (a) {
      return html`${a.name} <a class="muted small" href="${a.instagram_url}" target="_blank">${handleOf(a.instagram_url)}</a>`;
    }
  }
  if (j.kind === "email") {
    const to = one<{ to_addr: string }>("SELECT to_addr FROM email_messages WHERE artist_id = ?", j.ref_id)?.to_addr;
    return html`${artistName(j.ref_id)}${to ? html` <span class="muted small">${to}</span>` : ""}`;
  }
  if (["draft", "dm", "discover"].includes(j.kind)) return artistName(j.ref_id);
  if (j.kind === "collect" || j.kind === "igsearch") return `Tur #${j.ref_id}`;
  return "";
}

app.get("/jobs", (c) => {
  const jobs = db.prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT 100").all() as Array<
    Job & { updated_at: string }
  >;
  const events = db
    .prepare("SELECT * FROM events WHERE kind != 'review_step' ORDER BY id DESC LIMIT 60")
    .all() as Array<{ kind: string; detail: string | null; at: string }>;
  return c.html(
    page(
      "İşler",
      "/jobs",
      html`
        ${pageHeader(
          "İşler",
          "Tüm arka plan işleri tek sırada, tek tek çalışır.",
          html`<form method="post" action="/queue/${queueState.paused ? "resume" : "pause"}" class="inline">
            <button class="${queueState.paused ? "primary" : "secondary"}" data-busy="…">${queueState.paused ? "▶ Kuyruğu sürdür" : "⏸ Kuyruğu durdur"}</button>
          </form>`,
        )}
        ${queueState.paused
          ? html`<div class="callout warn"><div><b>Kuyruk durduruldu.</b> Sıradaki işler (taramalar dahil) bekliyor.
              ${queuedDms()
                ? html` Sürdürünce sıradaki <b>${queuedDms()} DM</b> de gönderilmeye başlar. Instagram engeli yüzünden durduysa önce Instagram'ı elle açıp hesabın normal olduğuna bak.`
                : ""}</div></div>`
          : html`<p class="muted small" style="margin-top:-8px">Durdurmak çalışan işi yarıda kesmez; sıradakini başlatmaz.</p>`}
        <div class="card flush">
          ${jobs.length
            ? html`<table>
                <thead><tr><th>İş</th><th>Kim / ne</th><th>Durum</th><th>Son değişiklik</th><th></th></tr></thead>
                <tbody>
                ${jobs.map((j) => {
                  const st = JOB_STATUS[j.status] ?? { label: j.status, tone: "neutral" as Tone };
                  return html`<tr>
                    <td class="nowrap"><b>${JOB_LABEL[j.kind] ?? j.kind}</b><div class="muted small">#${j.id}</div></td>
                    <td>${jobSubject(j)}${j.error ? html`<div class="note bad">${j.error}</div>` : ""}</td>
                    <td>${badge(st.label, st.tone)}${j.not_before && j.status === "queued" ? html`<div class="muted small">${j.not_before} UTC'den sonra</div>` : ""}</td>
                    <td class="muted small nowrap">${j.updated_at}</td>
                    <td class="nowrap" style="text-align:right">
                      ${j.status === "failed"
                        ? html`<form method="post" action="/jobs/${j.id}/retry" class="inline"><button class="secondary" data-busy="Sıraya alınıyor">Tekrar dene</button></form>`
                        : ""}
                      ${["queued", "failed"].includes(j.status)
                        ? html`<form method="post" action="/jobs/${j.id}/cancel" class="inline"><button class="danger">İptal</button></form>`
                        : ""}
                    </td>
                  </tr>`;
                })}
                </tbody>
              </table>`
            : emptyState("Henüz iş yok", "Tur başlatınca, taslak ya da mesaj gönderince burada görünür.")}
        </div>
        <div class="card flush">
          <div style="padding:14px 14px 0"><h2>Olaylar</h2></div>
          <table><tbody>
            ${events.map(
              (e) => html`<tr>
                <td class="muted small nowrap">${e.at}</td>
                <td>${EVENT_LABEL[e.kind] ?? e.kind}</td>
                <td class="muted small">${e.detail ?? ""}</td>
              </tr>`,
            )}
          </tbody></table>
        </div>
      `,
    ),
  );
});
function queuedDms(): number {
  return countOf("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'dm' AND status = 'queued'");
}

// Yönetim penceresi uygulamanın Chrome'unda; oradaki dış linkler (önizleme:
// yönetici oturumu ANA tarayıcıda) ana tarayıcıda açılır.
app.post("/open-external", async (c) => {
  const body = await c.req.parseBody();
  const url = String(body["url"] ?? "");
  if (!/^https?:\/\//i.test(url)) return c.text("Geçersiz adres", 400);
  openInDefaultBrowser(url);
  return c.body(null, 204);
});

app.post("/queue/pause", (c) => {
  pauseQueue(true);
  return back(c, "/jobs", "Kuyruk durduruldu", "Çalışan iş biter, sıradaki başlamaz.", "warn");
});
app.post("/queue/resume", (c) => {
  pauseQueue(false);
  return back(c, "/jobs", "Kuyruk sürüyor");
});
app.post("/jobs/:id/retry", (c) => {
  retryJob(Number(c.req.param("id")));
  return back(c, "/jobs", "Yeniden sıraya alındı");
});
app.post("/jobs/:id/cancel", (c) => {
  cancelJob(Number(c.req.param("id")));
  return back(c, "/jobs", "İş iptal edildi", "", "info");
});

// ─── Ayarlar ────────────────────────────────────────────────────────────────

const SETTING_LABEL: Record<keyof typeof DEFAULT_SETTINGS, string> = {
  igDmPerDay: "Günde en fazla DM",
  igDmDelayMin: "DM'ler arası en az bekleme (sn)",
  igDmDelayMax: "DM'ler arası en çok bekleme (sn)",
  minWorks: "Kaynakta en az eser (yeni tur varsayılanı)",
  maxWorks: "Kaynakta en çok eser (yeni tur varsayılanı)",
  emailPerDay: "Günde en fazla davet e-postası",
  emailDelayMin: "E-postalar arası en az bekleme (sn)",
  emailDelayMax: "E-postalar arası en çok bekleme (sn)",
  testHandle: "Test DM'i için kendi Instagram kullanıcı adın",
};

/** "Bağlantıları dene" sonucu: son denemenin satırları (bellekte). */
let lastCheck: { at: string; lines: Array<{ ok: boolean; text: string }> } | null = null;

app.get("/settings", async (c) => {
  const s = getSettings();
  const missing = missingConfig();
  const usage = usageSummary();
  return c.html(
    page(
      "Ayarlar",
      "/settings",
      html`
        ${pageHeader("Ayarlar", html`Anahtarlar <code>.env</code> dosyasında · Artelivo: ${config.artelivo.apiUrl}`)}
        <div class="card">
          <h2>Bağlantılar</h2>
          ${missing.length
            ? html`<div class="callout bad"><b>Eksik:</b> ${missing.join(", ")}</div>`
            : html`<p class="muted small" style="margin-top:0">Tüm anahtarlar tanımlı.</p>`}
          ${lastCheck
            ? html`<ul class="checks" style="margin-bottom:14px">${lastCheck.lines.map(
                (l) => html`<li>${badge(l.ok ? "✓" : "✗", l.ok ? "ok" : "bad")} ${l.text}</li>`,
              )}</ul><p class="muted small">Son deneme: ${lastCheck.at}</p>`
            : ""}
          <div class="row">
            <form method="post" action="/settings/check" class="inline"><button class="primary" data-busy="Deneniyor">Bağlantıları dene</button></form>
            <form method="post" action="/settings/instagram-login" class="inline"><button class="secondary" data-busy="Açılıyor">Instagram'a giriş (bir kez)</button></form>
            <form method="post" action="/settings/facebook-login" class="inline"><button class="secondary" data-busy="Açılıyor">Facebook'a giriş (bir kez)</button></form>
            <form method="post" action="/settings/threads-login" class="inline"><button class="secondary" data-busy="Açılıyor">Threads'e giriş (bir kez)</button></form>
            <form method="post" action="/settings/test-dm" class="inline"><button class="secondary" data-busy="Gönderiliyor">Kendime test DM'i gönder</button></form>
          </div>
        </div>
        <form method="post" action="/settings" class="card">
          <h2>Hız ve kurallar</h2>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px">
            ${(Object.keys(DEFAULT_SETTINGS) as Array<keyof typeof DEFAULT_SETTINGS>).map(
              (key) => html`<label class="field">${SETTING_LABEL[key]}<input name="${key}" value="${s[key]}" /></label>`,
            )}
          </div>
          <button class="primary" style="margin-top:14px" data-busy="Kaydediliyor">Kaydet</button>
        </form>
        <div class="card flush">
          <div style="padding:14px 14px 0"><h2>Claude kullanımı</h2><p class="muted small" style="margin:0 0 6px">Claude Code (Max planı) · model: ${config.claudeModel} — ek ücret yok</p></div>
          ${usage.length
            ? html`<table><thead><tr><th>Amaç</th><th>Çağrı</th><th>Girdi token</th><th>Çıktı token</th></tr></thead><tbody>
                ${usage.map((u) => html`<tr><td>${u.purpose}</td><td>${u.calls}</td><td>${u.input}</td><td>${u.output}</td></tr>`)}
              </tbody></table>`
            : emptyState("Henüz kullanım yok", "")}
        </div>
      `,
    ),
  );
});

app.post("/settings", async (c) => {
  const body = await c.req.parseBody();
  saveSettings(Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)])));
  return back(c, "/settings", "Ayarlar kaydedildi");
});

/** İş çalışırken arka plan sekmesine dokunma: işi yarıda bozar. */
const busyRedirect = (c: Context) =>
  back(
    c,
    "/settings",
    "Şu an bir iş çalışıyor",
    "Tarayıcı onun. İşler → \"Kuyruğu durdur\", çalışan iş bitince tekrar dene.",
    "warn",
  );

app.post("/settings/instagram-login", async (c) => {
  if (queueState.current) return busyRedirect(c);
  await withBrowserForUi(async () => {
    const page = await workTab();
    await page.goto("https://www.instagram.com/accounts/login/");
    await page.bringToFront();
  });
  return back(c, "/settings", "Instagram giriş penceresi açıldı", "Orada giriş yap; oturum bu profilde kalır.", "info");
});

// Bağlantı keşfi Facebook sayfalarının iletişim bilgisini okur: giriş ister.
app.post("/settings/facebook-login", async (c) => {
  if (queueState.current) return busyRedirect(c);
  await withBrowserForUi(async () => {
    const page = await workTab();
    await page.goto("https://www.facebook.com/login");
    await page.bringToFront();
  });
  return back(c, "/settings", "Facebook giriş penceresi açıldı", "Orada giriş yap; oturum bu profilde kalır.", "info");
});

// Instagram'dan gitmeyen mesaj Threads'ten denenir: oturum bu profilde bir kez açılır.
app.post("/settings/threads-login", async (c) => {
  if (queueState.current) return busyRedirect(c);
  await withBrowserForUi(async () => {
    const page = await workTab();
    await page.goto("https://www.threads.com/login");
    await page.bringToFront();
  });
  return back(c, "/settings", "Threads giriş penceresi açıldı", "\"Instagram ile devam et\" ile gir; oturum bu profilde kalır.", "info");
});

app.post("/settings/check", async (c) => {
  if (queueState.current) return busyRedirect(c);
  const lines: Array<{ ok: boolean; text: string }> = [];
  try {
    await artelivo.ping();
    lines.push({ ok: true, text: "Artelivo ajan anahtarı" });
  } catch (e) {
    lines.push({ ok: false, text: `Artelivo ajan anahtarı — ${String(e)}` });
  }
  try {
    await artelivo.link("__deneme__");
    lines.push({ ok: true, text: "Link anahtarı" });
  } catch (e) {
    // Bilinmeyen id için 404 NOT_FOUND = anahtar doğru; gövdesiz 404 = anahtar yanlış/uç yok.
    const ok = e instanceof ArtelivoError && e.code === "NOT_FOUND";
    lines.push({ ok, text: ok ? "Link anahtarı" : `Link anahtarı — ${String(e)}` });
  }
  try {
    await verifySmtp();
    lines.push({ ok: true, text: `E-posta (SMTP, ${config.smtp.user})` });
  } catch (e) {
    lines.push({ ok: false, text: `E-posta (SMTP) — ${String(e)}` });
  }
  try {
    const loggedIn = await withBrowserForUi(async () => isLoggedIn(await workTab()));
    lines.push({ ok: loggedIn, text: loggedIn ? "Instagram oturumu" : "Instagram oturumu — giriş yap" });
    // Instagram'dan gitmeyen mesaj Threads'ten denenir: oturum çerezi var mı.
    const threads = await withBrowserForUi(async () =>
      (await (await workTab()).context().cookies("https://www.threads.com")).some((k) => k.name === "sessionid" && k.value),
    );
    const facebook = await withBrowserForUi(async () =>
      (await (await workTab()).context().cookies("https://www.facebook.com")).some((k) => k.name === "c_user" && k.value),
    );
    lines.push({
      ok: facebook,
      text: facebook ? "Facebook oturumu" : "Facebook oturumu — Ayarlar → \"Facebook'a giriş (bir kez)\" (sayfalardaki e-posta için)",
    });
    lines.push({
      ok: threads,
      text: threads ? "Threads oturumu" : "Threads oturumu — Ayarlar → \"Threads'e giriş (bir kez)\"",
    });
  } catch (e) {
    lines.push({ ok: false, text: `Instagram — ${String(e)}` });
  }
  lastCheck = { at: new Date().toLocaleTimeString("tr-TR"), lines };
  const bad = lines.filter((l) => !l.ok).length;
  return back(
    c,
    "/settings",
    bad ? `${bad} bağlantıda sorun var` : "Bağlantılar tamam",
    lines.map((l) => `${l.ok ? "✓" : "✗"} ${l.text.split(" — ")[0]}`).join(" · "),
    bad ? "bad" : "ok",
  );
});

app.post("/settings/test-dm", async (c) => {
  if (queueState.current) return busyRedirect(c);
  const handle = getSettings().testHandle.replace(/^@/, "").trim();
  if (!handle) return back(c, "/settings", "Önce test kullanıcı adını kaydet", "", "warn");
  try {
    await withBrowserForUi(async () =>
      sendDm(await workTab(), handle, "Artelivo Davet — test mesajı.\nİkinci satır.\n\nBu bir denemedir."),
    );
    return back(c, "/settings", "Test DM'i gönderildi", `@${handle} — Instagram'da kontrol et.`);
  } catch (e) {
    return back(c, "/settings", "Test DM'i gönderilemedi", String(e).slice(0, 200), "bad");
  }
});

// ─── Başlat ─────────────────────────────────────────────────────────────────

pruneScreenshots();
startQueue();
// Önizleme onaylarını ve sahiplenmeleri arada bir kendiliğinden çek.
setInterval(
  () => {
    if (!config.artelivo.agentKey) return;
    void syncWithArtelivo().catch(() => {});
  },
  10 * 60 * 1000,
);

serve(
  { fetch: app.fetch, hostname: "127.0.0.1", port: config.port },
  (info) => {
    const url = `http://127.0.0.1:${info.port}`;
    console.log(`Artelivo Davet → ${url}`);
    console.log(
      "Yönetim penceresini kapatırsan bu adresi herhangi bir tarayıcıda açabilirsin.",
    );
    if (process.env.NO_OPEN !== "1") {
      // Uygulamanın kendi Chrome'unda: Terminal kapanınca o da kapanır.
      openUiWindow(url).catch(() => openInDefaultBrowser(url));
    }
  },
);

// Pencere kapanınca tarayıcıyı da düzgün kapat. Terminal penceresini kapatmak
// SIGHUP gönderir.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, async () => {
    await closeBrowserIfOpen();
    process.exit(0);
  });
}
