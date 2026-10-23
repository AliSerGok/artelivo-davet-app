import type { Locator, Page } from "playwright";

import { sleep, snapshot } from "../lib/browser.js";

// ============================================================================
// Instagram — uygulamanın Chrome profilindeki oturumla.
// ----------------------------------------------------------------------------
// ⚠️ ARKA PLANDA YALNIZ DM (2026-10-19): Instagram araması/profil bilgisi
// otomatik ÇEKİLMEZ — arama ucu kapandı, profil ucu 429 verdi, hesap riski.
// Aday arama onay penceresinde, kullanıcının kendi elinde yapılır.
// DM: profil → "Mesaj" düğmesi → yazı kutusu. Instagram bir doğrulama ya da
// giriş sayfasına yönlendirirse iş durur (InstagramBlockedError).
// ============================================================================

const IG = "https://www.instagram.com";

/**
 * Enter'a basıldı ama mesaj sohbette görülemedi: GİTMİŞ OLABİLİR. Bu durumda
 * kendiliğinden yeniden gönderilmez (aynı kişiye ikinci DM).
 */
export class DmUnverifiedError extends Error {}

/**
 * Instagram yavaşla/doğrula dedi (challenge, giriş sayfası, "daha sonra
 * tekrar dene"). Kuyruk durur; kullanıcı Instagram'a bakmadan devam etmez.
 */
export class InstagramBlockedError extends Error {
  /** Engel, Enter'a basıldıktan SONRA çıktı: mesaj gitmiş olabilir. */
  maybeSent = false;
}

/**
 * Profilde "Mesaj" düğmesi yok (gizli hesap ya da mesaja kapalı): mesaj
 * GİTMEDİ; Threads'ten denenir (kullanıcı, 2026-10-23).
 */
export class DmClosedError extends Error {}

const BLOCK_URL = /\/(challenge|accounts\/login|accounts\/suspended|checkpoint)/;

/** Sayfa bir engel/doğrulama ekranındaysa durdurur. */
async function assertNotBlocked(page: Page, label: string): Promise<void> {
  const url = page.url();
  const text = await page
    .locator("body")
    .innerText({ timeout: 2000 })
    .catch(() => "");
  if (
    BLOCK_URL.test(url) ||
    /(Try Again Later|Daha Sonra Tekrar Dene|We restrict certain activity|Bazı etkinlikleri kısıtlıyoruz)/i.test(text)
  ) {
    const shot = await snapshot(page, "instagram-blocked");
    throw new InstagramBlockedError(
      `Instagram engel/doğrulama gösterdi (${label}). Kuyruk durduruldu — Instagram'a elle bak. Ekran: ${shot}`,
    );
  }
}

/** Instagram açık mı ve oturum var mı. */
export async function isLoggedIn(page: Page): Promise<boolean> {
  if (!page.url().startsWith(IG)) {
    await page.goto(`${IG}/`, { waitUntil: "domcontentloaded" });
    await sleep(2000);
  }
  const cookies = await page.context().cookies(IG);
  return cookies.some((c) => c.name === "sessionid" && c.value);
}

async function ensureOnInstagram(page: Page): Promise<void> {
  if (!page.url().startsWith(IG)) {
    await page.goto(`${IG}/`, { waitUntil: "domcontentloaded" });
    await sleep(1500);
  }
  await assertNotBlocked(page, "Instagram açılırken");
  if (!(await isLoggedIn(page))) {
    throw new Error(
      'Instagram oturumu yok — Ayarlar → "Instagram\'a giriş" ile bu pencerede giriş yap.',
    );
  }
}

/**
 * Instagram bir DM'de en çok 1000 karakter kabul eder; fazlasını "Mesajın çok
 * uzun" diyerek KESİP gönderir (2026-10-19: iki davet "…açık çağrı"da kesik
 * gitti). Metin paragraf sınırlarından ≤ DM_MAX parçalara bölünür; tek
 * paragraf da sığmazsa cümle sınırından.
 */
export const DM_MAX = 950;

export function splitForDm(text: string, max = DM_MAX): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const pieces: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= max) {
      pieces.push(p);
      continue;
    }
    let rest = p;
    while (rest.length > max) {
      const window = rest.slice(0, max);
      const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"), window.lastIndexOf("! "), window.lastIndexOf("? "));
      const at = cut > max * 0.4 ? cut + 1 : window.lastIndexOf(" ") > 0 ? window.lastIndexOf(" ") : max;
      pieces.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) pieces.push(rest);
  }
  // Kısa parçaları (imza gibi) bir öncekine ekle; toplam sınırı aşmadan.
  const out: string[] = [];
  for (const piece of pieces) {
    const last = out.at(-1);
    if (last !== undefined && last.length + 2 + piece.length <= max) out[out.length - 1] = `${last}\n\n${piece}`;
    else out.push(piece);
  }
  return out;
}

/**
 * DM gönderir: metin ≤1000 karakterlik parçalara bölünüp ayrı mesajlar olarak.
 * Parça içi satırlar Shift+Enter (Enter göndermek demek). Her parçadan sonra
 * kutunun boşaldığı (gitti) ve parçanın sonunun sohbette göründüğü denetlenir.
 */
