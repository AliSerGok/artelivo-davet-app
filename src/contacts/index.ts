import { db } from "../db/index.js";

// ============================================================================
// Sanatçının iletişim bilgileri (kullanıcı, 2026-10-23): kaynak (Saatchi),
// Instagram bio'su ve oradan gidilen sayfalarda bulunan e-postalar ve linkler.
// `artists.contacts` içinde JSON. Artelivo'ya GİTMEZ; e-posta daveti ve
// bilgi için. Her kaydın nerede bulunduğu (`from`) tutulur.
// ============================================================================

export interface FoundEmail {
  value: string;
  /** Nerede bulundu: "Saatchi", "Instagram bio", "ayseart.com/iletisim"… */
  from: string;
  /** Adres sanatçının adından bir parça taşıyor mu (galeri/kurum adresi ayırmak için). */
  nameMatch: boolean;
}

export interface FoundLink {
  label: string;
  url: string;
  from: string;
}

export interface Contacts {
  emails: FoundEmail[];
  links: FoundLink[];
  /** Sanatçının platformda kendi girdiği telefon (Pinterest iletişim seçenekleri). */
  phones: Array<{ value: string; from: string }>;
  /** Instagram profil başlığının metni (ad, kategori, bio). */
  igBio: string | null;
  /** Instagram profili okundu (onayda ya da keşifte). */
  igChecked: boolean;
  /** Kaynak profili iletişim için okundu. */
  sourceChecked: boolean;
  /** Son keşif zamanı ve açılan sayfa sayısı. */
  discoveredAt: string | null;
  pages: number;
}

const empty = (): Contacts => ({
  emails: [],
  links: [],
  phones: [],
  igBio: null,
  igChecked: false,
  sourceChecked: false,
  discoveredAt: null,
  pages: 0,
});

type Legacy = {
  emails?: Array<string | FoundEmail>;
  website?: string | null;
  socials?: Array<{ label: string; url: string }>;
};

/** Satırdaki JSON → Contacts. İlk sürümün ({ emails: string[], website, socials }) kayıtlarını da okur. */
export function readContacts(raw: string | null | undefined, name = ""): Contacts {
  const c = empty();
  if (!raw) return c;
  let parsed: Partial<Contacts> & Legacy;
  try {
    parsed = JSON.parse(raw) as Partial<Contacts> & Legacy;
  } catch {
    return c;
  }
  for (const e of parsed.emails ?? []) {
    if (typeof e === "string") addEmail(c, e, "Saatchi", name);
    else if (e?.value) c.emails.push(e);
  }
  for (const l of parsed.links ?? []) if (l?.url) c.links.push(l);
  for (const p of parsed.phones ?? []) if (p?.value) c.phones.push(p);
  if (parsed.website) addLink(c, parsed.website, "Saatchi");
  for (const l of parsed.socials ?? []) addLink(c, l.url, "Saatchi");
  c.igBio = parsed.igBio ?? null;
  c.igChecked = Boolean(parsed.igChecked);
  c.sourceChecked = Boolean(parsed.sourceChecked);
  c.discoveredAt = parsed.discoveredAt ?? null;
  c.pages = parsed.pages ?? 0;
  return c;
}

export function saveContacts(artistId: number, c: Contacts): void {
  db.prepare("UPDATE artists SET contacts = ? WHERE id = ?").run(JSON.stringify(c), artistId);
}

/** Ad → karşılaştırma parçaları ("Ayşe Nur Kaya" → ayse, kaya). */
export function nameTokens(name: string): string[] {
  return ascii(name)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

function ascii(s: string): string {
  return s
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .replace(/ş/g, "s")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

export function addEmail(c: Contacts, email: string, from: string, name: string): void {
  const value = email.trim().toLowerCase();
  if (c.emails.some((e) => e.value === value)) return;
  const flat = value.replace(/[^a-z0-9]/g, "");
  c.emails.push({ value, from, nameMatch: nameTokens(name).some((t) => flat.includes(t)) });
}

export function addPhone(c: Contacts, phone: string, from: string): void {
  const value = phone.replace(/[^\d+]/g, "");
  if (value.length < 7 || c.phones.some((p) => p.value === value)) return;
  c.phones.push({ value, from });
}

export function addLink(c: Contacts, url: string, from: string): void {
  const clean = normalizeUrl(url);
  if (!clean) return;
  const key = urlKey(clean);
  if (c.links.some((l) => urlKey(l.url) === key)) return;
  c.links.push({ label: linkLabel(clean), url: clean, from });
}

/** http(s) adresi değilse null; Instagram/Facebook yönlendirme sarmalı açılır. */
export function normalizeUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) {
    if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(s)) s = `https://${s}`;
    else return null;
  }
  try {
    const u = new URL(s);
    if (/^l\.(instagram|facebook)\.com$/i.test(u.hostname) && u.searchParams.get("u"))
      return normalizeUrl(u.searchParams.get("u") ?? "");
    u.hash = "";
    for (const p of [...u.searchParams.keys()])
      if (/^(utm_|fbclid|igsh|igshid|xmt$|hl$|ref$|e$|s$)/i.test(p)) u.searchParams.delete(p);
    return u.toString();
  } catch {
    return null;
  }
}

