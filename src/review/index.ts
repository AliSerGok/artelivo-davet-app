import { randomBytes } from "node:crypto";

import type { Page } from "playwright";

import { db, logEvent, markSeen } from "../db/index.js";
import { openSplit, type SplitView } from "../lib/browser.js";

// ============================================================================
// Onay ekranı: solda kaynak profili, sağda Instagram adayı — ekran ikiye
// bölünmüş. Kontrol çubuğu sol pencerenin altına yerleşir:
//   Onayla (A) · Reddet (R) · Diğer profil (D) · Geç (G) · elle kullanıcı adı
// Onay/red → iki pencere kapanır, sıradakinin iki penceresi açılır.
// ============================================================================

interface ReviewCandidate {
  id: number;
  run_id: number;
  source: string;
  name: string;
  source_url: string;
  city: string | null;
  works_count: number | null;
}
interface IgRow {
  handle: string;
  full_name: string | null;
  bio: string | null;
  followers: number | null;
  from_source: number;
  score: number | null;
  reason: string | null;
}

interface Session {
  runId: number;
  view: SplitView | null;
  candidate: ReviewCandidate | null;
  igs: IgRow[];
  index: number;
  skipped: Set<number>;
  busy: boolean;
  /** Kontrol çubuğunun düğmelerini sayfanın kendi betiklerinden ayıran sır. */
  key: string;
}

let session: Session | null = null;

export function reviewStatus(): { active: boolean; runId: number | null } {
  return { active: Boolean(session), runId: session?.runId ?? null };
}

function nextCandidate(s: Session): ReviewCandidate | null {
  const rows = db
    .prepare(
      `SELECT id, run_id, source, name, source_url, city, works_count FROM candidates
       WHERE run_id = ? AND status = 'ready' ORDER BY id`,
    )
    .all(s.runId) as ReviewCandidate[];
  return rows.find((r) => !s.skipped.has(r.id)) ?? null;
}

function igsOf(candidateId: number): IgRow[] {
  return db
    .prepare(
      `SELECT handle, full_name, bio, followers, from_source, score, reason FROM ig_candidates
       WHERE candidate_id = ? ORDER BY from_source DESC, COALESCE(score, -1) DESC`,
    )
    .all(candidateId) as IgRow[];
}

const igUrl = (handle: string) => `https://www.instagram.com/${handle}/`;

/** instagram.com/<kullanıcı>/ → kullanıcı; gönderi/arama/ana sayfa → null. */
function handleFromUrl(url: string): string | null {
  const m =
    /^https:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:[?#].*)?$/.exec(
      url,
    );
  const handle = m?.[1]?.toLowerCase();
  if (
    !handle ||
    /^(p|reel|reels|tv|stories|explore|accounts|direct)$/.test(handle)
  ) {
    return null;
  }
  return handle;
}

