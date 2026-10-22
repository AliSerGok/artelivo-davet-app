import type { Page } from "playwright";

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
): Promise<void> {
  await ensureOnInstagram(page);
  await page.goto(`${IG}/${handle}/`, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  await assertNotBlocked(page, "profil açılırken");

  const messageButton = page
    .getByRole("button", { name: /^(Mesaj gönder|Mesaj|Message)$/i })
    .or(page.getByRole("link", { name: /^(Mesaj gönder|Mesaj|Message)$/i }))
    .first();
  if ((await messageButton.count()) === 0) {
    const shot = await snapshot(page, "no-message-button");
    throw new Error(
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
