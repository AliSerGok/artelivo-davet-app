import type { Page } from "playwright";

import {
  addEmail,
  addLink,
  addPhone,
  type Contacts,
  hostOf,
  linkLabel,
  isAggregator,
  normalizeUrl,
  recordOnly,
  urlKey,
} from "../contacts/index.js";
import { sleep } from "../lib/browser.js";

// ============================================================================
// Bağlantı keşfi (kullanıcı, 2026-10-23): Saatchi'deki ve Instagram bio'sundaki
// linklerden yola çıkıp e-posta ve yeni linkler arar.
//   derinlik 1: başlangıç linkleri (site, link sayfası)
//   derinlik 2: link sayfasındaki siteler; her sitenin iletişim/hakkında alt
//               sayfaları kendi derinliğinde sayılır
// Sanatçı başına en çok MAX_PAGES sayfa. Sosyal ağlar ve platformlar açılmaz,
// yalnız link olarak kaydedilir. Önce düz HTTP; boş dönen (JS ile çizilen)
// sayfa tarayıcıda açılır.
// ============================================================================

export const MAX_PAGES = 15;
const MAX_DEPTH = 2;
const SUBPAGES_PER_SITE = 4;
const FETCH_TIMEOUT_MS = 12_000;
const MAX_HTML = 1_500_000;

const SUBPAGE =
  /(contact|kontakt|iletisim|ileti%C5%9Fim|iletişim|about|hakkimda|hakk%C4%B1mda|hakkımda|bio|cv|impressum|info|contatto|contacto|biography|biyografi|ozgecmis|özgeçmiş)/i;

export interface CrawlResult {
  emails: Array<{ value: string; from: string }>;
  phones: Array<{ value: string; from: string }>;
  links: Array<{ url: string; from: string }>;
  pages: number;
}

interface Item {
  url: string;
  depth: number;
  /** Alt sayfa mı (iletişim/hakkında): ondan yeni alt sayfa açılmaz. */
  sub: boolean;
}