/** Instagram'ın arama kutusunu açıp adı yazar — en iyi çaba, olmazsa sayfa kalır. */
async function openInstagramSearch(page: Page, name: string): Promise<void> {
  // Instagram'ın arama kutusunun (input) üstüne bir "Ara" DÜĞMESİ serili
  // (2026-10-19, DOM'da görüldü). Playwright'ın locator.click()'i "başka öğe
  // tıklamayı alıyor" diye bekleyip vazgeçiyordu. Gerçek kullanıcı gibi o
  // NOKTAYA fare tıklaması: düğme kutuyu odaklar; sonra klavyeyle yazılır.
  // Kutu yoksa (dar düzen) önce soldaki "Ara" simgesi tıklanır.
  const tried: string[] = [];
  const box = () =>
    page
      .locator(
        'input[aria-label="Search input"], input[aria-label="Arama girdisi"], input[placeholder="Ara"], input[placeholder="Search"]',
      )
      .filter({ visible: true })
      .first();
  try {
    await page.waitForLoadState("domcontentloaded");
    await page.evaluate("window.__name = window.__name || ((fn) => fn)").catch(() => {});
    await page.bringToFront().catch(() => {});
    let input = box();
    if (!(await input.isVisible({ timeout: 0 }).catch(() => false))) {
      await input.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    }
    if (!(await input.isVisible().catch(() => false))) {
      tried.push("kutu:yok");
      const link = page
        .getByRole("link", { name: /^(Ara|Search)$/i })
        .filter({ visible: true })
        .first();
      const lb = await link.boundingBox().catch(() => null);
      if (!lb) throw new Error("ne kutu ne Ara bağlantısı görünüyor");
      await page.mouse.click(lb.x + lb.width / 2, lb.y + lb.height / 2);
      input = box();
      await input.waitFor({ state: "visible", timeout: 5000 });
    }
    const bb = await input.boundingBox();
    if (!bb) throw new Error("kutunun yeri okunamadı");
    await page.bringToFront().catch(() => {});
    await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.waitForTimeout(500);
    if (!(await focusIsTextField(page))) {
      tried.push("odak-yok");
      await input.focus().catch(() => {});
    }
    await page.keyboard.type(name, { delay: 90 });
    const value = await input.inputValue().catch(() => "");
    if (!value.includes(name)) {
      throw new Error(`yazı kutuya düşmedi (kutuda ${value.length} karakter)`);
    }
    logEvent("review_step", { step: "instagram araması yazıldı" });
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.warn("Instagram araması açılamadı:", message, tried.join(" "));
    logEvent("ig_search_box_failed", {
      url: page.url(),
      message,
      tried: tried.join(" "),
      inputs: await visibleInputs(page),
    });
  }
}

async function focusIsTextField(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      return (
        (el.tagName === "INPUT" &&
          ["text", "search", ""].includes((el as HTMLInputElement).type)) ||
        el.isContentEditable
      );
    })
    .catch(() => false);
}

/** Tanı için: görünen input'ların öznitelikleri (içerik değil). */
async function visibleInputs(page: Page): Promise<string> {
  return page
    .evaluate(() =>
      Array.from(document.querySelectorAll("input"))
        .filter((i) => i.offsetParent !== null)
        .map((i) =>
          [i.type, i.getAttribute("placeholder"), i.getAttribute("aria-label")].join("|"),
        )
        .join("; "),
    )
    .catch(() => "?");
}

/** Kontrol çubuğunun bilgisi — sol pencereye her yüklemede basılır. */
function panelState(s: Session) {
  const ig = s.igs[s.index] ?? null;
  const left = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM candidates WHERE run_id = ? AND status = 'ready'",
      )
      .get(s.runId) as { n: number }
  ).n;
  return {
    key: s.key,
    name: s.candidate?.name ?? "",
    meta: [
      s.candidate?.city,
      s.candidate?.works_count ? `${s.candidate.works_count} eser` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    remaining: left,
    total: s.igs.length,
    index: s.index,
    ig: ig
      ? {
          handle: ig.handle,
          fromSource: Boolean(ig.from_source),
          score: ig.score,
          reason: ig.reason,
          followers: ig.followers,
        }
      : null,
  };
}

