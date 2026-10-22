import type { Page } from "playwright";

import { randomPause } from "../../lib/browser.js";
import type {
  ListedArtist,
  ProfileSummary,
  ScrapedArtist,
  ScrapedWork,
  SourceAdapter,
  StructuredArtist,
  StructuredSeries,
  StructuredWork,
} from "../types.js";
import { slugOf } from "../countries.js";

// ============================================================================
// Saatchi Art (2026-10-19'da gerçek sayfada bakıldı)
// ----------------------------------------------------------------------------
//   Liste:   https://www.saatchiart.com/<branş>/<ülke>?page=N   (≈100 kart/sayfa;
//            ülke İngilizce adın tireli hali: turkey, united-kingdom)
//            kartlarda sanatçı bağlantısı: /account/profile/<id>, metni "→Ad, Turkey"
//   Profil:  /account/profile/<id> — "Ad", "Şehir, Turkey", bio, "All Artworks (N)",
//            ABOUT / EDUCATION bölümleri. Bio'da sıkça "Instagram: kullanıcı".
//   Eser:    /art/<Kategori>-<Başlık>/<sanatçıId>/<eserId>/view
// Seçiciler değişirse yalnız bu dosya güncellenir.
// ============================================================================

const BASE = "https://www.saatchiart.com";

function profileIdOf(url: string): string | null {
  return /\/account\/profile\/(\d+)/.exec(url)?.[1] ?? null;
}

/** Dil önekini atar: aynı kişi her zaman aynı adresle tutulur. */
function canonicalProfile(id: string): string {
  return `${BASE}/account/profile/${id}`;
}

/** Bio/hakkında metninde sanatçının kendi yazdığı Instagram adı. */
export function instagramFromText(text: string): string | null {
  const url = /instagram\.com\/([A-Za-z0-9._]{1,30})/i.exec(text)?.[1];
  if (url && !/^(p|reel|reels|explore|accounts)$/i.test(url)) {
    return url.toLowerCase();
  }
  const labelled = /[İIi]nstagram\s*[:：\-–]?\s*@?([A-Za-z0-9._]{2,30})/u.exec(
    text,
  )?.[1];
  return labelled ? labelled.toLowerCase().replace(/\.+$/, "") : null;
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(1500);
}

/** Uzun sayfaların sonuna kadar kaydırır (tembel yüklenen kartlar için). */
async function scrollToEnd(page: Page): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const done = await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight * 1.5);
      return (
        window.scrollY + window.innerHeight >= document.body.scrollHeight - 50
      );
    });
    await page.waitForTimeout(400);
    if (done) break;
  }
}

/** Profildeki "ABOUT THE ARTIST" sekmelerinin her birinin tam metni. */
async function readProfileTabs(
  page: Page,
): Promise<Array<{ label: string; text: string }>> {
  const tabs = page.locator('[class*="tabsButton"]');
  const labels = (await tabs.allInnerTexts().catch(() => [] as string[])).map((l) => l.trim());
  const out: Array<{ label: string; text: string }> = [];
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i] ?? "";
    try {
      await tabs.nth(i).click({ timeout: 3000 });
      await page.waitForTimeout(600);
      // Sekme çubuğunun bir üstü, sekmenin içeriğini de tutan bölüm.
      const section = tabs.nth(i).locator("xpath=../..");
      for (const more of await section.getByText(/^READ MORE$/i).all()) {
        await more.click({ timeout: 1500 }).catch(() => {});
      }
      await page.waitForTimeout(300);
      const text = (await section.innerText())
        .split("\n")
        .filter((line) => !labels.includes(line.trim()) && !/^READ (MORE|LESS)$/i.test(line.trim()))
        .join("\n")
        .trim()
        .slice(0, 8000);
      if (text) out.push({ label, text });
    } catch {
      // Sekme yoksa ya da tıklanamadıysa: o bölüm boş kalır.
    }
  }
  return out;
}

