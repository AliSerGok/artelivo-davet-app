import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { type BrowserContext, chromium, type Page } from "playwright";

import { config } from "../config.js";

// ============================================================================
// Tek Chrome: uygulamanın KENDİ profili (data/chrome-profile).
// ----------------------------------------------------------------------------
// ⚠️ Ana Chrome profiline otomasyon bağlanamaz (Chrome 136+ uzaktan
// hata ayıklamayı varsayılan profilde reddeder). Bu yüzden Instagram'a bu
// pencerede BİR KEZ giriş yapılır (Ayarlar → "Instagram'a giriş"); oturum
// profilde kalır. Ana tarayıcın hiç etkilenmez.
// ============================================================================

let contextPromise: Promise<BrowserContext> | null = null;

/**
 * Chrome'un çeviri balonu ("Turkish / English") açılınca odağı çalıyor ve
 * Instagram arama kutusuna yazılanlar balona gidiyor (2026-10-19). Profilde
 * çeviriyi kapat. Chrome kapalıyken yazılmalı: açıkken dosyayı kendisi ezer.
 */
function disableTranslate(): void {
  const dir = path.join(config.chromeProfileDir, "Default");
  const file = path.join(dir, "Preferences");
  try {
    mkdirSync(dir, { recursive: true });
    const prefs = existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)
      : {};
    const translate = (prefs.translate ?? {}) as Record<string, unknown>;
    if (translate.enabled === false) return;
    prefs.translate = { ...translate, enabled: false };
    writeFileSync(file, JSON.stringify(prefs));
  } catch (error) {
    console.warn("Chrome çeviri ayarı yazılamadı:", error);
  }
}

export async function browser(): Promise<BrowserContext> {
  if (!contextPromise) {
    disableTranslate();
    contextPromise = chromium
      .launchPersistentContext(config.chromeProfileDir, {
        channel: "chrome",
        headless: false,
        viewport: null,
        locale: "tr-TR",
        args: [
          "--no-first-run",
          "--no-default-browser-check",
          // Arayüz dili Türkçe: Türkçe sayfalarda çeviri önerisi hiç çıkmaz.
          "--lang=tr-TR",
        ],
      })
      .then((context) => {
        context.on("close", () => {
          contextPromise = null;
        });
        return context;
      })
      .catch((error: unknown) => {
        contextPromise = null;
        throw error;
      });
  }
  return contextPromise;
}

/** Kapanışta: tarayıcı açıksa kapatır, AÇIK DEĞİLSE başlatmaz. 5 sn'de vazgeçer. */
export async function closeBrowserIfOpen(): Promise<void> {
  if (!contextPromise) return;
  const context = await contextPromise.catch(() => null);
  if (!context) return;
  await Promise.race([
    context.close().catch(() => {}),
    sleep(5000),
  ]);
}

/** Arka plan işleri için tek, yeniden kullanılan sekme. */
let workPage: Page | null = null;
export async function workTab(): Promise<Page> {
  const context = await browser();
  if (workPage && !workPage.isClosed()) return workPage;
  workPage = context.pages()[0] ?? (await context.newPage());
  return workPage;
}

/**
 * Onay penceresinin kendi açıcı sekmesi — arka plan işlerinin sekmesine
 * (workTab) hiç dokunmaz; iş sürerken de onay penceresi açılabilir.
 */
