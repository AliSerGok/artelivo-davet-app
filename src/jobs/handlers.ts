import type { Page } from "playwright";

import {
  extractDraft,
  extractMissingWorks,
  extractionRequest,
} from "../ai/extract.js";
import { type DmFacts, type DmLang, guessDmLang, LINK_PLACEHOLDER, writeDm } from "../ai/dm.js";
import { ArtelivoError, artelivo } from "../artelivo/client.js";
import {
  type ApplyNote,
  applyStructured,
  auditDraft,
  missingWorks,
} from "../drafts/structured.js";
import {
  countToday,
  db,
  getSettings,
  logEvent,
  markSeen,
  seenOutcome,
} from "../db/index.js";
import {
  DmClosedError,
  DmUnverifiedError,
  InstagramBlockedError,
  sendDm,
  sendThreadsDm,
  visitProfileInfo,
} from "../instagram/index.js";
import { randomPause, sleep, workTab } from "../lib/browser.js";
import { notify } from "../lib/notify.js";
import { countryByIso } from "../sources/countries.js";
import { sourceOf } from "../sources/index.js";
import type { ScrapedArtist } from "../sources/types.js";
import {
  addEmail,
  addLink,
  addPhone,
  inviteEmails,
  hostOf,
  isAggregator,
  nameTokens,
  notInspectable,
  readContacts,
  recordOnly,
  saveContacts,
  urlKey,
} from "../contacts/index.js";
import {
  addBioMentions,
  applyIgInfo,
  applyMentionInfo,
  bioMentions,
  crawl,
  extractEmails,
  extractPhones,
  MAX_PAGES,
  ownedBy,
  readFacebookContact,
  readPinterest,
  readPlatformPage,
} from "../discover/index.js";
import { sendInviteEmail, smtpReady } from "../mail/index.js";
import {
  enqueue,
  type JobOutcome,
  pauseQueue,
  registerJob,
  tomorrowMorning,
} from "./queue.js";

interface Run {
  id: number;
  source: string;
  category: string;
  target: number;
  status: string;
  country: string;
  min_works: number | null;
  max_works: number | null;
  last_page: number;
}
interface Candidate {
  id: number;
  run_id: number;
  source: string;
  name: string;
  source_url: string;
  city: string | null;
  works_count: number | null;
  bio: string | null;
  status: string;
}
export interface Artist {
  id: number;
  source: string;
  name: string;
  source_url: string;
  instagram_url: string;
  category: string | null;
  country: string;
  /** Mesaj dili: taslakta Claude'un tahmini ya da elle seçilen; null = bilinmiyor. */
  dm_lang: DmLang | null;
  stage: string;
  invite_id: string | null;
  review_url: string | null;
  contacts: string | null;
  /** Davet linkinin tarayıcıda ilk açıldığı an (Artelivo `openedAt`, 2026-10-24). */
  link_opened_at: string | null;
}

function setRun(
  id: number,
  fields: Partial<Pick<Run, "status">> & { note?: string },
) {
  db.prepare(
    `UPDATE runs SET status = COALESCE(?, status), note = COALESCE(?, note),
       updated_at = datetime('now') WHERE id = ?`,
  ).run(fields.status ?? null, fields.note ?? null, id);
}

export function setStage(
  id: number,
  stage: string,
  extra: Record<string, string | null> = {},
) {
  const cols = Object.keys(extra);
  db.prepare(
    `UPDATE artists SET stage = ?, ${cols.map((c) => `${c} = ?`).join(", ")}${cols.length ? "," : ""}
       updated_at = datetime('now') WHERE id = ?`,
  ).run(stage, ...cols.map((c) => extra[c] ?? null), id);
}

