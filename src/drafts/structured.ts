import type { StructuredArtist, StructuredWork } from "../sources/types.js";

// ============================================================================
// Kaynağın yapılandırılmış verisi → taslak: ölçü, yıl, görsel, başlık, portre,
// kapak, atölye fotoğrafları, web sitesi, linkler KODLA yazılır. Claude bu
// alanları yanlış ya da eksik verse bile taslakta kaynağın değeri durur
// (kullanıcı, 2026-10-19: "lazım olabilecek her şeyi al, kontrolünü çok iyi yap").
// Claude'un işi: Türkçe metinler, sınıflandırma (teknik/kategori/malzeme
// enum'ları), özgeçmişin satırlara ayrılması, seri metni.
// ============================================================================

type Draft = Record<string, unknown>;
type Work = Record<string, unknown>;

const LINKS_MAX = 10;
const PROFILE_IMAGES_MAX = 5;
const IMAGES_MAX = 10;

/** cm, bir ondalık; 0/eksi/yok → undefined. */
const cm = (v: number | null): number | undefined =>
  v && v > 0 ? Math.round(v * 10) / 10 : undefined;

/** Baştaki/sondaki tırnak gider, içteki fazla boşluk tek boşluk olur. */
const cleanTitle = (t: string) => {
  let out = t
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["“”'']+|["“”'']+$/g, "")
    .trim();
  // Dış tırnak gidince eşi kalmayan iç tırnak da gider:
  // “THE ONE” Mathematics… → THE ONE Mathematics… (2026-10-19).
  const unpaired =
    (out.match(/“/g)?.length ?? 0) !== (out.match(/”/g)?.length ?? 0) ||
    (out.match(/"/g)?.length ?? 0) % 2 === 1;
  if (unpaired) out = out.replace(/["“”]/g, "").replace(/\s+/g, " ").trim();
  return out;
};

/** Karşılaştırma için: tırnaksız, tek boşluklu, küçük harf. */
const titleKey = (t: string) =>
  t
    .replace(/["“”'']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("tr");

/** Eserin kaynaktaki alanlarını taslak eserine yazar (Claude'unkini ezer). */
function stamp(target: Work, source: StructuredWork): void {
  // Claude'un başlığı kaynağınkiyle aynıysa (yalnız tırnak/boşluk temizlenmiş)
  // onunki kalır; farklıysa (uydurma/çeviri) kaynağın temizlenmiş başlığı.
  const title = cleanTitle(source.title);
  const mine = typeof target.title === "string" ? cleanTitle(target.title) : "";
  if (mine && titleKey(mine) === titleKey(title)) target.title = mine.slice(0, 200);
  else if (title) target.title = title.slice(0, 200);
  if (source.year) target.year = source.year;
  else delete target.year;
  const w = cm(source.widthCm);
  const h = cm(source.heightCm);
  const d = cm(source.depthCm);
  if (w) target.width = w;
  else delete target.width;
  if (h) target.height = h;
  else delete target.height;
  if (d) target.depth = d;
  else delete target.depth;
  if (source.images.length)
    target.imageUrls = source.images.slice(0, IMAGES_MAX);
  // Baskı türü kaynakta açıkça var: özgün satışta/satılmış → ORIGINAL,
  // sınırlı baskı adedi → LIMITED_EDITION. İkisi de yoksa yazılmaz.
  if (source.limitedEditionUnits) target.edition = "LIMITED_EDITION";
  else if (source.isOriginal) target.edition = "ORIGINAL";
  else delete target.edition;
}

/** Claude'un atladığı bir kaynak eser için, yalnız kaynak bilgisiyle tekil eser. */
function fallbackWork(source: StructuredWork): Work {
  const work: Work = {
    kind: "ARTWORK",
    title: cleanTitle(source.title) || "Adsız",
  };
  const technique = [source.mediums.join(", "), source.materials.join(", ")]
    .filter(Boolean)
    .join(" on ");
  if (technique) work.mediumText = technique.slice(0, 200);
  if (source.description) work.description = source.description.slice(0, 2000);
  stamp(work, source);
  return work;
}

const handleOf = (url: string | null | undefined): string | null =>
  url
    ? (/instagram\.com\/([A-Za-z0-9._]{1,30})/i.exec(url)?.[1]?.toLowerCase() ??
      null)
    : null;

/** Claude'un taslağında `sourceId`'si geçmeyen kaynak eserler. */
export function missingWorks(draft: Draft, source: StructuredArtist): StructuredWork[] {
  const content = (draft.content ?? {}) as Record<string, unknown>;
  const seen = new Set<string>();
  for (const w of (Array.isArray(content.works) ? content.works : []) as Work[]) {
    if (w.sourceId) seen.add(String(w.sourceId));
    for (const m of (Array.isArray(w.members) ? w.members : []) as Work[]) {
      if (m.sourceId) seen.add(String(m.sourceId));
    }
  }
  return source.works.filter((w) => !seen.has(w.sourceId));
}

export interface ApplyNote {
  level: "info" | "warn";
  text: string;
}

/**
 * Kaynak verisini taslağa uygular. `sourceId`'ler okunur ve silinir (Artelivo
 * şeması tanımaz). Döner: yapılan düzeltmeler (rapora girer).
 */
export function applyStructured(
  draft: Draft,
  source: StructuredArtist,
  profileUrl: string,
): ApplyNote[] {
  const notes: ApplyNote[] = [];
  const content = (draft.content ??= {}) as Record<string, unknown>;
  const byId = new Map(source.works.map((w) => [w.sourceId, w]));
  const used = new Set<string>();

  // ── Eserler ──
  const works = (Array.isArray(content.works) ? content.works : []) as Work[];
  const kept: Work[] = [];
  for (const work of works) {
    if (work.kind === "SERIES" && Array.isArray(work.members)) {
      const members: Work[] = [];
      for (const m of work.members as Work[]) {
        const src = byId.get(String(m.sourceId ?? ""));
        delete m.sourceId;
        if (!src || used.has(src.sourceId)) {
          notes.push({
            level: "warn",
            text: `Seriden kaynağı belirsiz/tekrar eden üye çıkarıldı: ${String(m.title ?? "?")}`,
          });
          continue;
        }
        used.add(src.sourceId);
        stamp(m, src);
        members.push(m);
      }
      if (members.length >= 2) {
        work.members = members;
        delete work.imageUrls;
        kept.push(work);
      } else {
        // Seri kurulamaz: kalan üye tekil eser olur (MAPPING: <2 üye → seri yok).
        for (const m of members) kept.push({ ...m, kind: "ARTWORK" });
        if (members.length)
          notes.push({
            level: "info",
            text: `"${String(work.title)}" serisinde tek eser kaldı; tekil eser yazıldı.`,
          });
      }
      delete work.sourceId;
      continue;
    }
    const src = byId.get(String(work.sourceId ?? ""));
    delete work.sourceId;
    if (!src || used.has(src.sourceId)) {
      notes.push({
        level: "warn",
        text: `Kaynağı belirsiz/tekrar eden eser çıkarıldı: ${String(work.title ?? "?")}`,
      });
      continue;
    }
    used.add(src.sourceId);
    work.kind = "ARTWORK";
    delete work.members;
    stamp(work, src);
    kept.push(work);
  }
  // Claude'un atladığı her kaynak eser geri eklenir — hiçbir eser sessizce düşmez.
  for (const src of source.works) {
    if (used.has(src.sourceId)) continue;
    kept.push(fallbackWork(src));
    used.add(src.sourceId);
    notes.push({
      level: "warn",
      text: `Claude yazamadı, kaynaktan İngilizce haliyle eklendi (düzenle): ${cleanTitle(src.title)}`,
    });
  }
  // Sitedeki sıra: her eser (seri için ilk üyesi) kaynaktaki yerine göre.
  const position = (w: Work) => {
    const title = String(
      (Array.isArray(w.members)
        ? (w.members[0] as Work | undefined)?.title
        : w.title) ?? "",
    );
    const i = source.works.findIndex((s) => titleKey(s.title) === titleKey(title));
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  content.works = kept.sort((a, b) => position(a) - position(b));

  // ── Görseller ──
  if (source.avatar) content.avatarImageUrl = source.avatar;
  if (source.cover) content.coverImageUrl = source.cover;
  if (source.studioImages.length)
    content.profileImageUrls = source.studioImages.slice(0, PROFILE_IMAGES_MAX);

  // ── Web sitesi ve linkler ──
  if (source.website && /^https?:\/\//i.test(source.website))
    draft.websiteUrl = source.website;
  const links = new Map<string, { label: string; url: string }>();
  const skip = new Set(
    [draft.websiteUrl, draft.instagramUrl].map((u) =>
      String(u ?? "")
        .replace(/\/+$/, "")
        .toLowerCase(),
    ),
  );
  const add = (label: string, url: string) => {
    const key = url.replace(/\/+$/, "").toLowerCase();
    if (!/^https?:\/\//i.test(url) || skip.has(key) || links.has(key)) return;
    links.set(key, { label: label.slice(0, 40), url });
  };
  for (const l of source.socials) add(l.label, l.url);
  add("Saatchi Art", profileUrl);
  for (const l of (Array.isArray(content.links) ? content.links : []) as Array<{
    label?: string;
    url?: string;
  }>) {
    if (l?.url) add(l.label ?? "Bağlantı", l.url);
  }
  content.links = [...links.values()].slice(0, LINKS_MAX);

  // ── Konum ──
  if (source.city && !draft.city) draft.city = source.city;

  return notes;
}

// ─── Denetim ────────────────────────────────────────────────────────────────

export interface AuditLine {
  ok: "ok" | "warn" | "bad" | "none";
  label: string;
  detail: string;
}

/** Bir kez daha dener: eşzamanlı isteklerde geçici hata kalıcı ✗ olmasın. */
async function imageOk(url: string): Promise<boolean> {
  if (await imageOnce(url)) return true;
  await new Promise((r) => setTimeout(r, 1500));
  return imageOnce(url);
}

async function imageOnce(url: string): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return true; // upload:/draft: Artelivo'da
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(15_000),
    });
    const type = res.headers.get("content-type") ?? "";
    await res.body?.cancel();
    return res.ok && type.startsWith("image/");
  } catch {
    return false;
  }
}

/**
 * Taslak, kaynağa karşı alan alan denetlenir. Artelivo'ya gitmeden ÖNCE
 * çalışır; sonuç sanatçının satırında ve raporda görünür.
 */
export async function auditDraft(
  draft: Draft,
  source: StructuredArtist,
  approvedInstagram: string,
): Promise<AuditLine[]> {
  const c = (draft.content ?? {}) as Record<string, unknown>;
  const works = (Array.isArray(c.works) ? c.works : []) as Work[];
  const posts = works.flatMap((w) =>
    Array.isArray(w.members) ? (w.members as Work[]) : [w],
  );
  const lines: AuditLine[] = [];
  const line = (ok: AuditLine["ok"], label: string, detail: string) =>
    lines.push({ ok, label, detail });

  // Eserler — kaynakta aynı eser iki kez okunduysa (aynı adres) bu bir hatadır.
  const series = works.filter((w) => w.kind === "SERIES").length;
  const uniqueSource = new Set(source.works.map((w) => w.url)).size;
  if (uniqueSource !== source.works.length) {
    line("bad", "Çift eser", `${source.works.length - uniqueSource} eser kaynaktan iki kez okundu`);
  }
  const titleCounts = new Map<string, number>();
  for (const p of posts) {
    const k = titleKey(String(p.title ?? ""));
    titleCounts.set(k, (titleCounts.get(k) ?? 0) + 1);
  }
  const dupTitles = [...titleCounts.values()].filter((n) => n > 1).length;
  if (dupTitles) {
    line("warn", "Aynı başlık", `${dupTitles} başlık taslakta birden çok kez (kaynakta da öyleyse doğru)`);
  }
  line(
    posts.length === Math.min(uniqueSource, 80) ? "ok" : "bad",
    "Eserler",
    `kaynakta ${source.worksTotal || source.works.length}, okunan ${source.works.length}, taslakta ${posts.length}` +
      (series ? ` (${series} seri)` : "") +
      (source.worksTotal > source.works.length
        ? ` — ${source.worksTotal - source.works.length} eser okunamadı (en çok 40)`
        : ""),
  );
  const noSize = posts.filter((p) => !p.width || !p.height).length;
  line(
    noSize ? "warn" : "ok",
    "Ölçüler (cm)",
    noSize ? `${noSize} eserde ölçü yok` : "hepsinde var",
  );
  const noYear = posts.filter((p) => !p.year).length;
  line(
    noYear ? "warn" : "ok",
    "Yıl",
    noYear ? `${noYear} eserde yıl yok (kaynakta da yok)` : "hepsinde var",
  );
  const noTech = posts.filter((p) => !p.mediumText && !p.medium).length;
  line(
    noTech ? "warn" : "ok",
    "Teknik",
    noTech ? `${noTech} eserde teknik yok` : "hepsinde var",
  );
  const noDesc = posts.filter((p) => !p.description).length;
  const srcDesc = source.works.filter((w) => w.description).length;
  line(
    noDesc > source.works.length - srcDesc ? "warn" : "ok",
    "Açıklama",
    `${posts.length - noDesc}/${posts.length} eserde (kaynakta ${srcDesc})`,
  );

  // Görseller (her adres gerçekten iniyor mu)
  const imageUrls = [
    ...posts.flatMap((p) =>
      Array.isArray(p.imageUrls) ? (p.imageUrls as string[]) : [],
    ),
    ...[c.avatarImageUrl, c.coverImageUrl].filter(
      (x): x is string => typeof x === "string",
    ),
    ...((Array.isArray(c.profileImageUrls)
      ? c.profileImageUrls
      : []) as string[]),
  ];
  const results: boolean[] = [];
  for (let i = 0; i < imageUrls.length; i += 6) {
    results.push(
      ...(await Promise.all(imageUrls.slice(i, i + 6).map(imageOk))),
    );
  }
  const broken = results.filter((r) => !r).length;
  line(
    broken ? "bad" : "ok",
    "Görseller",
    `${imageUrls.length - broken}/${imageUrls.length} iniyor`,
  );
  const noImage = posts.filter(
    (p) => !Array.isArray(p.imageUrls) || !(p.imageUrls as unknown[]).length,
  ).length;
  if (noImage) line("bad", "Görselsiz eser", `${noImage}`);

  // Profil
  line(
    c.avatarImageUrl ? "ok" : source.avatar ? "bad" : "none",
    "Portre",
    c.avatarImageUrl
      ? "var"
      : source.avatar
        ? "kaynakta var, taslakta yok"
        : "kaynakta yok",
  );
  line(
    c.coverImageUrl ? "ok" : "warn",
    "Kapak",
    c.coverImageUrl
      ? source.cover
        ? "kaynağın kapağı"
        : "bir eser görseli"
      : "yok",
  );
  const studio = Array.isArray(c.profileImageUrls)
    ? c.profileImageUrls.length
    : 0;
  line(
    studio || !source.studioImages.length ? (studio ? "ok" : "none") : "bad",
    "Atölye fotoğrafları",
    `${studio} (kaynakta ${source.studioImages.length})`,
  );
  line(
    draft.websiteUrl ? "ok" : source.website ? "bad" : "none",
    "Web sitesi",
    String(
      draft.websiteUrl ??
        (source.website ? "kaynakta var, taslakta yok" : "kaynakta yok"),
    ),
  );
  const links = Array.isArray(c.links) ? c.links.length : 0;
  line(links ? "ok" : "none", "Linkler", `${links}`);
  line(
    draft.bio ? "ok" : "warn",
    "Kısa biyografi",
    draft.bio ? `${String(draft.bio).length} karakter` : "yok",
  );
  line(
    draft.biography ? "ok" : source.about ? "bad" : "none",
    "Biyografi",
    draft.biography
      ? `${String(draft.biography).length} karakter`
      : source.about
        ? "kaynakta var, taslakta yok"
        : "kaynakta yok",
  );
  line(
    c.birthYear ? "ok" : "none",
    "Doğum yılı",
    c.birthYear ? String(c.birthYear) : "yazılmadı (kaynakta yoksa doğru)",
  );

  // Özgeçmiş: kaynaktaki yıllı satır sayısıyla karşılaştır
  const exh = Array.isArray(c.exhibitions) ? c.exhibitions.length : 0;
  // Sergi satırı: "– Ad, Mekân" ya da "1997 - Ad" (yıl + metin). Tek başına
  // yıl başlığı ("2024") ve bölüm başlığı ("Solo Shows") satır değildir.
  const yearLines = (source.exhibitions ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        /^[–\-•·*]\s*\S/.test(l) ||
        /^(19|20)\d{2}\s*[-–:.,]?\s*\S{2,}/.test(l),
    ).length;
  line(
    !source.exhibitions
      ? exh
        ? "ok"
        : "none"
      : exh >= Math.floor(yearLines * 0.8)
        ? "ok"
        : "warn",
    "Katılımlar",
    `taslakta ${exh}` +
      (source.exhibitions
        ? ` (kaynakta ~${yearLines} satır)`
        : " (kaynakta sergi listesi yok)"),
  );
  const edu = Array.isArray(c.education) ? c.education.length : 0;
  line(
    edu ? "ok" : source.education ? "warn" : "none",
    "Eğitim",
    edu
      ? `${edu}`
      : source.education
        ? "kaynakta metin var, satır çıkmadı — kurum/başlangıç yılı olmayabilir; bak"
        : "kaynakta yok",
  );
  const career = Array.isArray(c.career) ? c.career.length : 0;
  line(
    career ? "ok" : "none",
    "Kariyer (ödül, rezidans, koleksiyon…)",
    `${career}`,
  );

  // Instagram: onayladığın hesap, sanatçının Saatchi'ye kendi yazdığıyla aynı mı?
  const declared = handleOf(source.instagram);
  const approved = handleOf(approvedInstagram);
  if (declared && approved && declared !== approved) {
    line(
      "bad",
      "Instagram",
      `onaylanan @${approved}, sanatçının Saatchi'de yazdığı @${declared} — kontrol et`,
    );
  } else {
    line(
      "ok",
      "Instagram",
      declared
        ? "Saatchi'de yazanla aynı"
        : "Saatchi'de yazmıyor (elle onaylandı)",
    );
  }
  return lines;
}