let openerPage: Page | null = null;
async function reviewOpener(): Promise<Page> {
  const context = await browser();
  if (openerPage && !openerPage.isClosed()) return openerPage;
  openerPage = await context.newPage();
  return openerPage;
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** min–max saniye arası rastgele bekleme — insan hızında gezinmek için. */
export function randomPause(minSec: number, maxSec: number): Promise<void> {
  const lo = Math.max(0, Math.min(minSec, maxSec));
  const hi = Math.max(minSec, maxSec);
  return sleep((lo + Math.random() * (hi - lo)) * 1000);
}

/**
 * Hata ekran görüntüleri bir haftadan eski olunca silinir (kişi bilgisi
 * taşıyabilir: bir profil, bir sohbet). Uygulama açılırken çağrılır.
 */
export function pruneScreenshots(maxAgeDays = 7): void {
  const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
  for (const name of readdirSync(config.screenshotsDir)) {
    const file = path.join(config.screenshotsDir, name);
    try {
      if (statSync(file).mtimeMs < cutoff) rmSync(file);
    } catch {
      // yarışta silinmiş olabilir
    }
  }
}

/** Bir hata anının ekran görüntüsü — log'da yolu yazılır. Adında kişi bilgisi yok. */
export async function snapshot(page: Page, label: string): Promise<string> {
  const file = path.join(
    config.screenshotsDir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${label.replace(/[^\w-]+/g, "_")}.png`,
  );
  await page.screenshot({ path: file }).catch(() => {});
  return file;
}

// ─── Bölünmüş ekran ─────────────────────────────────────────────────────────

/** Yeni bir PENCERE (sekme değil) açar. */
async function openWindow(url: string): Promise<Page> {
  const context = await browser();
  const opener = await reviewOpener();
  const [page] = await Promise.all([
    context.waitForEvent("page"),
    opener.evaluate((target) => {
      window.open(target, "_blank", "popup=yes,width=900,height=900");
    }, url),
  ]);
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  return page;
}

async function placeWindow(
  page: Page,
  bounds: { left: number; top: number; width: number; height: number },
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as {
      windowId: number;
    };
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "normal" },
    });
    await cdp.send("Browser.setWindowBounds", { windowId, bounds });
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/**
 * Yönetim arayüzü uygulamanın KENDİ Chrome'unda ayrı bir pencere: Terminal
 * kapanınca (SIGHUP → closeBrowserIfOpen) o da kapanır (kullanıcı,
 * 2026-10-19). Ana tarayıcıda bir sekme olsaydı kapatılamazdı.
 */
let uiPage: Page | null = null;

/** Pencere işlemleri (CDP) asla akışı kilitlemesin: en çok `ms` bekle. */
function capped<T>(work: Promise<T>, ms = 5000): Promise<T | undefined> {
  return Promise.race([
    work.catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}

export async function openUiWindow(url: string): Promise<Page> {
  const opener = await reviewOpener();
  const screen = await opener.evaluate(() => ({
    width: window.screen.availWidth,
    height: window.screen.availHeight,
    top: (window.screen as Screen & { availTop?: number }).availTop ?? 0,
    left: (window.screen as Screen & { availLeft?: number }).availLeft ?? 0,
  }));
  const page = await openWindow(url);
  const width = Math.min(1280, screen.width);
  const height = Math.min(900, screen.height);
  await placeWindow(page, {
    left: screen.left + Math.floor((screen.width - width) / 2),
    top: screen.top + Math.floor((screen.height - height) / 2),
    width,
    height,
  });
  // about:blank sekmeli ana pencere görünmesin.
  await minimizeWindow(opener);
  await page.bringToFront().catch(() => {});
  uiPage = page;
  return page;
}

async function restoreWindow(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as {
      windowId: number;
    };
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "normal" },
    });
  } catch {
    // Geri getirilemezse kullanıcı Dock'tan açar.
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function minimizeWindow(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as {
      windowId: number;
    };
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "minimized" },
    });
  } catch {
    // Küçültülemezse yalnız görünüş meselesi.
  } finally {
    await cdp.detach().catch(() => {});
  }
}

export interface SplitView {
  left: Page;
  right: Page;
  close(): Promise<void>;
}

/** Ekranı ikiye böler: solda `leftUrl`, sağda `rightUrl`. */
export async function openSplit(
  leftUrl: string,
  rightUrl: string | null,
): Promise<SplitView> {
  const opener = await reviewOpener();
  const screen = await opener.evaluate(() => ({
    width: window.screen.availWidth,
    height: window.screen.availHeight,
    top: (window.screen as Screen & { availTop?: number }).availTop ?? 0,
    left: (window.screen as Screen & { availLeft?: number }).availLeft ?? 0,
  }));
  // Instagram (sağ) yarıdan %20 geniş: dar pencerede arama sonuç listesini
  // göstermiyor (kullanıcı, 2026-10-19). Sol %40, sağ %60.
  const half = Math.floor(screen.width * 0.4);
  const left = await openWindow(leftUrl);
  const right = await openWindow(rightUrl ?? "about:blank");
  await capped(placeWindow(left, {
    left: screen.left,
    top: screen.top,
    width: half,
    height: screen.height,
  }));
  await capped(placeWindow(right, {
    left: screen.left + half,
    top: screen.top,
    width: screen.width - half,
    height: screen.height,
  }));
  // Açıcı sekme (ve arka plan sekmesi) aynı ana penceredeki about:blank'ler:
  // kullanıcıya fazladan boş pencere olarak görünmesin diye simge durumuna
  // küçültülür (2026-10-19). İşler küçültülmüş pencerede de çalışır.
  await capped(minimizeWindow(opener));
  // Yönetim penceresi ekranın ortasında, bölünmüş pencerelerin ÜSTÜNDE
  // kalıyor ve sol penceredeki düğmeleri örtüyordu (2026-10-19): onay
  // sürerken küçült, bitince geri getir.
  const ui = uiPage && !uiPage.isClosed() ? uiPage : null;
  if (ui) await capped(minimizeWindow(ui));
  await capped(left.bringToFront());
  await capped(right.bringToFront());
  return {
    left,
    right,
    async close() {
      await Promise.allSettled([left.close(), right.close()]);
      if (ui && !ui.isClosed()) {
        await capped(restoreWindow(ui));
        await capped(ui.bringToFront());
      }
    },
  };
}