async function injectPanel(page: Page, s: Session): Promise<void> {
  const state = panelState(s);
  // tsx/esbuild, sayfaya gönderilen fonksiyondaki adlı yardımcıları `__name(...)`
  // ile sarar; o yardımcı sayfada yok. Etkisiz bir karşılığını tanımla.
  await page
    .evaluate("window.__name = window.__name || ((fn) => fn)")
    .catch(() => {});
  await page
    .evaluate((st) => {
      // Ad, bio ve gerekçe dışarıdan gelir: HTML olarak değil, metin olarak bas.
      const esc = (v: unknown) =>
        String(v ?? "").replace(
          /[&<>"']/g,
          (ch) =>
            ({
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;",
            })[ch] ?? ch,
        );
      document.getElementById("davet-panel")?.remove();
      const box = document.createElement("div");
      box.id = "davet-panel";
      box.setAttribute(
        "style",
        "position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483647;background:#1c1917;color:#fafaf9;" +
          "font:14px/1.4 -apple-system,system-ui,sans-serif;border-radius:12px;padding:12px 14px;box-shadow:0 8px 30px rgba(0,0,0,.35)",
      );
      const ig = st.ig;
      const igLine = ig
        ? `<b>@${esc(ig.handle)}</b> ${ig.fromSource ? "· <span style='color:#86efac'>sanatçının kendi yazdığı</span>" : ""}` +
          ` · ${st.index + 1}/${st.total}` +
          (ig.score !== null ? ` · olasılık %${ig.score}` : "") +
          (ig.followers !== null ? ` · ${ig.followers} takipçi` : "") +
          (ig.reason
            ? `<div style="opacity:.8;margin-top:2px">${esc(ig.reason)}</div>`
            : "")
        : "<span style='color:#fca5a5'>Kaynakta Instagram yazmıyor</span> — sağda Instagram araması açık: doğru profile tıkla, sonra <b>Sağdaki profili kullan (U)</b>.";
      const btn = (id: string, label: string, bg: string) =>
        `<button id="${id}" style="border:0;border-radius:8px;padding:8px 12px;font-weight:600;cursor:pointer;background:${bg};color:#fff">${label}</button>`;
      box.innerHTML =
        `<div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">` +
        `<div><b style="font-size:16px">${esc(st.name)}</b> <span style="opacity:.7">${esc(st.meta)}</span></div>` +
        `<div style="opacity:.7">kalan: ${st.remaining}</div></div>` +
        `<div style="margin:6px 0 10px">${igLine}</div>` +
        `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">` +
        (ig ? btn("davet-approve", "Onayla (A)", "#15803d") : "") +
        btn("davet-reject", "Reddet (R)", "#b91c1c") +
        (st.total > 1 ? btn("davet-next", `Diğer profil (D)`, "#44403c") : "") +
        btn("davet-right", "Sağdaki profili kullan (U)", "#15803d") +
        btn("davet-skip", "Geç (G)", "#57534e") +
        `<input id="davet-handle" placeholder="instagram kullanıcı adı" style="flex:1;min-width:160px;border-radius:8px;border:1px solid #57534e;background:#292524;color:#fff;padding:7px 9px">` +
        btn("davet-manual", "Bunu kullan", "#1d4ed8") +
        `</div>`;
      // <html>'e eklenir: sayfa kendi <body>'sini yeniden kursa da çubuk kalır;
      // yine de silinirse saniyede bir geri konur.
      document.documentElement.appendChild(box);
      const holder = window as unknown as { __davetPanelTimer?: number };
      if (holder.__davetPanelTimer)
        window.clearInterval(holder.__davetPanelTimer);
      holder.__davetPanelTimer = window.setInterval(() => {
        if (!document.getElementById("davet-panel")) {
          document.documentElement.appendChild(box);
        }
      }, 1000);
      // Sır, yalnız bu kapanışta (closure) durur; sayfanın kendi betikleri
      // `davetAction`'ı çağırsa da sırrı bilmedikleri için karar veremez.
      const call = (action: string, value?: string) =>
        (
          window as unknown as {
            davetAction: (k: string, a: string, v?: string) => void;
          }
        ).davetAction(st.key, action, value);
      box
        .querySelector("#davet-approve")
        ?.addEventListener("click", () => call("approve"));
      box
        .querySelector("#davet-reject")
        ?.addEventListener("click", () => call("reject"));
      box
        .querySelector("#davet-next")
        ?.addEventListener("click", () => call("next"));
      box
        .querySelector("#davet-skip")
        ?.addEventListener("click", () => call("skip"));
      box
        .querySelector("#davet-right")
        ?.addEventListener("click", () => call("useRight"));
      box.querySelector("#davet-manual")?.addEventListener("click", () => {
        const v = (box.querySelector("#davet-handle") as HTMLInputElement)
          .value;
        call("manual", v);
      });
      const w = window as unknown as { __davetKeys?: boolean };
      if (!w.__davetKeys) {
        w.__davetKeys = true;
        window.addEventListener("keydown", (e) => {
          const t = e.target as HTMLElement | null;
          if (
            t &&
            (t.tagName === "INPUT" ||
              t.tagName === "TEXTAREA" ||
              t.isContentEditable)
          )
            return;
          const map: Record<string, string> = {
            a: "approve",
            r: "reject",
            d: "next",
            g: "skip",
            u: "useRight",
          };
          const action = map[e.key.toLowerCase()];
          if (action) call(action);
        });
      }
    }, state)
    .catch((error: unknown) => {
      console.error("[davet] kontrol çubuğu basılamadı:", error);
    });
}

/** Onay akışının adımları — takılırsa hangi adımda olduğu events'te görünür. */
function trace(step: string, t0: number): void {
  const ms = Date.now() - t0;
  console.log(`[onay] ${step} (${ms} ms)`);
  logEvent("review_step", { step, ms });
}

async function showCurrent(s: Session): Promise<void> {
  const t0 = Date.now();
  s.candidate = nextCandidate(s);
  if (!s.candidate) {
    if (s.view) await s.view.close();
    s.view = null;
    session = null;
    return;
  }
  s.igs = igsOf(s.candidate.id);
  s.index = 0;
  const first = s.igs[0];
  const leftUrl = s.candidate.source_url;
  const rightUrl = first
    ? igUrl(first.handle)
    : "https://www.instagram.com/explore/";

  // Pencereler aday değişince KAPANMAZ, yalnız adres değişir: her adayda iki
  // pencereyi kapatıp yeniden açmak/yerleştirmek vakit kaybıydı (kullanıcı,
  // 2026-10-19). Kullanıcı bir pencereyi kapattıysa ikisi yeniden açılır.
  const view = s.view;
  trace(view ? "aday değişiyor" : "pencereler açılıyor", t0);
  if (view && !view.left.isClosed() && !view.right.isClosed()) {
    await Promise.all([
      view.left.goto(leftUrl, { waitUntil: "domcontentloaded" }).catch(() => {}),
      view.right.goto(rightUrl, { waitUntil: "domcontentloaded" }).catch(() => {}),
    ]);
  } else {
    if (view) await view.close();
    const opened = await openSplit(leftUrl, rightUrl);
    trace("pencereler açıldı", t0);
    s.view = opened;
    // Bağlama ve "load" dinleyicisi sayfa başına BİR KEZ: sonraki adaylarda
    // aynı sayfa kullanılır, dinleyici güncel adayı `s`'ten okur.
    await opened.left.exposeBinding(
      "davetAction",
      (_source, key: string, action: string, value?: string) => {
        if (key !== s.key) return;
        void handleAction(action, value);
      },
    );
    opened.left.on("load", () => void injectPanel(opened.left, s));
  }
  const left = s.view!.left;
  trace("sol sayfa yükleniyor", t0);
  // "load" bazı sayfalarda (reklam/izleme) çok geç gelir: en çok 10 sn bekle;
  // panel geç gelen "load"da zaten yeniden basılır.
  await left.waitForLoadState("load", { timeout: 10_000 }).catch(() => {});
  trace("panel basılıyor", t0);
  await injectPanel(left, s);
  trace("panel basıldı", t0);
  // Aday yoksa: Instagram'ın kendi aramasını sanatçının adıyla aç. Kişi başına
  // tek arama, kullanıcı ekrandayken. EN SONDA: sol pencere yüklenip panel
  // basılırken odağı alıyordu ve sağa yazılan tuşlar kayboluyordu.
  if (!first) void openInstagramSearch(s.view!.right, s.candidate.name);
}

async function decide(
  s: Session,
  approved: boolean,
  handle?: string,
): Promise<void> {
  const c = s.candidate;
  if (!c) return;
  const run = db
    .prepare("SELECT category, country FROM runs WHERE id = ?")
    .get(c.run_id) as { category: string; country: string } | undefined;
  db.transaction(() => {
    if (approved && handle) {
      db.prepare(
        `INSERT INTO artists (source, name, source_url, instagram_url, category, country) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        c.source,
        c.name,
        c.source_url,
        igUrl(handle),
        run?.category ?? null,
        run?.country ?? "TR",
      );
    }
    // Karar verildi: aday satırları silinir, yalnız özet kalır (KVKK).
    markSeen(c.source, c.source_url, approved ? "approved" : "rejected");
    db.prepare("DELETE FROM candidates WHERE id = ?").run(c.id);
  })();
  logEvent(approved ? "review_approved" : "review_rejected", {
    candidate: c.id,
  });
  const remaining = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM candidates WHERE run_id = ? AND status IN ('ready','collected')",
      )
      .get(c.run_id) as { n: number }
  ).n;
  if (remaining === 0) {
    db.prepare(
      "UPDATE runs SET status = 'done', updated_at = datetime('now') WHERE id = ?",
    ).run(c.run_id);
  }
}

async function handleAction(action: string, value?: string): Promise<void> {
  const s = session;
  if (!s || s.busy || !s.view) return;
  s.busy = true;
  try {
    if (action === "next" && s.igs.length > 1) {
      s.index = (s.index + 1) % s.igs.length;
      db.prepare("UPDATE candidates SET ig_index = ? WHERE id = ?").run(
        s.index,
        s.candidate?.id ?? 0,
      );
      const ig = s.igs[s.index];
      if (ig) await s.view.right.goto(igUrl(ig.handle)).catch(() => {});
      await injectPanel(s.view.left, s);
      return;
    }
    if (action === "manual") {
      const handle = (value ?? "")
        .trim()
        .replace(/^@/, "")
        .replace(/^.*instagram\.com\//i, "")
        .replace(/\/.*$/, "")
        .toLowerCase();
      if (!/^[a-z0-9._]{1,30}$/.test(handle)) return;
      s.igs.unshift({
        handle,
        full_name: null,
        bio: null,
        followers: null,
        from_source: 0,
        score: null,
        reason: "elle girildi",
      });
      s.index = 0;
      await s.view.right.goto(igUrl(handle)).catch(() => {});
      await injectPanel(s.view.left, s);
      return;
    }
    if (action === "useRight") {
      // Sağ pencerede açık olan profil — kullanıcı aramadan tıkladı.
      const handle = handleFromUrl(s.view.right.url());
      if (!handle) {
        // Sağda bir profil değil, arama ya da ana sayfa açık.
        await s.view.left
          .evaluate(() => {
            const panel = document.getElementById("davet-panel");
            if (!panel) return;
            let note = panel.querySelector<HTMLElement>("#davet-note");
            if (!note) {
              note = document.createElement("div");
              note.id = "davet-note";
              note.style.cssText = "margin-top:8px;color:#fca5a5";
              panel.appendChild(note);
            }
            note.textContent =
              "Sağda bir Instagram PROFİLİ açık değil — önce aramada doğru kişiye tıkla.";
          })
          .catch(() => {});
        return;
      }
      await decide(s, true, handle);
      await showCurrent(s);
      return;
    }
    if (action === "skip") {
      if (s.candidate) s.skipped.add(s.candidate.id);
      await showCurrent(s);
      return;
    }
    if (action === "approve") {
      const ig = s.igs[s.index];
      if (!ig) return;
      await decide(s, true, ig.handle);
      await showCurrent(s);
      return;
    }
    if (action === "reject") {
      await decide(s, false);
      await showCurrent(s);
    }
  } finally {
    if (session) session.busy = false;
  }
}

export async function startReview(runId: number): Promise<boolean> {
  if (session?.view) await session.view.close();
  session = {
    runId,
    view: null,
    candidate: null,
    igs: [],
    index: 0,
    skipped: new Set(),
    busy: false,
    key: randomBytes(16).toString("hex"),
  };
  await showCurrent(session);
  return Boolean(session);
}

export async function stopReview(): Promise<void> {
  if (session?.view) await session.view.close();
  session = null;
}