/** Aynı sayfanın yazım farklarını (www, sondaki /, http) eşler. */
export function urlKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${u.search}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

const LABELS: Array<[RegExp, string]> = [
  [/(^|\.)instagram\.com$/, "Instagram"],
  [/(^|\.)threads\.(net|com)$/, "Threads"],
  [/(^|\.)pinterest\.[a-z.]+$|(^|\.)pin\.it$/, "Pinterest"],
  [/(^|\.)(facebook|fb)\.(com|me)$/, "Facebook"],
  [/(^|\.)(x|twitter)\.com$/, "X"],
  [/(^|\.)tiktok\.com$/, "TikTok"],
  [/(^|\.)(youtube\.com|youtu\.be)$/, "YouTube"],
  [/(^|\.)vimeo\.com$/, "Vimeo"],
  [/(^|\.)linkedin\.com$/, "LinkedIn"],
  [/(^|\.)behance\.net$/, "Behance"],
  [/(^|\.)artstation\.com$/, "ArtStation"],
  [/(^|\.)saatchiart\.com$/, "Saatchi"],
  [/(^|\.)artsy\.net$/, "Artsy"],
  [/(^|\.)singulart\.com$/, "Singulart"],
  [/(^|\.)artfinder\.com$/, "Artfinder"],
  [/(^|\.)etsy\.com$/, "Etsy"],
  [/(^|\.)(wa\.me|whatsapp\.com)$/, "WhatsApp"],
  [/(^|\.)t\.me$/, "Telegram"],
  [/(^|\.)spotify\.com$/, "Spotify"],
];

/** Link toplayıcılar: açılır, içindeki linkler takip edilir. */
const AGGREGATOR =
  /(^|\.)(linktr\.ee|beacons\.ai|bio\.site|linkin\.bio|lnk\.bio|campsite\.bio|taplink\.cc|carrd\.co|allmylinks\.com|msha\.ke|solo\.to|hoo\.be|about\.me|linkbio\.co|biolink\.info|tap\.bio|withkoji\.com|koji\.to|direct\.me|linkr\.bio|stan\.store|flow\.page|later\.com)$/;

export function isAggregator(url: string): boolean {
  return AGGREGATOR.test(hostOf(url));
}

export function linkLabel(url: string): string {
  const host = hostOf(url);
  for (const [re, label] of LABELS) if (re.test(host)) return label;
  if (AGGREGATOR.test(host)) return "Link sayfası";
  return "Site";
}

/** Platform/sosyal ağ linki: site taramasında açılmaz, platform adımında incelenir. */
export function recordOnly(url: string): boolean {
  return linkLabel(url) !== "Site" && !isAggregator(url);
}

/**
 * Girişsiz bakılamayan ya da iletişim bilgisi taşımayan platformlar: yalnız
 * kaydedilir. Diğer platform linkleri (Pinterest, Facebook, Threads, TikTok,
 * YouTube, Behance…) keşifte açılıp incelenir (kullanıcı, 2026-10-23: Oya
 * Bilgin'in e-postası Pinterest "İletişim Kur"daydı).
 */
export function notInspectable(url: string): boolean {
  return ["Instagram", "X", "LinkedIn", "WhatsApp", "Spotify", "Saatchi"].includes(linkLabel(url));
}

/**
 * Otomatik davet gidebilecek adres mi: adı taşıyor, bulunduğu sitenin kendi
 * alan adında, ya da sanatçının kendi yazdığı yerde (kaynak profili, Instagram
 * bio'su, link sayfası). Bir mağaza/galeri sayfasındaki başka adres GİTMEZ.
 */
export function trustedEmail(e: FoundEmail): boolean {
  if (e.nameMatch) return true;
  const domain = e.value.split("@")[1] ?? "";
  const place = hostOf(`https://${e.from}`);
  if (place && (domain === place || place.endsWith(`.${domain}`))) return true;
  // Sanatçının kendi yazdığı yerler: kaynak profili, Instagram bio'su, kendi
  // Facebook sayfasının iletişim bilgileri (link bio'dan/link sayfasından gelir).
  if (/^(Instagram bio|Saatchi|Saatchi Art|Facebook|Pinterest)$/.test(e.from)) return true;
  return isAggregator(`https://${e.from}`);
}

/**
 * Davet gidecek tek adres (güvenilirler arasından): adı taşıyan, sonra
 * sanatçının kendi sitesinin alan adındaki, sonra kendi yazdığı yerdeki.
 */
export function bestEmail(c: Contacts): FoundEmail | null {
  const sites = new Set(c.links.filter((l) => l.label === "Site").map((l) => hostOf(l.url)));
  const score = (e: FoundEmail) =>
    (e.nameMatch ? 4 : 0) +
    (sites.has(e.value.split("@")[1] ?? "") ? 2 : 0) +
    (/instagram|saatchi/i.test(e.from) ? 1 : 0);
  return [...c.emails].filter(trustedEmail).sort((a, b) => score(b) - score(a))[0] ?? null;
}