const handleOf = (instagramUrl: string) =>
  /instagram\.com\/([^/?#]+)/i.exec(instagramUrl)?.[1]?.toLowerCase() ?? "";

// ─── 1. Toplama ─────────────────────────────────────────────────────────────

registerJob("collect", async (runId) => {
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as
    | Run
    | undefined;
  if (!run) return;
  const source = sourceOf(run.source);
  const settings = getSettings();
  const listPage = await workTab();
  // Profil kontrolleri ayrı sekmede: liste sayfası yerinde kalsın.
  const profilePage = await listPage.context().newPage();

  const inRun = () =>
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM candidates WHERE run_id = ?")
        .get(runId) as { n: number }
    ).n;
  const country = countryByIso(run.country);
  const minWorks = run.min_works ?? settings.minWorks;
  const maxWorks = run.max_works ?? settings.maxWorks;
  // "Bir kez taranan bir daha taranmaz" — tek istisna: önceki bir turda
  // yalnız eser sayısı aralık dışı kaldığı için elenen kişi, sayısı BU turun
  // aralığına giriyorsa yeniden bakılır (aralık tura özel).
  const seenBlocks = (url: string) => {
    const outcome = seenOutcome(run.source, url);
    if (!outcome) return false;
    // Eski sürümün sayısız "aralık dışı" işareti: sayı bilinmiyor, yeniden bak.
    if (outcome === "out_of_range") return false;
    const works = /^works:(\d+)$/.exec(outcome)?.[1];
    if (works === undefined) return true;
    const n = Number(works);
    return n < minWorks || n > maxWorks;
  };
  const known = (url: string) =>
    seenBlocks(url) ||
    Boolean(
      db.prepare("SELECT 1 FROM candidates WHERE source_url = ?").get(url),
    ) ||
    Boolean(db.prepare("SELECT 1 FROM artists WHERE source_url = ?").get(url));

  try {
    const result = await source.collect(
      listPage,
      run.category,
      country,
      (artist) => !known(artist.profileUrl),
      async (artist) => {
        const profile = await source.profile(
          profilePage,
          artist.profileUrl,
          country,
        );
        if (profile.worksCount === null) {
          // Sayfa okunamadı (yavaş yükleme, bot sayfası): kalıcı dışlama YOK,
          // bir sonraki turda yeniden bakılır.
          logEvent("profile_unreadable", { run: runId });
          return false;
        }
        const works = profile.worksCount;
        if (works < minWorks || works > maxWorks) {
          // Aralık dışı: kişi bilgisi tutulmaz, yalnız eser sayısı (başka bir
          // aralıkla kurulan turda yeniden bakılabilsin diye).
          markSeen(run.source, artist.profileUrl, `works:${works}`);
          return false;
        }
        const inserted = db
          .prepare(
            `INSERT INTO candidates (run_id, source, name, source_url, city, works_count, bio)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            runId,
            run.source,
            artist.name,
            artist.profileUrl,
            profile.city,
            works,
            profile.bio,
          );
        if (profile.instagramHandle) {
          db.prepare(
            `INSERT INTO ig_candidates (candidate_id, handle, from_source) VALUES (?, ?, 1)`,
          ).run(Number(inserted.lastInsertRowid), profile.instagramHandle);
        }
        setRun(runId, { note: `${inRun()} / ${run.target} aday` });
        await randomPause(2, 4);
        return inRun() >= run.target;
      },
      {
        startPage: run.last_page + 1,
        onPage: (n) =>
          db.prepare("UPDATE runs SET last_page = ? WHERE id = ?").run(n, runId),
      },
    );
    const count = inRun();
    setRun(runId, {
      status: count > 0 ? "searching" : "done",
      note: `${count} aday toplandı (${result.pages} sayfa${result.exhausted ? ", liste bitti" : ""})`,
    });
    logEvent("collect_done", { runId, count });
    if (count > 0) enqueue("igsearch", runId);
  } catch (error) {
    setRun(runId, {
      note: `Saatchi taraması yarım kaldı (${inRun()} / ${run.target} aday) — "Devam ettir" ile kaldığı sayfadan sürer.`,
    });
    throw error;
  } finally {
    await profilePage.close().catch(() => {});
  }
});

// ─── 2. Instagram araması ───────────────────────────────────────────────────

registerJob("igsearch", async (runId): Promise<JobOutcome> => {
  // ⚠️ Instagram'a ARKA PLANDA HİÇ İSTEK GİTMEZ (2026-10-19: Instagram'ın arama
  // ucu kapandı, profil ucu 429 verdi — hesap riski). Aday yalnız sanatçının
  // kaynak profilinde KENDİ yazdığı Instagram adıdır; yoksa onay penceresinde
  // kullanıcı Instagram'ın kendi aramasıyla bulur.
  db.transaction(() => {
    db.prepare(
      `UPDATE ig_candidates SET score = 95,
         reason = 'Sanatçı kaynak profilinde bu hesabı kendisi yazmış.'
       WHERE from_source = 1 AND candidate_id IN (SELECT id FROM candidates WHERE run_id = ?)`,
    ).run(runId);
    db.prepare(
      "UPDATE candidates SET status = 'ready', ig_index = 0 WHERE run_id = ? AND status = 'collected'",
    ).run(runId);
  })();
  const count = (sql: string) =>
    (db.prepare(sql).get(runId) as { n: number }).n;
  const ready = count(
    "SELECT COUNT(*) AS n FROM candidates WHERE run_id = ? AND status = 'ready'",
  );
  const known = count(
    `SELECT COUNT(DISTINCT c.id) AS n FROM candidates c JOIN ig_candidates i ON i.candidate_id = c.id
     WHERE c.run_id = ? AND c.status = 'ready'`,
  );
  setRun(runId, {
    status: "ready",
    note: `${ready} aday onay bekliyor (${known} kişinin Instagram'ı kaynakta yazılı)`,
  });
  notify("Artelivo Davet", `Liste hazır: ${ready} aday onayını bekliyor.`);
});

// ─── 3. Taslak ──────────────────────────────────────────────────────────────

/**
 * Kaynaktaki iletişim bilgileri taslak sırasında da eklenir (keşif daha önce
 * çalıştıysa bulduklarının üstüne). Yalnız bilgi ve e-posta daveti için;
 * Artelivo'ya gönderilmez (kullanıcı, 2026-10-23).
 */
function mergeSourceContacts(artist: Artist, scraped: ScrapedArtist): void {
  const s = scraped.structured;
  const row = db.prepare("SELECT contacts FROM artists WHERE id = ?").get(artist.id) as
    | { contacts: string | null }
    | undefined;
  const c = readContacts(row?.contacts, artist.name);
  const label = sourceOf(artist.source).label;
  const text = [s?.email, s?.about, s?.education, s?.exhibitions, s?.events, scraped.profileText]
    .filter(Boolean)
    .join("\n");
  for (const e of extractEmails(text)) addEmail(c, e, label, artist.name, true);
  for (const p of extractPhones(text.replace(/</g, " "))) addPhone(c, p, label);
  for (const url of [s?.website, ...(s?.socials ?? []).map((l) => l.url)])
    if (url) addLink(c, url, label);
  saveContacts(artist.id, c);
}

registerJob("draft", async (artistId) => {
  const artist = db
    .prepare("SELECT * FROM artists WHERE id = ?")
    .get(artistId) as Artist | undefined;
  if (!artist || artist.invite_id) return;
  // Önceki bir deneme sunucuda bitmiş ama cevabı yolda kesilmiş olabilir:
  // önce Artelivo'da bu kişinin açık taslağı var mı bak, varsa onu bağla.
  if (await adoptExistingDraft(artist)) return;
  setStage(artistId, "scraping", { error: null });
  try {
    const page = await workTab();
    const scraped = await sourceOf(artist.source).scrapeAll(
      page,
      artist.source_url,
    );
    mergeSourceContacts(artist, scraped);
    setStage(artistId, "extracting");

    const request = extractionRequest({
      // Kaynak e-postası Claude'a gitmez: taslağın başka bir alanına yazılıp
      // Artelivo'ya ulaşmasın (yalnız `contacts`'ta durur).
      scraped: scraped.structured ? { ...scraped, structured: { ...scraped.structured, email: null } } : scraped,
      name: artist.name,
      instagramUrl: artist.instagram_url,
      city: null,
      countryIso: artist.country,
    });
    // Claude Code tek seferlik: düzeltme turunda önceki cevap ve Artelivo'nun
    // hata satırları isteğe eklenir.
    let prompt = request;
    let draft: Record<string, unknown> | null = null;
    const uploaded = new Map<string, string>();
    let applyNotes: ApplyNote[] = [];
    let dmLang: DmLang | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const out = await extractDraft(prompt);
      // Kaynak ve kanal alanları her durumda sabit.
      out.draft.sourceUrl = artist.source_url;
      out.draft.instagramUrl = artist.instagram_url;
      out.draft.country = artist.country;
      stripTitleQuotes(out.draft);
      delete out.draft.email;
      // Mesaj dili Artelivo alanı değil: okunur, taslaktan çıkar.
      if (out.draft.dmLanguage === "tr" || out.draft.dmLanguage === "en")
        dmLang = out.draft.dmLanguage;
      delete out.draft.dmLanguage;
      // Claude uzun listede eser atlayabiliyor: atlananları ayrıca yazdır
      // (yoksa kod kaynaktan İngilizce haliyle ekler ve not düşer).
      if (scraped.structured) {
        const missing = missingWorks(out.draft, scraped.structured);
        if (missing.length) {
          const more = await extractMissingWorks(missing).catch(() => []);
          const content = ((out.draft.content ??= {}) as Record<string, unknown>);
          content.works = [...(Array.isArray(content.works) ? content.works : []), ...more];
        }
      }
      // Kaynağın kendi verisi: ölçü, yıl, görsel, portre, kapak, linkler kodla.
      applyNotes = scraped.structured
        ? applyStructured(out.draft, scraped.structured, artist.source_url)
        : [];
      await uploadProtectedImages(page, out.draft, uploaded);
      try {
        await artelivo.dryRun(out.draft);
        draft = out.draft;
        break;
      } catch (error) {
        if (
          error instanceof ArtelivoError &&
          error.code === "VALIDATION" &&
          attempt < 2
        ) {
          prompt = [
            request,
            "",
            "=== Önceki cevabın ===",
            out.raw,
            "",
            "=== Artelivo bu taslağı reddetti; şu hataları düzelt ve TAM JSON'u yeniden ver ===",
            JSON.stringify(error.detail, null, 2),
          ].join("\n");
          continue;
        }
        throw error;
      }
    }
    if (!draft) throw new Error("Taslak doğrulanamadı.");
    // Artelivo'ya göndermeden önce kaynağa karşı alan alan denetim.
    const audit = scraped.structured
      ? await auditDraft(draft, scraped.structured, artist.instagram_url)
      : [];

    let created;
    try {
      created = await artelivo.create(draft);
    } catch (error) {
      // ⚠️ Cloudflare uzun bir isteği ~100 sn'de keser (524) ama Artelivo işi
      // sunucuda bitirir. Taslağı bulup bağla; yoksa sahipsiz kalır ve bir
      // sonraki deneme "zaten taslak var" (DUPLICATE) diye kilitlenir.
      if (
        error instanceof ArtelivoError &&
        ["VALIDATION", "INELIGIBLE", "NO_KEY", "DOOR_CLOSED"].includes(error.code)
      ) {
        throw error;
      }
      setStage(artistId, "extracting", {
        error: "Artelivo cevabı kesildi — taslak sunucuda aranıyor…",
      });
      // Denetim bu yolda da satıra yazılsın (Artelivo raporu yok: cevap kesildi).
      const pending = JSON.stringify({ audit, notes: applyNotes });
      for (let i = 0; i < 8; i++) {
        await sleep(30_000);
        if (await adoptExistingDraft(artist, pending)) return;
      }
      throw error;
    }
    setStage(artistId, "drafted", {
      invite_id: created.id,
      review_url: created.reviewUrl,
      dm_lang: artist.dm_lang ?? dmLang,
      report: JSON.stringify({
        report: created.report,
        needsReview: created.needsReview,
        similarProfiles: created.similarProfiles,
        audit,
        notes: applyNotes,
      }),
    });
    logEvent("draft_created", { artistId, inviteId: created.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const ineligible =
      error instanceof ArtelivoError && error.code === "INELIGIBLE";
    setStage(artistId, ineligible ? "ineligible" : "draft_failed", {
      error: message,
    });
    if (!ineligible) throw error;
  }
});

/**
 * Saatchi'nin profil fotoğrafı (www.saatchiart.com/saatchi-s3/…) bot
 * korumasının arkasında: Artelivo sunucusu indirirken 403 alıyor (2026-10-19,
 * ilk canlı taslakta portre düştü). Eser görselleri ayrı, korumasız bir
 * adreste. Korumalı adresleri uygulamanın KENDİ tarayıcısı, Saatchi sayfasının
 * içinden indirir ve `upload:` olarak yükler. Olmazsa adres olduğu gibi kalır
 * (Artelivo raporunda "düşen görsel" olarak görünür).
 */
const PROTECTED_IMAGE = /^https:\/\/(www\.)?saatchiart\.com\/saatchi-s3\//i;

async function uploadProtectedImages(
  page: Page,
  draft: Record<string, unknown>,
  cache: Map<string, string>,
): Promise<void> {
  const content = draft.content as Record<string, unknown> | undefined;
  if (!content) return;
  const swap = async (url: unknown): Promise<unknown> => {
    if (typeof url !== "string" || !PROTECTED_IMAGE.test(url)) return url;
    const known = cache.get(url);
    if (known) return known;
    try {
      const base64 = (await page.evaluate(async (src) => {
        const res = await fetch(src, { credentials: "include" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return btoa(binary);
      }, url)) as string;
      const { ref } = await artelivo.upload(base64);
      cache.set(url, ref);
      return ref;
    } catch (error) {
      logEvent("image_upload_failed", {
        reason: error instanceof Error ? error.message.slice(0, 200) : String(error),
      });
      return url;
    }
  };
  const swapList = async (list: unknown): Promise<unknown> =>
    Array.isArray(list) ? Promise.all(list.map(swap)) : list;

  content.avatarImageUrl = await swap(content.avatarImageUrl);
  content.coverImageUrl = await swap(content.coverImageUrl);
  content.profileImageUrls = await swapList(content.profileImageUrls);
  for (const work of (content.works ?? []) as Array<Record<string, unknown>>) {
    work.imageUrls = await swapList(work.imageUrls);
    for (const member of (work.members ?? []) as Array<Record<string, unknown>>) {
      member.imageUrls = await swapList(member.imageUrls);
    }
  }
  for (const post of (content.exhibitionPosts ?? []) as Array<Record<string, unknown>>) {
    post.imageUrls = await swapList(post.imageUrls);
  }
}

/** Kaynak siteler başlığı tırnakla yazar ("\"Başlık\""); taslakta tırnaksız. */
function stripTitleQuotes(draft: Record<string, unknown>): void {
  const clean = (t: unknown) =>
    typeof t === "string" ? t.trim().replace(/^["“”'']+|["“”'']+$/g, "").trim() : t;
  const content = draft.content as
    | { works?: Array<{ title?: unknown; members?: Array<{ title?: unknown }> }> }
    | undefined;
  for (const work of content?.works ?? []) {
    work.title = clean(work.title);
    for (const member of work.members ?? []) member.title = clean(member.title);
  }
}

/**
 * Bu kişinin Artelivo'da açık bir taslağı varsa (aynı kaynak profili) yerel
 * kayda bağlar. Kesilen istek sonrası ve her yeniden denemeden önce.
 */
export async function adoptExistingDraft(
  artist: Artist,
  /** Bu denemenin denetimi (kesilen cevaptan sonra bağlanırken). */
  report?: string,
): Promise<boolean> {
  const { items } = await artelivo.records();
  const found = items.find(
    (i) => i.sourceUrl === artist.source_url && i.channel === "INSTAGRAM"
  );
  if (!found) return false;
  setStage(artist.id, found.status === "DRAFT" ? "drafted" : "preview_approved", {
    invite_id: found.id,
    review_url: found.reviewUrl,
    error: null,
    ...(report ? { report } : {}),
  });
  logEvent("draft_adopted", { artistId: artist.id, inviteId: found.id });
  return true;
}

// ─── 4. DM ──────────────────────────────────────────────────────────────────

/**
 * DM'ler arası bekleme: iş BEKLEYEREK değil, sıradaki DM'i ileri tarihe
 * atarak uygulanır. Eskiden gönderimden sonra iş 90–240 sn "çalışıyor"
 * kalıyordu; mesaj gitmiş olsa da kuyruk meşgul görünüyordu (2026-10-19).
 * Zaman veritabanında: uygulama kapanıp açılınca da bekleme sürer.
 */
const NEXT_DM_KEY = "nextDmAt";
function nextDmAt(): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(NEXT_DM_KEY) as
    | { value: string }
    | undefined;
  return Number(row?.value ?? 0) || 0;
}
function scheduleNextDm(minSec: number, maxSec: number): void {
  const lo = Math.max(0, Math.min(minSec, maxSec));
  const hi = Math.max(minSec, maxSec);
  const at = Date.now() + Math.round((lo + Math.random() * (hi - lo)) * 1000);
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(NEXT_DM_KEY, String(at));
}

/**
 * Davet mesajını gönderir. Instagram'da "Mesaj" düğmesi yoksa Threads'ten
 * denenir (kullanıcı, 2026-10-23); ikisi aynı günlük sınırı ve beklemeyi paylaşır.
 */
async function deliver(artistId: number, via: "instagram" | "threads"): Promise<JobOutcome> {
  const settings = getSettings();
  const artist = db
    .prepare("SELECT * FROM artists WHERE id = ?")
    .get(artistId) as Artist | undefined;
  const message = db
    .prepare("SELECT * FROM dm_messages WHERE artist_id = ?")
    .get(artistId) as { text: string; status: string } | undefined;
  if (!artist?.invite_id || !message || message.status === "sent") return;
  // Uygulama gönderim sırasında kapandıysa mesaj gitmiş olabilir: tekrar
  // gönderme, sana sor.
  if (message.status === "sending" || message.status === "unverified") {
    db.prepare(
      "UPDATE dm_messages SET status = 'unverified', error = ? WHERE artist_id = ?",
    ).run("Gönderim yarıda kaldı — gitti mi, sohbete bak.", artistId);
    return;
  }
  if (countToday("ig_dm") >= settings.igDmPerDay) {
    db.prepare(
      "UPDATE dm_messages SET status = 'waiting', error = ? WHERE artist_id = ?",
    ).run("Günlük DM sınırı doldu — yarın sabah gönderilecek.", artistId);
    return { deferUntil: tomorrowMorning() };
  }
  // Önceki DM'den bu yana bekleme dolmadıysa: iş sıraya, o saate.
  const waitUntil = nextDmAt();
  if (waitUntil > Date.now()) {
    db.prepare(
      "UPDATE dm_messages SET status = 'waiting', error = NULL WHERE artist_id = ?",
    ).run(artistId);
    return { deferUntil: new Date(waitUntil) };
  }
  db.prepare(
    "UPDATE dm_messages SET status = 'sending', error = NULL WHERE artist_id = ?",
  ).run(artistId);
  try {
    // Link mesaj hazırlanırken metne yazıldı; aynı davet için aynı link döner.
    // Eski mesajdaki yer tutucu değişir; elle düzenlenirken link silindiyse
    // sona eklenir — linksiz mesaj gitmez.
    const link = await artelivo.link(artist.invite_id);
    let text = message.text.split(LINK_PLACEHOLDER).join(link.claimUrl);
    if (!text.includes(link.claimUrl)) text = `${text.trim()}\n\n${link.claimUrl}`;
    const page = await workTab();
    // Her DENEME günlük sınırdan düşer — başarısızlar da Instagram'a gider.
    logEvent("ig_dm", via === "threads" ? { artistId, via } : { artistId });
    if (via === "threads") await sendThreadsDm(page, threadsHandle(artist), text);
    else await sendDm(page, handleOf(artist.instagram_url), text, { follow: true });
    db.prepare(
      "UPDATE dm_messages SET status = 'sent', sent_at = datetime('now'), error = NULL, via = ? WHERE artist_id = ?",
    ).run(via, artistId);
    setStage(artistId, "dm_sent", { error: null });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (error instanceof InstagramBlockedError) {
      // Instagram yavaşla dedi: kuyruğu durdur, mesaj sırada kalsın.
      pauseQueue(true);
      logEvent("ig_blocked", text);
      notify("Artelivo Davet", "Instagram engel/doğrulama gösterdi — gönderim durduruldu.");
      if (error.maybeSent) {
        // Enter'dan sonra çıktı: gitmiş olabilir, kendiliğinden yeniden gönderme.
        db.prepare(
          "UPDATE dm_messages SET status = 'unverified', error = ? WHERE artist_id = ?",
        ).run(text, artistId);
        return;
      }
      db.prepare(
        "UPDATE dm_messages SET status = 'waiting', error = ? WHERE artist_id = ?",
      ).run(text, artistId);
      return { deferUntil: tomorrowMorning() };
    }
    if (via === "instagram" && error instanceof DmClosedError) {
      // Instagram'da mesaja kapalı: Threads'ten denenir (mesaj gitmedi).
      db.prepare(
        "UPDATE dm_messages SET status = 'waiting', error = ? WHERE artist_id = ?",
      ).run(`Instagram: ${text} → Threads'ten denenecek.`, artistId);
      enqueue("threads", artistId);
      return;
    }
    db.prepare(
      "UPDATE dm_messages SET status = ?, error = ? WHERE artist_id = ?",
    ).run(
      error instanceof DmUnverifiedError ? "unverified" : "failed",
      via === "threads" ? `Instagram'da mesaja kapalı · Threads: ${text}` : text,
      artistId,
    );
    throw error;
  } finally {
    // Başarısız denemeden sonra da bekle: art arda hızlı denemeler Instagram'ı
    // kızdırır. İş hemen biter; sıradaki DM bu süre dolunca başlar.
    scheduleNextDm(settings.igDmDelayMin, settings.igDmDelayMax);
  }
}

registerJob("dm", (artistId) => deliver(artistId, "instagram"));
registerJob("threads", (artistId) => deliver(artistId, "threads"));

/** Threads kullanıcı adı: keşifte bulunan Threads linki, yoksa Instagram'ınki (aynı hesap). */
function threadsHandle(artist: Artist): string {
  const link = readContacts(artist.contacts, artist.name).links.find((l) => l.label === "Threads");
  return (link && /\/@([A-Za-z0-9._]+)/.exec(link.url)?.[1]) || handleOf(artist.instagram_url);
}

// ─── 4b. Bağlantı keşfi ─────────────────────────────────────────────────────
// Instagram onayından sonra (kullanıcı, 2026-10-23): kaynak profili, Instagram
// bio'su ve oradan gidilen sayfalarda e-posta ve link arar (src/discover).

registerJob("discover", async (artistId): Promise<JobOutcome> => {
  const artist = db
    .prepare("SELECT * FROM artists WHERE id = ?")
    .get(artistId) as Artist | undefined;
  if (!artist) return;
  const c = readContacts(artist.contacts, artist.name);
  const page = await workTab();
  const adapter = sourceOf(artist.source);
  if (!c.sourceChecked && adapter.contactInfo) {
    const info = await adapter.contactInfo(page, artist.source_url).catch(() => null);
    if (info) {
      if (info.email) addEmail(c, info.email, adapter.label, artist.name, true);
      for (const e of extractEmails(info.text)) addEmail(c, e, adapter.label, artist.name, true);
      for (const p of extractPhones(info.text.replace(/</g, " "))) addPhone(c, p, adapter.label);
      for (const url of info.links) addLink(c, url, adapter.label);
    }
    c.sourceChecked = true;
  }
  // Onay penceresinde okunamadıysa (eski onaylar) profil, sonra bio'da anılan
  // hesaplar (en çok 3) birer kez açılır. Her biri bir Instagram isteğidir: DM
  // ile aynı bekleme ve günlük sınır (ayarlardan); beklerken iş ertelenir.
  const settings = getSettings();
  const own = handleOf(artist.instagram_url);
  if (c.igBio) addBioMentions(c, c.igBio); // bu özellikten önce okunmuş bio'lar
  const ownedMention = ownedBy([...nameTokens(artist.name), own]);
  let next: string | null = !c.igChecked ? own : (bioMentions(c, own)[0] ?? null);
  while (next) {
    if (countToday("ig_profile_visit") >= settings.igDmPerDay) {
      logEvent("ig_profile_visit_skipped", { artistId });
      break;
    }
    if (nextDmAt() > Date.now()) {
      saveContacts(artistId, c); // okunanlar kaybolmasın
      return { deferUntil: new Date(nextDmAt()) };
    }
    logEvent("ig_profile_visit", { artistId });
    try {
      const info = await visitProfileInfo(page, next);
      if (next === own) {
        if (info) applyIgInfo(c, info, artist.name);
        c.igChecked = true;
      } else {
        if (info) applyMentionInfo(c, next, info, artist.name, ownedMention(next));
        c.igVisited.push(next);
      }
    } catch (error) {
      if (error instanceof InstagramBlockedError) {
        pauseQueue(true);
        logEvent("ig_blocked", error.message);
        notify("Artelivo Davet", "Instagram engel/doğrulama gösterdi — kuyruk durduruldu.");
      }
      // Anılan hesap açılamadıysa (silinmiş, yanlış yazılmış) keşif sürer.
      if (next === own || error instanceof InstagramBlockedError) throw error;
      c.igVisited.push(next);
    } finally {
      scheduleNextDm(settings.igDmDelayMin, settings.igDmDelayMax);
    }
    saveContacts(artistId, c);
    next = bioMentions(c, own)[0] ?? null;
  }
  saveContacts(artistId, c);
  const ident = [
    ...nameTokens(artist.name),
    handleOf(artist.instagram_url),
    ...c.links.filter((l) => l.label === "Threads").map((l) => /@([\w.]+)/.exec(l.url)?.[1] ?? ""),
  ].filter(Boolean);
  // İki tur: siteler/link sayfaları taranır, sonra bulunan platform profilleri
  // incelenir; platformda yeni bir site çıkarsa ikinci turda o da taranır.
  const owned = ownedBy(ident);
  const crawled = new Set<string>();
  const inspected = new Set<string>();
  let pages = 0;
  let fbAllowed = true;
  for (let round = 0; round < 2; round++) {
    const seeds = c.links.map((l) => l.url).filter((u) => !recordOnly(u) && !crawled.has(urlKey(u)));
    for (const u of seeds) crawled.add(urlKey(u));
    if (seeds.length && pages < MAX_PAGES) {
      const found = await crawl(seeds, workTab, ident, MAX_PAGES - pages);
      pages += found.pages;
      // Sanatçıya ait sayfadaki (adını/kullanıcı adını taşıyan) adres: sitenin kendi
      // alan adındaysa ya da sayfa bir link sayfasıysa güvenilir. Galeri sitesi değil.
      for (const e of found.emails) {
        const place = `https://${e.from}`;
        const domain = e.value.split("@")[1] ?? "";
        const host = hostOf(place);
        // Sitede sahiplik ALAN ADINDAN (ayseart.com), yoldan değil: galerinin
        // sanatçı sayfası (galerix.com/sanatcilar/ayse-kaya) galerinindir.
        const own = isAggregator(place)
          ? owned(place)
          : owned(`https://${host}`) && (host === domain || host.endsWith(`.${domain}`));
        addEmail(c, e.value, e.from, artist.name, own);
      }
      for (const p of found.phones) addPhone(c, p.value, p.from);
      for (const l of found.links) addLink(c, l.url, l.from);
    }
    // Bu turda açılan ya da bilerek açılmayan siteler sonraki turda yeniden taranmaz.
    for (const l of c.links) if (!recordOnly(l.url)) crawled.add(urlKey(l.url));
    const platforms = c.links.filter(
      (l) => recordOnly(l.url) && !notInspectable(l.url) && !inspected.has(urlKey(l.url)),
    );
    if (!platforms.length && round > 0) break;
    for (const l of platforms.slice(0, 6)) {
      if (pages >= MAX_PAGES) break;
      inspected.add(urlKey(l.url));
      // Sanatçının kendi verdiği hesap mı: bio'dan/kaynaktan geldi ya da adını taşıyor.
      const ownAccount = l.from === "Instagram bio" || l.from === adapter.label || l.from === "Saatchi" || owned(l.url);
      if (l.label === "Facebook") {
        if (!fbAllowed) continue;
        const fb = await readFacebookContact(page, l.url).catch(() => null);
        pages += 2;
        if (fb?.loginWall) {
          fbAllowed = false;
          logEvent("facebook_login_needed", { artistId });
          continue;
        }
        for (const e of fb?.emails ?? []) addEmail(c, e, "Facebook", artist.name, ownAccount);
        for (const ph of fb?.phones ?? []) addPhone(c, ph, "Facebook");
        for (const u of fb?.links ?? []) addLink(c, u, "Facebook");
        await randomPause(2, 5);
        continue;
      }
      const res =
        l.label === "Pinterest"
          ? await readPinterest(l.url).catch(() => null)
          : await readPlatformPage(l.url, workTab, ident).catch(() => null);
      pages++;
      // Pinterest'in iletişim alanını hesap sahibi girer; diğer platform
      // sayfalarındaki adresler (yorumlar, başka hesaplar) yalnız adla eşleşirse.
      for (const e of res?.emails ?? []) addEmail(c, e, l.label, artist.name, ownAccount && l.label === "Pinterest");
      for (const ph of res?.phones ?? []) addPhone(c, ph, l.label);
      for (const u of res?.links ?? []) addLink(c, u, l.label);
    }
  }
  c.discoveredAt = new Date().toISOString();
  c.pages = pages;
  saveContacts(artistId, c);
  logEvent("discover_done", { artistId, emails: c.emails.length, links: c.links.length });
  // Tarama hiçbir şey göndermez (kullanıcı, 2026-10-23): e-posta yalnız
  // Mesajlar'da "gönder" denince sıraya girer.
});

// ─── 4c. Davet e-postası ────────────────────────────────────────────────────
// E-posta bulunduysa DM'e EK olarak (kullanıcı, 2026-10-23); metin DM'in
// aynısı, link gönderimde yeniden doğrulanır. Güvenilir adreslerin hepsine
// tek e-posta (kullanıcı, 2026-10-23); to_addr virgülle ayrılmış liste.

/**
 * Sanatçının e-postası varsa ve henüz gitmediyse davet e-postasını sıraya
 * koyar. Mesajı hazır olmalı (metin DM'den gelir).
 */
export function queueEmail(artistId: number): boolean {
  const artist = db
    .prepare("SELECT * FROM artists WHERE id = ?")
    .get(artistId) as Artist | undefined;
  const dm = db.prepare("SELECT status FROM dm_messages WHERE artist_id = ?").get(artistId);
  if (!artist?.invite_id || !dm) return false;
  const to = inviteEmails(readContacts(artist.contacts, artist.name)).map((e) => e.value);
  if (!to.length) return false;
  const row = db
    .prepare("SELECT status FROM email_messages WHERE artist_id = ?")
    .get(artistId) as { status: string } | undefined;
  if (row && ["sent", "sending", "unverified"].includes(row.status)) return false;
  db.prepare(
    `INSERT INTO email_messages (artist_id, to_addr, status) VALUES (?, ?, 'waiting')
     ON CONFLICT(artist_id) DO UPDATE SET to_addr = excluded.to_addr, status = 'waiting',
       error = NULL, updated_at = datetime('now')`,
  ).run(artistId, to.join(", "));
  enqueue("email", artistId);
  return true;
}

const NEXT_EMAIL_KEY = "nextEmailAt";

registerJob("email", async (artistId): Promise<JobOutcome> => {
  const settings = getSettings();
  const artist = db
    .prepare("SELECT * FROM artists WHERE id = ?")
    .get(artistId) as Artist | undefined;
  const row = db
    .prepare("SELECT * FROM email_messages WHERE artist_id = ?")
    .get(artistId) as { to_addr: string; status: string } | undefined;
  const message = db
    .prepare("SELECT text, status FROM dm_messages WHERE artist_id = ?")
    .get(artistId) as { text: string; status: string } | undefined;
  if (!artist?.invite_id || !row || !message || row.status === "sent") return;
  // Mesaj geri çekildiyse (sıradan çıkarıldı, taslağa döndü) e-posta da gitmez.
  if (message.status === "draft") {
    db.prepare("DELETE FROM email_messages WHERE artist_id = ? AND status = 'waiting'").run(artistId);
    return;
  }
  const setRow = (status: string, error: string | null) =>
    db.prepare(
      "UPDATE email_messages SET status = ?, error = ?, updated_at = datetime('now') WHERE artist_id = ?",
    ).run(status, error, artistId);
  // Uygulama gönderirken kapandıysa: gitmiş olabilir, kendiliğinden yeniden gönderme.
  if (row.status === "sending" || row.status === "unverified") {
    setRow("unverified", "Gönderim yarıda kaldı — info@artelivo.com Gönderilmiş klasörüne bak.");
    return;
  }
  if (!smtpReady()) {
    setRow("failed", "E-posta ayarları yok (.env SMTP_*).");
    throw new Error("E-posta ayarları yok (.env SMTP_*).");
  }
  if (countToday("email_sent") >= settings.emailPerDay) {
    setRow("waiting", "Günlük e-posta sınırı doldu — yarın sabah gönderilecek.");
    return { deferUntil: tomorrowMorning() };
  }
  const waitUntil = Number(
    (db.prepare("SELECT value FROM settings WHERE key = ?").get(NEXT_EMAIL_KEY) as { value: string } | undefined)
      ?.value ?? 0,
  );
  if (waitUntil > Date.now()) return { deferUntil: new Date(waitUntil) };
  setRow("sending", null);
  try {
    const link = await artelivo.link(artist.invite_id);
    let text = message.text.split(LINK_PLACEHOLDER).join(link.claimUrl);
    if (!text.includes(link.claimUrl)) text = `${text.trim()}\n\n${link.claimUrl}`;
    await sendInviteEmail(row.to_addr, text, artist.dm_lang === "en" ? "en" : "tr");
    db.prepare(
      "UPDATE email_messages SET status = 'sent', error = NULL, sent_at = datetime('now'), updated_at = datetime('now') WHERE artist_id = ?",
    ).run(artistId);
    // Davet e-postayla ulaştı: DM gitmese de sanatçı gönderilenlere geçer (kullanıcı, 2026-10-23).
    if (artist.stage === "dm_ready") setStage(artistId, "dm_sent", { error: null });
    logEvent("email_sent", { artistId });
  } catch (error) {
    // Adres yalnız sanatçının satırında kalır: iş/olay kaydına (davet kapanınca
    // silinmez) adressiz hata yazılır (KVKK).
    const text = (error instanceof Error ? error.message : String(error))
      .split(row.to_addr)
      .join("<alıcı>")
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<adres>");
    setRow("failed", text);
    throw new Error(text);
  } finally {
    const lo = Math.max(0, Math.min(settings.emailDelayMin, settings.emailDelayMax));
    const hi = Math.max(settings.emailDelayMin, settings.emailDelayMax);
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(NEXT_EMAIL_KEY, String(Date.now() + Math.round((lo + Math.random() * (hi - lo)) * 1000)));
  }
});

/** Seçili, önizlemesi onaylı sanatçılar için DM metni (henüz gönderilmez). */
export async function prepareDm(artistId: number): Promise<void> {
  const artist = db
    .prepare("SELECT * FROM artists WHERE id = ?")
    .get(artistId) as Artist | undefined;
  if (!artist?.invite_id) throw new Error("Taslağı yok.");
  // Gitmiş / gitmiş olabilecek / sırada bekleyen mesajın üstüne yazılmaz:
  // 'unverified' uyarısı silinip aynı kişiye ikinci DM gidebiliyordu.
  const existing = db
    .prepare("SELECT status FROM dm_messages WHERE artist_id = ?")
    .get(artistId) as { status: string } | undefined;
  if (existing?.status === "sent") throw new Error("Bu kişiye mesaj zaten gönderildi.");
  if (existing?.status === "unverified")
    throw new Error("Doğrulanamamış bir mesaj var — önce Mesajlar'da sohbete bakıp karar ver.");
  if (existing && ["sending", "waiting"].includes(existing.status))
    throw new Error("Mesajı sırada ya da gönderiliyor — önce Mesajlar'da sıradan çıkar.");
  const record = (await artelivo.get(artist.invite_id)) as unknown as Record<string, unknown>;
  const content = (record.content ?? {}) as {
    works?: Array<{ kind?: string; title?: string; members?: Array<{ title?: string }> }>;
    exhibitions?: Array<{ isSolo?: boolean }>;
    education?: unknown[];
    career?: Array<{ title?: string }>;
    avatarImage?: unknown;
  };
  const works = content.works ?? [];
  // Davet linki MESAJ HAZIRLANIRKEN alınır ve metne yazılır (kullanıcı,
  // 2026-10-19: "linki sen koy"). Önizleme onaylı olmalı; link 30 gün geçerli
  // ve bu an başlar — aynı davet için tekrar istenince aynı link döner.
  const link = await artelivo.link(artist.invite_id);
  const facts: DmFacts = {
    name: String(record.name ?? artist.name),
    sourceLabel: sourceOf(artist.source).label,
    biography: typeof record.biography === "string" ? record.biography.slice(0, 1500) : null,
    city: typeof record.city === "string" ? record.city : null,
    series: works.filter((w) => w.kind === "SERIES").map((w) => w.title ?? "").filter(Boolean),
    workTitles: works
      .flatMap((w) => (w.kind === "SERIES" ? (w.members ?? []) : [w]))
      .map((w) => w.title ?? "")
      .filter(Boolean)
      .slice(0, 8),
    worksCount: works.reduce((n, w) => n + (w.kind === "SERIES" ? (w.members?.length ?? 0) : 1), 0),
    exhibitionsCount: content.exhibitions?.length ?? 0,
    soloCount: (content.exhibitions ?? []).filter((e) => e.isSolo).length,
    hasEducation: Boolean(content.education?.length),
    careerTitles: (content.career ?? []).map((c) => c.title ?? "").filter(Boolean).slice(0, 4),
    hasPortrait: Boolean(content.avatarImage),
    specialties: Array.isArray(record.specialties) ? (record.specialties as string[]) : [],
  };
  // Dil taslakta belirlenmediyse (eski satırlar, bağlanan taslaklar) şimdi
  // tahmin edilir ve satıra yazılır; Mesajlar'dan elle değişir.
  let lang = artist.dm_lang;
  if (!lang) {
    lang = await guessDmLang(facts, artist.country);
    db.prepare("UPDATE artists SET dm_lang = ? WHERE id = ?").run(lang, artistId);
  }
  const text = await writeDm(facts, link.claimUrl, lang);
  db.prepare(
    `INSERT INTO dm_messages (artist_id, text, created_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(artist_id) DO UPDATE SET text = excluded.text, status = 'draft', error = NULL,
       created_at = datetime('now'), updated_at = datetime('now')`,
  ).run(artistId, text);
  setStage(artistId, "dm_ready");
}

// ─── 5. Artelivo ile eşitleme ───────────────────────────────────────────────

const OPEN_STAGES = ["drafted", "preview_approved", "dm_ready", "dm_sent"];

/** Artelivo'daki duruma göre aşamaları günceller (önizleme onayı, sahiplenme…). */
export async function syncWithArtelivo(): Promise<{ changed: number }> {
  const artists = db
    .prepare(
      `SELECT * FROM artists WHERE invite_id IS NOT NULL AND stage IN (${OPEN_STAGES.map(() => "?").join(",")})`,
    )
    .all(...OPEN_STAGES) as Artist[];
  if (artists.length === 0) return { changed: 0 };
  const { items } = await artelivo.records();
  const byId = new Map(items.map((i) => [i.id, i]));
  const since = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
  const { items: history } = await artelivo.history(since);
  const ended = new Map(
    history
      .filter((h) => h.inviteId)
      .map((h) => [h.inviteId as string, h.type]),
  );

  let changed = 0;
  for (const artist of artists) {
    const record = byId.get(artist.invite_id as string);
    const end = ended.get(artist.invite_id as string);
    // Link açıldı mı (Artelivo yalnız ilk açılışı tutar); kapanınca satır
    // silindiği için son bilinen değer burada saklanır.
    const openedAt = record?.openedAt ?? artist.link_opened_at;
    if (openedAt && openedAt !== artist.link_opened_at) {
      db.prepare("UPDATE artists SET link_opened_at = ? WHERE id = ?").run(openedAt, artist.id);
      changed++;
    }
    let next = artist.stage;
    if (end === "CLAIMED") next = "claimed";
    else if (end === "DECLINED") next = "declined";
    else if (end === "EXPIRED") next = "expired";
    else if (end === "WITHDRAWN" || !record) next = "withdrawn";
    // Önizlemede "Onayla" → APPROVED. "Linki al"a da basıldıysa INVITED
    // (link üretildi, 30 gün başladı) — ikisi de önizleme onaylı demek
    // (2026-10-19: INVITED tanınmıyordu, "onaylamadı" görünüyordu).
    else if (
      (record.status === "APPROVED" || record.status === "INVITED") &&
      artist.stage === "drafted"
    )
      next = "preview_approved";
    else if (record.status === "DRAFT" && artist.stage === "preview_approved")
      next = "drafted";
    if (CLOSED_STAGES.has(next)) {
      // Davet kapandı (aldı / istemedi / süresi doldu / silindi). Taslak,
      // iletişim bilgisi ve mesaj metni gider; "Davet sonuçları" için yalnız
      // ad ve linkler `invite_outcomes`'ta kalır (kullanıcı 2026-10-23).
      db.transaction(() => {
        db.prepare(
          `INSERT INTO invite_outcomes (outcome, name, instagram_url, source_url, sent_at, opened_at)
           VALUES (?, ?, ?, ?, (SELECT sent_at FROM dm_messages WHERE artist_id = ?), ?)`,
        ).run(next, artist.name, artist.instagram_url, artist.source_url, artist.id, openedAt ?? null);
        markSeen(artist.source, artist.source_url, `invite_${next}`);
        db.prepare("DELETE FROM artists WHERE id = ?").run(artist.id);
        logEvent("invite_closed", { outcome: next });
      })();
      changed++;
      continue;
    }
    if (next !== artist.stage) {
      setStage(artist.id, next);
      changed++;
    }
  }
  return { changed };
}

const CLOSED_STAGES = new Set(["claimed", "declined", "expired", "withdrawn"]);

/** Kapanan davetlerin sayısı — kişi bilgisi olmadan. */
export function closedCounts(): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT json_extract(detail, '$.outcome') AS outcome, COUNT(*) AS n
       FROM events WHERE kind = 'invite_closed' GROUP BY outcome`
    )
    .all() as Array<{ outcome: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.outcome, r.n]));
}

registerJob("sync", async () => {
  await syncWithArtelivo();
});