// ─── Yapılandırılmış veri (__NEXT_DATA__) ───────────────────────────────────
// Saatchi sayfaları verinin kendisini JSON olarak taşır (2026-10-19 bakıldı):
//   /account/artworks/<id>  → accountData: hakkında sekmeleri (tam metin), şehir,
//       avatarLarge, hero (kapak), insideTheStudioImages, socialLinks (site,
//       Instagram…), artworks[] (cm ölçü, teknik, malzeme, pdpUrl), collections[]
//   /art/…/view             → artwork: yearProduced, description, dimensions (cm),
//       mediums, materials, products (özgün / sınırlı baskı), pdpArtwork görselleri
//   /art-collection/…/view  → collectionData (seri adı/metni); eser bağlantıları DOM'da
// Görünen metin inch gösterir ve kısaltır; JSON cm ve tam metin verir.

type Json = Record<string, unknown>;
const asObj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const asStr = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;
const asNum = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
};
const asStrList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(asStr).filter((x): x is string => Boolean(x)) : [];

/**
 * Eserin kimliği = sayfa adresindeki sayı (/art/…/<sanatçı>/<eser>/view).
 * ⚠️ Eski eserlerde JSON'daki `artworkID` (ör. 5306905) adrestekinden
 * (4570709) farklı; ikisi ayrı eser sanılıp çift okunuyordu (2026-10-19).
 */
