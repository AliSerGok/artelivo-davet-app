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
  /**
   * Sanatçının KENDİ yazdığı yerden mi geldi (Instagram bio'su, kaynak profili,
   * kendi sitesi/link sayfası, kendi Pinterest/Facebook hesabı). Galeri veya
   * mağaza sayfasındaki adres değil. Toplanırken belirlenir.
   */
  trusted?: boolean;
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
    if (typeof e === "string") addEmail(c, e, "Saatchi", name, true);
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

/**
 * Adres sanatçının adını taşıyor mu: 4+ harflik ad parçası adreste geçer; 3
 * harflik olanlar ("ali", "can") yalnız ayrı bir parça olarak (ali.kaya@…),
 * yoksa "kalite@…", "canvas@…" eşleşiyordu.
 */
export function nameMatches(email: string, name: string): boolean {
  const value = email.toLowerCase();
  const flat = value.replace(/[^a-z0-9]/g, "");
  const parts = value.split(/[^a-z]+/);
  return nameTokens(name).some((t) => (t.length >= 4 ? flat.includes(t) : parts.includes(t)));
}

export function addEmail(c: Contacts, email: string, from: string, name: string, trusted = false): void {
  const value = email.trim().toLowerCase();
  const known = c.emails.find((e) => e.value === value);
  if (known) {
    // Aynı adres sanatçının kendi yerinde de bulunduysa güvenilir olur.
    if (trusted) known.trusted = true;
    return;
  }
  c.emails.push({ value, from, nameMatch: nameMatches(value, name), trusted });
}

export function addPhone(c: Contacts, phone: string, from: string): void {
  const value = phone.replace(/[^\d+]/g, "").replace(/^00/, "+");
  const digits = value.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return;
  // Aynı numaranın yazım farkları (+90 532…, 0532…) tek kayıt.
  const tail = digits.slice(-10);
  if (c.phones.some((p) => p.value.replace(/\D/g, "").endsWith(tail))) return;
  c.phones.push({ value, from });
}

/** wa.me/905321234567 · api.whatsapp.com/send?phone=… → +905321234567 */
export function phoneFromWhatsApp(url: string): string | null {
  try {
    const u = new URL(url);
    const digits =
      (/wa\.me$/i.test(u.hostname) ? u.pathname.slice(1) : u.searchParams.get("phone") ?? "").replace(/\D/g, "");
    return digits.length >= 10 ? `+${digits}` : null;
  } catch {
    return null;
  }
}

export function addLink(c: Contacts, url: string, from: string): void {
  const clean = normalizeUrl(url);
  if (!clean) return;
  const key = urlKey(clean);
  if (c.links.some((l) => urlKey(l.url) === key)) return;
  const label = linkLabel(clean);
  c.links.push({ label, url: clean, from });
  // WhatsApp linki bir telefon numarasıdır (kullanıcı, 2026-10-23).
  const phone = label === "WhatsApp" ? phoneFromWhatsApp(clean) : null;
  if (phone) addPhone(c, phone, "WhatsApp");
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
  [/(^|\.)shopier\.com$/, "Shopier"],
  [/(^|\.)(wa\.me|whatsapp\.com)$/, "WhatsApp"],
  [/(^|\.)(t\.me|telegram\.me)$/, "Telegram"],
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
 * Otomatik davet gidebilecek adres mi: sanatçının kendi yazdığı yerden geldi
 * (toplanırken `trusted`) ya da adını taşıyor. Galeri/mağaza sayfasındaki,
 * adla eşleşmeyen adrese davet GİTMEZ (sahiplenme linki üçüncü kişiye gider).
 */
export function trustedEmail(e: FoundEmail): boolean {
  return e.trusted === true || e.nameMatch;
}

/** Davet gidecek tek adres (güvenilirler arasından): adı taşıyan, sonra kendi yerinden gelen. */
export function bestEmail(c: Contacts): FoundEmail | null {
  const score = (e: FoundEmail) =>
    (e.nameMatch ? 4 : 0) + (e.trusted ? 2 : 0) + (/instagram|saatchi/i.test(e.from) ? 1 : 0);
  return [...c.emails].filter(trustedEmail).sort((a, b) => score(b) - score(a))[0] ?? null;
}