export async function sendDm(
  page: Page,
  handle: string,
  text: string,
  options: { follow?: boolean } = {},
): Promise<void> {
  await ensureOnInstagram(page);
  await page.goto(`${IG}/${handle}/`, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  await assertNotBlocked(page, "profil açılırken");
  if (options.follow) await followProfile(page);

  const messageButton = page
    .getByRole("button", { name: /^(Mesaj gönder|Mesaj|Message)$/i })
    .or(page.getByRole("link", { name: /^(Mesaj gönder|Mesaj|Message)$/i }))
    .first();
  if ((await messageButton.count()) === 0) {
    const shot = await snapshot(page, "no-message-button");
    throw new DmClosedError(
      `"Mesaj" düğmesi yok (gizli hesap ya da mesaja kapalı). Ekran: ${shot}`,
    );
  }
  await messageButton.click();

  const box = page
    .locator('div[role="textbox"][contenteditable="true"]')
    .first();
  await box.waitFor({ state: "visible", timeout: 20000 });
  // "Bildirimleri aç?" gibi açılır pencereler kutunun önüne geçebilir.
  await page
    .getByRole("button", { name: /^(Şimdi Değil|Not Now)$/i })
    .click({ timeout: 1500 })
    .catch(() => {});
  await typeAndVerify(page, box, text);
}

/**
 * Mesajdan önce takip (kullanıcı 2026-10-24): açık profilde "Takip et"e basar.
 * Zaten takipte/istek gönderilmişse düğme farklıdır, dokunulmaz. Gizli hesapta
 * takip isteği gider; "Mesaj" düğmesi yine yoksa akış Threads'e geçer.
 * Düğme bulunamazsa ya da tıklanamazsa DM yine denenir; engel çıkarsa durur.
 */
async function followProfile(page: Page): Promise<void> {
  const followButton = page
    .locator("main header")
    .getByRole("button", { name: /^(Takip et|Geri takip et|Follow|Follow Back)$/i })
    .first();
  if ((await followButton.count()) === 0) return;
  await followButton.click({ timeout: 3000 }).catch(() => {});
  await sleep(1500 + Math.random() * 1500);
  await assertNotBlocked(page, "takip edilirken");
}

/**
 * Metni parça parça yazıp gönderir; her parçanın kutudan çıktığını ve
 * sohbette göründüğünü doğrular (Instagram ve Threads aynı Meta bileşeni).
 */
async function typeAndVerify(page: Page, box: Locator, text: string): Promise<void> {
  const parts = splitForDm(text);
  for (const [partIndex, part] of parts.entries()) {
    await box.click();
    const lines = part.split("\n");
    for (const [index, line] of lines.entries()) {
      if (line) await page.keyboard.insertText(line);
      if (index < lines.length - 1) await page.keyboard.press("Shift+Enter");
    }
    await sleep(600);
    await page.keyboard.press("Enter");
    await sleep(2500);
    await assertNotBlocked(page, "mesaj gönderilirken").catch((error: unknown) => {
      if (error instanceof InstagramBlockedError) error.maybeSent = true;
      throw error;
    });

    // 1) Kutu boşaldı mı? Dolu kaldıysa (ör. "çok uzun") parça GİTMEDİ ya da kesik gitti.
    let leftover = "";
    for (let i = 0; i < 10; i++) {
      leftover = ((await box.innerText().catch(() => "")) ?? "").trim();
      if (!leftover) break;
      await sleep(500);
    }
    // 2) Parçanın SON satırının başı sohbette görünüyor mu? (kesik gitmediğinin kanıtı)
    const probe = lines
      .map((l) => l.trim())
      .filter((l) => l.length > 3)
      .at(-1)
      ?.slice(0, 40);
    let visible = !probe;
    for (let i = 0; !visible && i < 6; i++) {
      visible = await page
        .getByText(probe ?? "", { exact: false })
        .last()
        .isVisible()
        .catch(() => false);
      if (!visible) await sleep(500);
    }
    if (leftover || !visible) {
      const shot = await snapshot(page, "dm-unverified");
      throw new DmUnverifiedError(
        `${partIndex + 1}/${parts.length}. parça ${leftover ? "kutuda kaldı (gitmedi ya da kesik gitti)" : "sohbette görünmüyor"} — sohbete bak. Ekran: ${shot}`,
      );
    }
    if (partIndex < parts.length - 1) await sleep(1500 + Math.random() * 2000);
  }
}

// ─── Profil bilgisi (bağlantı keşfi, kullanıcı 2026-10-23) ────────────────────

export interface ProfileInfo {
  /** Profil başlığının görünen metni (ad, kategori, bio). */
  bio: string;
  /** Bio'daki dış linkler (Instagram'ın l.instagram.com sarmalı açılmış). */
  links: string[];
}

/**
 * AÇIK bir profil sayfasından okur; profil değilse null. Instagram'a istek
 * atmaz; yalnız sayfadaki "more" (bio'yu açar) ve "… and N more" (link
 * penceresi) düğmelerine basar, pencereyi kapatır (2026-10-23 bakıldı).
 */
export async function readProfileInfo(page: Page): Promise<ProfileInfo | null> {
  if (!/instagram\.com\/[^/?#]+\/?(\?|#|$)/.test(page.url())) return null;
  const header = page.locator("main header").first();
  if ((await header.count()) === 0) return null;
  // Kısaltılmış bio.
  await header
    .locator('[role="button"]')
    .filter({ hasText: /^(more|devamı|daha fazla)$/i })
    .first()
    .click({ timeout: 1500 })
    .catch(() => {});
  const links = new Set<string>();
  const collect = async (scope: string) => {
    const hrefs = await page
      .locator(`${scope} a[href]`)
      .evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href))
      .catch(() => [] as string[]);
    for (const href of hrefs) {
      try {
        const u = new URL(href);
        if (u.hostname === "l.instagram.com") links.add(u.searchParams.get("u") ?? "");
        else if (!u.hostname.endsWith("instagram.com")) links.add(href);
      } catch {
        // bozuk adres
      }
    }
  };
  await collect("main header");
  // Birden çok link: "Ad and 2 more" düğmesi bir pencere açar.
  const many = header.locator("button").filter({ hasText: /\b(and|ve) \d+ (more|diğer|tane daha|daha)/i }).first();
  if ((await many.count()) > 0) {
    await many.click({ timeout: 2000 }).catch(() => {});
    const dialog = page.locator('[role="dialog"]').last();
    await dialog.waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
    await collect('[role="dialog"]');
    // Linkin görünen metni (sarmal açılamazsa): "linktr.ee/ad"
    const lines = await dialog.innerText({ timeout: 1000 }).catch(() => "");
    for (const line of lines.split("\n")) if (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(line.trim())) links.add(line.trim());
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(500);
  }
  const text = (await header.innerText({ timeout: 2000 }).catch(() => "")).split("\n");
  // Bio, "Follow/Takip et" düğmelerinden öncesidir (sonrası öne çıkanlar).
  const stop = text.findIndex((l) => /^(Follow|Following|Takip et|Takiptesin|Message|Mesaj gönder|Mesaj)$/i.test(l.trim()));
  const bio = (stop > 0 ? text.slice(0, stop) : text)
    .filter((l) => !/(takip ediyor|followed by)/i.test(l))
    .join("\n")
    .trim()
    .slice(0, 1500);
  return { bio, links: [...links].filter(Boolean) };
}

/** Keşifte: profili bir kez açıp okur (DM'deki profil ziyaretiyle aynı yol). */
export async function visitProfileInfo(page: Page, handle: string): Promise<ProfileInfo | null> {
  await ensureOnInstagram(page);
  await page.goto(`${IG}/${handle}/`, { waitUntil: "domcontentloaded" });
  await sleep(3000);
  await assertNotBlocked(page, "profil okunurken");
  return readProfileInfo(page);
}

// ─── Threads (Instagram'dan gitmeyen mesaj, kullanıcı 2026-10-23) ─────────────
// threads.com/@kullanıcı → "Message" → threads.com/messages/t/… sohbeti;
// yazı kutusu Instagram'ınkiyle aynı. Takipleşilmeyen kişiye "mesaj isteği"
// gider ve kabul edilene kadar en çok 3 mesaj atılabilir (2026-10-23 bakıldı).
// Oturum: uygulamanın Chrome profilinde Threads'e bir kez girilir.

const THREADS = "https://www.threads.com";

export async function sendThreadsDm(page: Page, handle: string, text: string): Promise<void> {
  if (splitForDm(text).length > 3) throw new Error("Mesaj Threads'in 3 mesajlık istek sınırına sığmıyor.");
  await page.goto(`${THREADS}/@${handle}`, { waitUntil: "domcontentloaded" });
  await sleep(3000);
  if (/\/login/.test(page.url())) {
    throw new Error('Threads oturumu yok — Ayarlar → "Threads\'e giriş" ile bir kez giriş yap.');
  }
  await assertNotBlocked(page, "Threads profili açılırken");
  if (await page.getByText(/^(Profile isn't available|Profil kullanılamıyor|This profile is private)/i).count()) {
    throw new DmClosedError(`Threads'te @${handle} profili yok ya da açık değil.`);
  }
  const messageButton = page
    .getByRole("button", { name: /^(Message|Mesaj|Mesaj gönder)$/i })
    .first();
  if ((await messageButton.count()) === 0) {
    const shot = await snapshot(page, "threads-no-message-button");
    throw new DmClosedError(`Threads'te "Message" düğmesi yok (hesap yok ya da mesaja kapalı). Ekran: ${shot}`);
  }
  await messageButton.click();
  await page.waitForURL(/\/messages\//, { timeout: 15000 }).catch(() => {});
  const box = page.locator('div[role="textbox"][contenteditable="true"]').last();
  await box.waitFor({ state: "visible", timeout: 20000 });
  await typeAndVerify(page, box, text);
}