const workIdOf = (url: string | null | undefined): string | null =>
  url ? (/\/(\d+)\/view(?:[?#]|$)/.exec(url)?.[1] ?? null) : null;

async function readPageData(page: Page): Promise<Json | null> {
  const raw = await page
    .evaluate(() => document.getElementById("__NEXT_DATA__")?.textContent ?? "")
    .catch(() => "");
  if (!raw) return null;
  try {
    return asObj(asObj(asObj(asObj(JSON.parse(raw)).props).pageProps).initialState);
  } catch {
    return null;
  }
}

const pageData = (state: Json | null) => asObj(asObj(state?.page).data);

/** Hesap verisi (profil + eser listesi + seriler). */
async function readAccount(page: Page): Promise<Json | null> {
  const acc = asObj(pageData(await readPageData(page)).accountData);
  return Object.keys(acc).length ? acc : null;
}

const SOCIAL_LABEL: Record<string, string> = {
  facebook: "Facebook",
  twitter: "X",
  pinterest: "Pinterest",
  tumblr: "Tumblr",
  tiktok: "TikTok",
};

function profileFromAccount(acc: Json): Omit<StructuredArtist, "works" | "series"> {
  const about = asObj(acc.aboutArtist);
  const social = asObj(acc.socialLinks);
  const avatar = asStr(acc.avatarLarge) ?? asStr(acc.avatar);
  return {
    name: [asStr(acc.firstName), asStr(acc.lastName)].filter(Boolean).join(" "),
    city: asStr(acc.city),
    region: asStr(acc.state),
    country: asStr(acc.country),
    about: asStr(about.about),
    education: asStr(about.education),
    exhibitions: asStr(about.exhibitions),
    events: asStr(about.events),
    badges: (Array.isArray(acc.badges) ? acc.badges : [])
      .map((b) => asStr(asObj(b).title))
      .filter((x): x is string => Boolean(x)),
    // Varsayılan (boş) avatar portre değildir.
    avatar: avatar && !/default|placeholder|no-?avatar/i.test(avatar) ? avatar : null,
    cover: asStr(asObj(acc.hero).largeImage),
    studioImages: (Array.isArray(acc.insideTheStudioImages) ? acc.insideTheStudioImages : [])
      .map((i) => asStr(asObj(i).thumbnailUrl) ?? asStr(asObj(i).url))
      .filter((x): x is string => Boolean(x)),
    website: asStr(social.artistHomepage),
    email: asStr(acc.email),
    instagram: asStr(social.instagram),
    socials: Object.entries(SOCIAL_LABEL)
      .map(([key, label]) => ({ label, url: asStr(social[key]) ?? "" }))
      .filter((l) => /^https?:\/\//i.test(l.url)),
    worksTotal: asNum(acc.artworksTotal) ?? 0,
  };
}

async function readWork(page: Page, listed: Json): Promise<StructuredWork | null> {
  const pdpUrl = asStr(listed.pdpUrl);
  const sourceId = workIdOf(pdpUrl) ?? asStr(listed.artworkID) ?? "";
  if (!pdpUrl || !sourceId) return null;
  const url = new URL(pdpUrl, BASE).toString();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await settle(page);
  const data = pageData(await readPageData(page));
  const art = asObj(data.artwork);
  const pdp = asObj(data.pdpArtwork);
  const dims = asObj(art.dimensions);
  const products = (Array.isArray(art.products) ? art.products : []).map(asObj);
  const limited = products.find((p) => p.isLimitedEdition === true);
  const imageOf = (img: unknown) =>
    asStr(asObj(img).fullscreenUrl) ?? asStr(asObj(img).mainUrl) ?? asStr(asObj(img).url);
  const images = [
    imageOf(pdp.artworkMainImage),
    ...(Array.isArray(pdp.artworkAdditionalImages) ? pdp.artworkAdditionalImages : []).map(imageOf),
  ].filter((x): x is string => Boolean(x));
  // Görsel listesi boşsa liste kartının görseli (büyük boyu).
  if (!images.length) {
    const card = asStr(listed.artworkImage);
    if (card) images.push(card.replace(/-\d+\.(jpe?g|png|webp)$/i, "-8.$1"));
  }
  return {
    sourceId,
    url,
    title: asStr(art.title) ?? asStr(listed.title) ?? "",
    year: asNum(art.yearProduced),
    category: asStr(art.category) ?? asStr(listed.category),
    mediums: asStrList(art.mediums).length ? asStrList(art.mediums) : asStrList(listed.mediums),
    materials: asStrList(art.materials).length ? asStrList(art.materials) : asStrList(listed.materials),
    widthCm: asNum(dims.width) ?? asNum(listed.widthInCentimeters),
    heightCm: asNum(dims.height) ?? asNum(listed.heightInCentimeters),
    depthCm: asNum(dims.depth) ?? asNum(listed.depthInCentimeters),
    description: asStr(art.description),
    // Özgün: satışta ya da satılmış bir orijinali var (yalnız baskısı kalan
    // "unavail" eserde kaynak bunu söylemiyor → boş bırakılır).
    isOriginal:
      art.hasOriginal === true ||
      products.some((p) => p.isOriginal === true) ||
      /^(avail|sold|reserved)$/i.test(asStr(listed.originalStatus) ?? asStr(pdp.originalArtworkStatus) ?? ""),
    limitedEditionUnits: limited ? asNum(limited.unitsProduced) : null,
    panels: art.isMultiPanel === true ? asNum(art.panels) : null,
    subject: asStr(art.subject),
    styles: asStrList(art.styles),
    keywords: asStrList(art.keywords),
    images: [...new Set(images)].slice(0, 10),
    availability: asStr(listed.originalStatus) ?? asStr(pdp.originalArtworkStatus),
  };
}

async function readSeries(page: Page, collection: Json, artistId: string): Promise<StructuredSeries | null> {
  const href = asStr(collection.collectionUrl);
  if (!href) return null;
  const url = new URL(href, BASE).toString();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await settle(page);
  await scrollToEnd(page);
  const data = asObj(pageData(await readPageData(page)).collectionData);
  // Yalnız sanatçının kendi serisi ("Art Series"), küratör koleksiyonu değil.
  const types = asStrList(data.collectionTypes).join(" ");
  if (types && !/series/i.test(types)) return null;
  const memberIds = await page.evaluate(
    (id) =>
      [
        ...new Set(
          [...document.querySelectorAll('a[href*="/art/"]')]
            .map((a) => (a as HTMLAnchorElement).href)
            .filter((h) => h.includes(`/${id}/`))
            .map((h) => /\/(\d+)\/view/.exec(h)?.[1] ?? "")
            .filter(Boolean),
        ),
      ],
    artistId,
  );
  return {
    title: asStr(data.title) ?? asStr(collection.title) ?? "",
    description: asStr(data.description),
    url,
    memberIds,
  };
}

/** Saatchi'nin yapılandırılmış verisinden sanatçının tamamı; okunamazsa null. */
async function scrapeStructured(page: Page, profileUrl: string): Promise<ScrapedArtist | null> {
  const id = profileIdOf(profileUrl);
  if (!id) return null;
  await page.goto(`${BASE}/account/artworks/${id}`, { waitUntil: "domcontentloaded" });
  await settle(page);
  const acc = await readAccount(page);
  if (!acc) return null;
  const profile = profileFromAccount(acc);
  // JSON yalnız ilk sayfayı (≈15) taşır; sayfadaki bağlantılar hepsini
  // (2026-10-19: 29 eserin 29'u). Sıra sayfanınki; JSON'daki ek bilgi eşlenir.
  // Yalnız baskısı satılan eserler /print/… bağlantısıyla gelir → /art/…
  await scrollToEnd(page);
  const domLinks = await page.evaluate(
    (artistId) =>
      [...document.querySelectorAll(`a[href*="/${artistId}/"]`)]
        .map((a) => (a as HTMLAnchorElement).getAttribute("href") ?? "")
        .map((h) => {
          const m = new RegExp(`/(art|print)/([^/?#]+)/${artistId}/(\\d+)/view`).exec(h);
          return m ? { id: m[3] ?? "", path: `/art/${m[2]}/${artistId}/${m[3]}/view` } : null;
        })
        .filter((x): x is { id: string; path: string } => Boolean(x)),
    id,
  );
  const fromJson = new Map(
    (Array.isArray(acc.artworks) ? acc.artworks : [])
      .map(asObj)
      .map((item) => [workIdOf(asStr(item.pdpUrl)) ?? asStr(item.artworkID) ?? "", item] as const),
  );
  const order: string[] = [];
  for (const link of domLinks) if (!order.includes(link.id)) order.push(link.id);
  for (const key of fromJson.keys()) if (key && !order.includes(key)) order.push(key);
  const listed = order.map(
    (artworkId) =>
      fromJson.get(artworkId) ?? {
        artworkID: artworkId,
        pdpUrl: domLinks.find((l) => l.id === artworkId)?.path ?? null,
      },
  );

  const works: StructuredWork[] = [];
  for (const item of listed.slice(0, 40)) {
    const work = await readWork(page, item).catch(() => null);
    if (work) works.push(work);
    await randomPause(1, 3);
  }
  const series: StructuredSeries[] = [];
  for (const collection of (Array.isArray(acc.collections) ? acc.collections : []).map(asObj)) {
    const one = await readSeries(page, collection, id).catch(() => null);
    if (one && one.memberIds.length) series.push(one);
  }
  const structured: StructuredArtist = { ...profile, works, series };

  const profileText = [
    profile.about && `=== Hakkında (ABOUT) ===\n${profile.about}`,
    profile.education && `=== Eğitim (EDUCATION) ===\n${profile.education}`,
    profile.exhibitions && `=== Sergiler (EXHIBITIONS) ===\n${profile.exhibitions}`,
    profile.events && `=== Etkinlikler (EVENTS) ===\n${profile.events}`,
    profile.badges.length && `=== Tanınma (RECOGNITION, Saatchi rozetleri) ===\n${profile.badges.join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    structured,
    profileUrl,
    profileText,
    avatarImages: profile.avatar ? [profile.avatar] : [],
    coverImages: profile.cover ? [profile.cover] : [],
    works: works.map(
      (w): ScrapedWork => ({ url: w.url, text: `${w.title}`, images: w.images }),
    ),
  };
}

export const saatchi: SourceAdapter = {
  id: "saatchi",
  label: "Saatchi Art",
  categories: [
    { value: "paintings", label: "Resim (Paintings)" },
    { value: "drawings", label: "Çizim (Drawings)" },
    { value: "photography", label: "Fotoğraf (Photography)" },
    { value: "sculpture", label: "Heykel (Sculpture)" },
    { value: "collage", label: "Kolaj (Collage)" },
    { value: "printmaking", label: "Baskı (Printmaking)" },
    { value: "digital", label: "Dijital (Digital)" },
    { value: "mixed-media", label: "Karışık teknik (Mixed Media)" },
    { value: "installation", label: "Yerleştirme (Installation)" },
    { value: "textile", label: "Tekstil (Textile)" },
  ],

  async collect(page, category, country, accept, onArtist, resume) {
    // "→Ad Soyad, Turkey" — yalnız seçilen ülkeden olanlar.
    const suffix = new RegExp(
      `,\\s*${country.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      "i"
    );
    let pages = 0;
    for (let n = Math.max(1, resume.startPage); n <= 60; n++) {
      await page.goto(`${BASE}/${category}/${slugOf(country)}?page=${n}`, {
        waitUntil: "domcontentloaded",
      });
      await settle(page);
      await scrollToEnd(page);
      pages++;
      const listed = await page.evaluate(() =>
        [...document.querySelectorAll('a[href*="/account/profile/"]')].map(
          (a) => ({
            href: (a as HTMLAnchorElement).href,
            text: a.textContent ?? "",
          }),
        ),
      );
      const fresh = new Map<string, ListedArtist>();
      for (const item of listed) {
        const id = profileIdOf(item.href);
        if (!id || fresh.has(id)) continue;
        const text = item.text.replace(/^[→\s]+/, "").trim();
        if (!suffix.test(text)) continue;
        const name = text.replace(suffix, "").trim();
        if (!name) continue;
        fresh.set(id, { name, profileUrl: canonicalProfile(id) });
      }
      if (fresh.size === 0) return { pages, exhausted: true };
      for (const artist of fresh.values()) {
        if (!accept(artist)) continue;
        if (await onArtist(artist)) return { pages, exhausted: false };
      }
      // Sayfa bitti: yarıda kalırsa buradan sonrası taranır.
      resume.onPage(n);
      await randomPause(2, 5);
    }
    return { pages, exhausted: true };
  },

  async profile(page, profileUrl, country) {
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await settle(page);
    const data = await page.evaluate(() => {
      const text = document.body.innerText;
      const title = document.title.split("|")[0]?.trim() ?? "";
      return { text, title };
    });
    const text = data.text;
    const start = text.indexOf(data.title);
    const main = start >= 0 ? text.slice(start, start + 4000) : text;
    const worksCount = Number(
      /All Artworks\s*\((\d+)\)/i.exec(main)?.[1] ?? NaN,
    );
    const city =
      new RegExp(`\\n([^\\n]{2,60}),\\s*${country.name}\\s*\\n`).exec(main)?.[1]?.trim() ??
      null;
    const aboutStart = main.search(/\bABOUT\b/);
    const bio = (
      aboutStart >= 0 ? main.slice(aboutStart, aboutStart + 1500) : main
    )
      .replace(/\n(POPULAR ARTWORKS|Commission [^\n]+|CONTACT OUR CURATORS|TOP CATEGORIES)[\s\S]*$/, "")
      .trim();
    // Sanatçının Saatchi'ye KENDİ girdiği Instagram (socialLinks) önce;
    // yoksa bio metnindeki "Instagram: …".
    const acc = await readAccount(page);
    const socialIg = acc ? asStr(asObj(acc.socialLinks).instagram) : null;
    const accTotal = acc ? asNum(acc.artworksTotal) : null;
    return {
      name: data.title,
      city: (acc && asStr(acc.city)) ?? city,
      worksCount: accTotal ?? (Number.isFinite(worksCount) ? worksCount : null),
      bio: bio || null,
      instagramHandle:
        (socialIg ? instagramFromText(socialIg) : null) ?? instagramFromText(main),
    } satisfies ProfileSummary;
  },

  async scrapeAll(page, profileUrl) {
    const structured = await scrapeStructured(page, profileUrl).catch(() => null);
    if (structured) return structured;
    // Yapılandırılmış veri yoksa (site değişti): görünen metinden.
    const id = profileIdOf(profileUrl);
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await settle(page);
    // "READ MORE" açılırsa tam bio görünür.
    await page
      .getByText(/^READ MORE$/i)
      .first()
      .click({ timeout: 2000 })
      .catch(() => {});
    await scrollToEnd(page);

    // "ABOUT THE ARTIST" sekmeli: ABOUT · EDUCATION · EXHIBITIONS · RECOGNITION.
    // Yalnız ilk sekme görünür; eğitim/sergiler/ödüller ancak sekmeye tıklayınca
    // ve uzun liste "READ MORE" ile açılınca gelir (2026-10-19: ilk canlı
    // taslakta Katılımlar ve Eğitim bu yüzden boştu).
    const sections = await readProfileTabs(page);

    const profile = await page.evaluate((artistId) => {
      const imgs = [...document.querySelectorAll("img")].map((img) => ({
        src:
          (img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src,
        alt: (img as HTMLImageElement).alt || "",
        w: (img as HTMLImageElement).naturalWidth,
        h: (img as HTMLImageElement).naturalHeight,
      }));
      const workLinks = [
        ...new Set(
          [...document.querySelectorAll('a[href*="/art/"]')]
            .map((a) => (a as HTMLAnchorElement).href.split("?")[0] ?? "")
            .filter((h) => artistId && h.includes(`/${artistId}/`)),
        ),
      ];
      return {
        text: document.body.innerText,
        title: document.title.split("|")[0]?.trim() ?? "",
        imgs,
        workLinks,
        ogImage:
          document
            .querySelector('meta[property="og:image"]')
            ?.getAttribute("content") ?? null,
      };
    }, id);

    // Profil sayfasının konu dışı kısımlarını (öneriler, alt bilgi) at.
    const start = profile.text.indexOf(profile.title);
    const profileText = [
      (start >= 0 ? profile.text.slice(start) : profile.text)
        .replace(/\n(POPULAR ARTWORKS|Commission [^\n]+|CONTACT OUR CURATORS|TOP CATEGORIES)[\s\S]*$/, "")
        .slice(0, 12000),
      ...sections.map((s) => `=== Saatchi profil sekmesi: ${s.label} ===\n${s.text}`),
    ].join("\n\n");

    // Yalnız bu sanatçının profil görselleri (izleme pikselleri vb. değil).
    const ownImage = (src: string) =>
      Boolean(id) && src.includes(`/${id}/profile/`);
    // Sayfa küçük boyu (…_avatar_medium_square.jpg) gösterir; büyüğü de var
    // (…_avatar_large_square.jpg, ~3 kat).
    const avatarImages = profile.imgs
      .filter((i) => ownImage(i.src) && /avatar/i.test(i.src))
      .map((i) => (i.src.split("?")[0] ?? i.src).replace(/_(small|medium)_square\./i, "_large_square."));
    if (profile.ogImage && ownImage(profile.ogImage)) {
      avatarImages.push(profile.ogImage);
    }
    const coverImages = profile.imgs
      .filter((i) => ownImage(i.src) && /cover|banner|header/i.test(i.src))
      .map((i) => i.src.split("?")[0] ?? i.src);

    // Tüm eserler sayfası daha uzun liste verebilir.
    if (id) {
      await page
        .goto(`${BASE}/account/artworks/${id}`, {
          waitUntil: "domcontentloaded",
        })
        .catch(() => {});
      await settle(page);
      await scrollToEnd(page);
      const more = await page.evaluate(
        (artistId) =>
          [...document.querySelectorAll('a[href*="/art/"]')]
            .map((a) => (a as HTMLAnchorElement).href.split("?")[0] ?? "")
            .filter((h) => h.includes(`/${artistId}/`)),
        id,
      );
      for (const link of more) {
        if (!profile.workLinks.includes(link)) profile.workLinks.push(link);
      }
    }

    const works: ScrapedWork[] = [];
    for (const url of profile.workLinks.slice(0, 40)) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await settle(page);
      const artworkId = /\/(\d+)\/view/.exec(url)?.[1] ?? "";
      // Açıklama kısaltılmış gelir: "READ MORE" ile tamamını aç.
      for (const more of await page.getByText(/^READ MORE$/i).all()) {
        await more.click({ timeout: 1500 }).catch(() => {});
      }
      const work = await page.evaluate(() => {
        const og =
          document
            .querySelector('meta[property="og:image"]')
            ?.getAttribute("content") ?? null;
        const body = document.body.innerText;
        // İki parça: üstte başlık/teknik/ölçü (h1'den "MORE FROM"a kadar),
        // altta "ABOUT THE ARTWORK" (açıklama, Year Created, Method).
        // Arada sanatçının öbür eserlerinin kartları — alınmaz.
        const h1 = document.querySelector("h1")?.textContent?.trim() ?? "";
        const from = h1 ? body.indexOf(h1) : -1;
        const head = (from >= 0 ? body.slice(from) : body)
          .replace(
            /\n(MORE FROM|YOU MAY ALSO LIKE|RELATED ARTWORKS|POPULAR [A-Z ]+|ABOUT THE ARTWORK)[\s\S]*$/,
            ""
          )
          .replace(/\n(ADD TO CART|MAKE AN OFFER|→ Shipping|→ 14-Day|Trustpilot)[^\n]*/g, "")
          .slice(0, 1500);
        const aboutAt = body.indexOf("ABOUT THE ARTWORK");
        const about =
          aboutAt >= 0
            ? body
                .slice(aboutAt)
                .replace(/\n(ABOUT THE ARTIST|Need more information\?)[\s\S]*$/, "")
                .replace(/\n(DETAILS AND DIMENSIONS|SHIPPING AND RETURNS|READ MORE)\n/g, "\n")
                .slice(0, 2500)
            : "";
        const text = [head, about].filter(Boolean).join("\n\n");
        const gallery = [...document.querySelectorAll("img")].map(
          (img) =>
            (img as HTMLImageElement).currentSrc ||
            (img as HTMLImageElement).src,
        );
        return { og, text, gallery };
      });
      // Yalnız BU eserin görselleri (öneri karuselindekiler değil), sorgusuz;
      // aynı görselin boy varyantları tek olur, en büyüğü (-8) seçilir.
      const byBase = new Map<string, string>();
      for (const src of [...(work.og ? [work.og] : []), ...work.gallery]) {
        const clean = src.split("?")[0] ?? src;
        if (!artworkId || !clean.includes(`/art/${artworkId}/`)) continue;
        const base = clean.replace(/-\d+\.(jpe?g|png|webp)$/i, "");
        if (!byBase.has(base)) {
          byBase.set(base, clean.replace(/-\d+\.(jpe?g|png|webp)$/i, "-8.$1"));
        }
      }
      const images = [...byBase.values()].slice(0, 10);
      works.push({ url, text: work.text, images });
      await randomPause(1, 3);
    }

    return {
      profileUrl,
      profileText,
      avatarImages: [...new Set(avatarImages)].slice(0, 5),
      coverImages: [...new Set(coverImages)].slice(0, 3),
      works,
    } satisfies ScrapedArtist;
  },
};