/** Adresin kısa adı: "ayseart.com/iletisim". */
export function placeOf(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.hostname.replace(/^www\./, "")}${path}`.slice(0, 80);
  } catch {
    return url.slice(0, 80);
  }
}

/**
 * `ident`: sanatçının ad parçaları ve kullanıcı adları. Bir sitede (link
 * sayfası değil) bulunan sosyal linkler yalnız bunlardan birini taşıyorsa
 * kaydedilir — mağaza/platform sayfasının kendi hesapları sanatçınınki değil
 * (2026-10-23: Shopier sayfasındaki Shopier Instagram'ı).
 */
/** Link sanatçının adını ya da kullanıcı adını taşıyor mu. */
export function ownedBy(ident: string[]) {
  return (url: string) => {
    const flat = url.toLowerCase().replace(/[^a-z0-9]/g, "");
    // 3 harflik ad parçaları ("ali", "can") her adreste geçer: en az 4.
    return ident.some((t) => t.length >= 4 && flat.includes(t.replace(/[^a-z0-9]/g, "")));
  };
}

export async function crawl(
  seeds: string[],
  browserPage: () => Promise<Page>,
  ident: string[],
  maxPages = MAX_PAGES,
): Promise<CrawlResult> {
  const owned = ownedBy(ident);
  const out: CrawlResult = { emails: [], phones: [], links: [], pages: 0 };
  const seen = new Set<string>();
  const subCount = new Map<string, number>();
  const queue: Item[] = [];
  const push = (url: string, depth: number, sub: boolean) => {
    const clean = normalizeUrl(url);
    if (!clean) return;
    const key = urlKey(clean);
    if (seen.has(key)) return;
    seen.add(key);
    queue.push({ url: clean, depth, sub });
  };
  for (const s of seeds) push(s, 1, false);

  while (queue.length && out.pages < maxPages) {
    // Önce sığ olanlar: başlangıç linkleri ve onların alt sayfaları.
    queue.sort((a, b) => a.depth - b.depth);
    const item = queue.shift()!;
    if (recordOnly(item.url)) continue;
    const html = await fetchHtml(item.url, browserPage);
    out.pages++;
    if (!html) continue;
    const from = placeOf(item.url);
    for (const value of extractEmails(html)) out.emails.push({ value, from });
    for (const value of extractPhones(html)) out.phones.push({ value, from });
    const host = hostOf(item.url);
    for (const href of extractLinks(html, item.url)) {
      const h = hostOf(href);
      if (!h) continue;
      if (h === host) {
        // Aynı sitenin iletişim/hakkında sayfaları (link sayfasının kendi
        // alt sayfaları değil).
        if (item.sub || isAggregator(item.url) || !SUBPAGE.test(new URL(href).pathname)) continue;
        const n = subCount.get(host) ?? 0;
        if (n >= SUBPAGES_PER_SITE) continue;
        subCount.set(host, n + 1);
        push(href, item.depth, true);
        continue;
      }
      // Kayda: link sayfasındaki her şey (sanatçının kendi seçtikleri); bir
      // sitede yalnız tanınan platformlar (basın, tema, CDN linkleri değil).
      // WhatsApp/Telegram iletişim kanalıdır: sanatçının kendi sayfasında ad
      // taşımasa da kaydedilir (wa.me/90532…).
      const channel = ["WhatsApp", "Telegram"].includes(linkLabel(href));
      if (isAggregator(item.url) || channel || ((recordOnly(href) || isAggregator(href)) && owned(href)))
        out.links.push({ url: href, from });
      // Başka siteye: yalnız link sayfasından ya da başlangıç sayfasından
      // bir link sayfasına geçilir (sitedeki basın/galeri linkleri açılmaz).
      if (item.depth >= MAX_DEPTH || recordOnly(href)) continue;
      if (isAggregator(item.url) || (isAggregator(href) && owned(href))) push(href, item.depth + 1, false);
    }
  }
  return out;
}

export async function fetchHtml(url: string, browserPage: () => Promise<Page>): Promise<string | null> {
  let html: string | null = null;
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
        "accept-language": "tr-TR,tr;q=0.9,en;q=0.8",
      },
    });
    if (res.ok && /html/i.test(res.headers.get("content-type") ?? "")) {
      html = (await res.text()).slice(0, MAX_HTML);
    }
  } catch {
    // zaman aşımı, sertifika, DNS: tarayıcı dener
  }
  if (html && visibleText(html).length > 150) return html;
  // JS ile çizilen sayfa ya da HTTP'yi reddeden site: uygulamanın tarayıcısı.
  try {
    const page = await browserPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await sleep(2500);
    return (await page.content()).slice(0, MAX_HTML);
  } catch {
    return html;
  }
}

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&commat;/gi, "@")
    .replace(/&period;/gi, ".")
    .replace(/&amp;/gi, "&")
    .replace(/\\u0040/gi, "@")
    .replace(/\\u002e/gi, ".");
}

/** Cloudflare'in gizlediği adres: ilk bayt anahtar, kalanlar XOR. */
function decodeCfEmail(hex: string): string | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 4) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

const EMAIL = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/gi;
// "ad [at] alan [dot] com", "ad(at)alan(dot)com", "ad {et} alan {nokta} com"
const OBFUSCATED =
  /([a-z0-9][a-z0-9._%+-]*)\s*[[({]\s*(?:at|et|@)\s*[\])}]\s*([a-z0-9-]+(?:\s*[[({]\s*(?:dot|nokta|\.)\s*[\])}]\s*[a-z0-9-]+)+)/gi;

const BAD_DOMAIN =
  /(pinterest\.|tiktok\.com$|behance\.net$|adobe\.com$|threads\.(net|com)$|meta\.com$|fb\.com$|youtube\.com$|etsy\.com$|artsy\.net$|vimeo\.com$|telegram\.org$|example\.|domain\.com$|yourdomain|sentry|wixpress\.com$|wix\.com$|squarespace\.com$|godaddy|w3\.org$|schema\.org$|linktr\.ee$|beacons\.ai$|saatchiart\.com$|instagram\.com$|facebook\.com$|cloudflare|jquery|gravatar|wordpress\.(com|org)$|shopify\.com$|sentry\.io$|mysite\.com$|email\.com$)/i;
const BAD_LOCAL = /^(no-?reply|donotreply|privacy|abuse|postmaster|webmaster|hostmaster|admin|root|user|name|email|your-?email|example)$/i;
const FILE_TLD = /\.(png|jpe?g|gif|webp|svg|css|js|ico|mp4|pdf)$/i;

export function extractEmails(rawHtml: string): string[] {
  const html = decodeEntities(rawHtml);
  const found = new Set<string>();
  const add = (e: string) => {
    const v = decodeURIComponent(e.replace(/^mailto:/i, "").split("?")[0] ?? "")
      .trim()
      .replace(/\.+$/, "")
      .toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/.test(v)) return;
    const [local = "", domain = ""] = v.split("@");
    if (FILE_TLD.test(v) || BAD_DOMAIN.test(domain) || BAD_LOCAL.test(local)) return;
    // "logo@2x.png" vb. dışında "u003e"/"x40" gibi kaçış artıkları
    if (/^(u00|x40)/.test(local)) return;
    found.add(v);
  };
  for (const m of html.matchAll(/mailto:([^"'<>\s]+)/gi)) add(m[1] ?? "");
  for (const m of html.matchAll(/data-cfemail="([0-9a-f]+)"/gi)) {
    const e = decodeCfEmail(m[1] ?? "");
    if (e) add(e);
  }
  for (const m of html.matchAll(/email-protection#([0-9a-f]+)/gi)) {
    const e = decodeCfEmail(m[1] ?? "");
    if (e) add(e);
  }
  const text = visibleText(html);
  for (const m of text.matchAll(EMAIL)) add(m[0]);
  for (const m of text.matchAll(OBFUSCATED)) {
    const domain = (m[2] ?? "").replace(/\s*[[({]\s*(?:dot|nokta|\.)\s*[\])}]\s*/gi, ".");
    add(`${m[1]}@${domain}`);
  }
  return [...found];
}

// +90 532 123 45 67 · 0532 123 45 67 · 00 7 912 … · (0212) 123 45 67
const PHONE = /(?<![\w+/=.-])(?:(?:\+|00)\d{1,3}[\s.-]?)?\(?0?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}(?![\w/-])/g;

/** Metindeki telefonlar: `tel:` linkleri ve + ya da 0 ile başlayan 10–15 haneli numaralar. */
export function extractPhones(rawHtml: string): string[] {
  const html = decodeEntities(rawHtml);
  const found = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["']tel:([^"']+)["']/gi)) found.add(decodeURIComponent(m[1] ?? "").trim());
  for (const m of visibleText(html).matchAll(PHONE)) {
    const v = m[0].trim();
    // Kimlik/sayaç gibi düz rakam dizileri değil: + ya da 0 ile başlar.
    if (/^(\+|00|0|\(0)/.test(v)) found.add(v);
  }
  return [...found].filter((v) => {
    const d = v.replace(/\D/g, "");
    return d.length >= 10 && d.length <= 15;
  });
}

export function extractLinks(html: string, base: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"'#][^"']*)["']/gi)) {
    const href = decodeEntities(m[1] ?? "").trim();
    if (/^(javascript:|tel:|data:)/i.test(href)) continue;
    if (/^mailto:/i.test(href)) continue;
    try {
      const u = new URL(href, base);
      if (!/^https?:$/.test(u.protocol)) continue;
      if (/\.(png|jpe?g|gif|webp|svg|css|js|ico|pdf|mp4|xml|json|woff2?)$/i.test(u.pathname)) continue;
      // Paylaş düğmeleri sanatçının hesabı değil.
      if (/sharer|\/share|intent\/(tweet|post)|pin\/create|shareArticle|\/dialog\//i.test(u.pathname + u.search)) continue;
      const clean = normalizeUrl(u.toString());
      if (clean) out.add(clean);
    } catch {
      // bozuk adres
    }
  }
  return [...out];
}

/** Instagram profilinden okunan bio ve linkleri kayda ekler. */
export function applyIgInfo(
  c: Contacts,
  info: { bio: string; links: string[] },
  name: string,
): void {
  c.igBio = info.bio || c.igBio;
  c.igChecked = true;
  for (const e of extractEmails(info.bio)) addEmail(c, e, "Instagram bio", name, true);
  for (const p of extractPhones(info.bio.replace(/</g, " "))) addPhone(c, p, "Instagram bio");
  for (const url of info.links) addLink(c, url, "Instagram bio");
  // Bio'da düz yazılmış alan adları ("ayseart.com", "linktr.ee/ayse"). "X
  // takip ediyor" satırı kullanıcı adıdır, alan adı değil ("zeynep.artstudio"
  // → "zeynep.art" sanılıyordu, 2026-10-23).
  const bio = info.bio
    .split("\n")
    .filter((l) => !/(takip ediyor|followed by)/i.test(l))
    .join("\n");
  for (const m of bio.matchAll(
    /(?<![@\w.])(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com(?:\.tr)?|net|org|art|studio|gallery|co|io|me|ee|bio|site|page|link|xyz|info|design|ai|cc|to)(?![\w-])(?:\/[^\s)]*)?/gi,
  ))
    addLink(c, m[0], "Instagram bio");
}

// ─── Facebook iletişim bilgisi (2026-10-23) ─────────────────────────────────
// Sanatçıların Facebook SAYFASINDA e-posta sık yazılır ("Hakkında → İletişim
// bilgileri"; Oya Bilgin: Shopier ve linktree'de yok, Facebook sayfasında var).
// Düz HTTP 400 döner; uygulamanın tarayıcısında açılır. Oturum yoksa Facebook
// giriş ister: `loginWall` döner, keşif sürer.

export async function readFacebookContact(
  page: Page,
  url: string,
): Promise<{ emails: string[]; phones: string[]; links: string[]; loginWall: boolean }> {
  const out = { emails: [] as string[], phones: [] as string[], links: [] as string[], loginWall: false };
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await sleep(3000);
  const wall = async () =>
    /\/(login|checkpoint)/.test(page.url()) || (await page.locator('input[name="pass"]').count()) > 0;
  if (await wall()) return { ...out, loginWall: true };
  // Sayı ile verilen sayfa adlı adrese yönlenir; iletişim sekmesi onun altında.
  const u = new URL(page.url());
  const contact =
    u.pathname === "/profile.php"
      ? `${u.origin}/profile.php?id=${u.searchParams.get("id") ?? ""}&sk=about_contact_and_basic_info`
      : `${u.origin}/${u.pathname.split("/").filter(Boolean)[0] ?? ""}/about_contact_and_basic_info`;
  await page.goto(contact, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await sleep(3500);
  if (await wall()) return { ...out, loginWall: true };
  const main = page.locator('[role="main"]').first();
  const text = await main.innerText({ timeout: 3000 }).catch(() => "");
  out.emails = extractEmails(text.replace(/</g, " "));
  out.phones = extractPhones(text.replace(/</g, " "));
  // İletişim bölümündeki dış linkler (l.facebook.com sarmalı açılır).
  const hrefs = await main
    .locator('a[href*="l.facebook.com"]')
    .evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href))
    .catch(() => [] as string[]);
  out.links = hrefs.map((h) => normalizeUrl(h)).filter((x): x is string => Boolean(x));
  return out;
}

// ─── Platform profilleri (2026-10-23) ───────────────────────────────────────
// Sanatçının kendi verdiği platform linkleri açılıp incelenir. Pinterest'in
// herkese açık profil verisi iletişim seçeneklerini taşır (contact_email,
// contact_phone, website_url; girişsiz). Diğerleri (Threads, TikTok, YouTube,
// Behance…) sayfa olarak açılır: e-posta ve sanatçıya ait linkler.

export interface PlatformResult {
  emails: string[];
  phones: string[];
  links: string[];
}

/** pinterest.com/<ad>/ ya da pin.it kısa linki → kullanıcı adı. */
async function pinterestUser(url: string): Promise<string | null> {
  let final = url;
  if (/pin\.it$/i.test(hostOf(url))) {
    final = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      .then((r) => r.url)
      .catch(() => url);
  }
  try {
    const seg = new URL(final).pathname.split("/").filter(Boolean)[0] ?? "";
    return /^[A-Za-z0-9_.-]{2,40}$/.test(seg) && !/^(pin|search|ideas|_)/.test(seg) ? seg : null;
  } catch {
    return null;
  }
}

export async function readPinterest(url: string): Promise<PlatformResult | null> {
  const user = await pinterestUser(url);
  if (!user) return null;
  const data = encodeURIComponent(JSON.stringify({ options: { username: user, field_set_key: "profile" } }));
  const res = await fetch(
    `https://www.pinterest.com/resource/UserResource/get/?source_url=%2F${encodeURIComponent(user)}%2F&data=${data}`,
    {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
        "x-pinterest-pws-handler": "www/[username].js",
        accept: "application/json",
      },
    },
  ).catch(() => null);
  if (!res?.ok) return null;
  const json = (await res.json().catch(() => null)) as { resource_response?: { data?: Record<string, unknown> } } | null;
  const d = json?.resource_response?.data;
  if (!d) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  // İletişim seçenekleri iş hesabında `partner` altında (2026-10-23 bakıldı).
  const partner = (d.partner && typeof d.partner === "object" ? d.partner : {}) as Record<string, unknown>;
  const emails = new Set<string>();
  for (const v of [partner.contact_email, d.contact_email])
    if (str(v).includes("@")) emails.add(str(v).trim().toLowerCase());
  for (const e of extractEmails(str(d.about).replace(/</g, " "))) emails.add(e);
  const phone = str(partner.contact_phone) || str(d.contact_phone);
  return {
    emails: [...emails],
    phones: phone ? [phone] : [],
    links: [str(d.website_url), str(d.domain_url)].filter((u) => /^https?:\/\//i.test(u)),
  };
}

/** Pinterest/Facebook dışındaki platform sayfası: e-postalar ve sanatçıya ait linkler. */
export async function readPlatformPage(
  url: string,
  browserPage: () => Promise<Page>,
  ident: string[],
): Promise<PlatformResult | null> {
  const html = await fetchHtml(url, browserPage);
  if (!html) return null;
  const owned = ownedBy(ident);
  return {
    emails: extractEmails(html),
    phones: extractPhones(html),
    links: extractLinks(html, url).filter((l) => hostOf(l) !== hostOf(url) && owned(l)),
  };
}
