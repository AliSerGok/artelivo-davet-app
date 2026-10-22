import { readFileSync } from "node:fs";


import { config } from "../config.js";
import type { ScrapedArtist, StructuredWork } from "../sources/types.js";
import { askFreeJson } from "./claude.js";

// ============================================================================
// Kaynak sayfa metninden Artelivo taslak JSON'u. Alan kuralları artemiz'deki
// MAPPING.md'den OKUNUR (kopyası tutulmaz): kural orada değişince burası da.
// Şema kontrolünü Artelivo yapar (`?dryRun=1` → 400 `detail`); hata satırları
// Claude'a geri verilip düzelttirilir.
// ============================================================================

const SCHEMA_SUMMARY = `
Taslak nesnesi (createArtistInviteSchema):
- name (2–100), sourceUrl (ZORUNLU, http), sourceNote (≤500), suggestedUsername (3–20, a-z0-9_),
  specialties (≤5, MAPPING listesinden), country (ISO-2 — verilen "country" aynen), city, bio (≤150, tek satır, Türkçe),
  biography (Türkçe), websiteUrl, instagramUrl (instagram.com PROFİL adresi), email YOK (Instagram daveti).
- content:
  birthYear, coverImageUrl, avatarImageUrl, profileImageUrls[] (≤5),
  works[] (≤40, toplam eser postu ≤80): { kind: "ARTWORK"|"SERIES", title, year, medium (enum, yalnız temiz eşleşme),
    mediumText (≤200), width/height/depth (cm, sayı), dimensionsText (≤200), category, materialType, edition, weight (kg),
    description, imageUrls[] (≤10), SERIES için yearTo, isOngoing, members[] }
  exhibitions[] (≤100): { name, organizer ("Mekân, Şehir"), year (zorunlu), date ("YYYY-MM-DD", aynı yıl), isSolo, award }
  education[] (≤20): { institution, department, degree, startYear (zorunlu), endYear }
  exhibitionPosts[] (≤40): yalnız kesin başlangıç ve bitiş GÜNÜ biliniyorsa { title, startDate, endDate, organizers[≥1], artists[], description, url, city, venue, imageUrls[] }
  press[] (≤50): { title, outlet, date (ZORUNLU, "YYYY-MM-DD"), url }
  career[] (≤100): MAPPING §2.1'deki altı tür
  links[] (≤10): { label (≤40), url }
`;

function mappingRules(): string {
  return readFileSync(config.mappingFile, "utf8");
}

export function extractionSystem(): string {
  return [
    "Artelivo için gizli bir sanatçı taslak profili hazırlıyorsun. Aşağıdaki MAPPING.md TEK doğruluk kaynağıdır;",
    "her bilgi için 'Artelivo profilinde karşılığı var mı?' diye sor, karşılığı olanı doldur, olmayanı uydurma.",
    "",
    "Bu kaynağa özel kurallar (MAPPING'deki 'sanatçının kendi sitesi' kuralları yerine geçer):",
    "- Kaynak bir sanat pazarı profili (ör. Saatchi Art). sourceUrl = verilen profil adresi, aynen.",
    "- instagramUrl verilir; aynen yaz. email alanını YAZMA. websiteUrl yalnız profilde sanatçının kendi sitesi yazıyorsa.",
    "- Fiyat, satış, baskı (print) satışı bilgileri ALINMAZ; eserler satılık değil olarak açılır (alan yok, yazma).",
    "- Görseller: YALNIZ verilen 'images' / 'avatarImages' / 'coverImages' adreslerini kullan, adres uydurma ya da değiştirme.",
    "  avatarImages, sanatçının kaynak sitede KENDİ seçtiği profil fotoğrafıdır: ilkini avatarImageUrl yap. Kapak yoksa en temsilî eserin görseli.",
    "- Eser başlıklarını tırnaksız yaz (sitedeki \"Başlık\" → Başlık).",
    "- Her eser sayfası bir ARTWORK'tür; aynı serinin parçası olduğu AÇIKÇA yazıyorsa SERIES + members kur.",
    "- Ölçüler kaynakta inch ise cm'ye çevir (1 in = 2.54 cm, bir ondalık); dimensionsText'e kaynaktaki yazımı koy.",
    "- Metinler Türkçe: İngilizce metinleri anlamını değiştirmeden, yeni iddia eklemeden Türkçeleştir.",
    "",
    "YAPILANDIRILMIŞ VERİ VARSA ('structured' alanı) — kaynağın kendi verisi, metinden daha güvenilir:",
    "- Her kaynak eser (structured.works) taslakta TAM BİR KEZ yer alır: ya tekil ARTWORK ya bir SERIES'in üyesi.",
    "  Her eser/üye nesnesine kaynaktaki `sourceId`'yi AYNEN yaz (zorunlu; kod eşlemek için okur, sonra siler).",
    "- Seri YALNIZ structured.series'ten kurulur: title, description (Türkçe), members = memberIds'deki eserler. Başka seri uydurma.",
    "- Ölçü (cm), yıl, görseller, başlık, baskı türü, portre, kapak, atölye fotoğrafları, web sitesi ve linkleri KOD kaynaktan yazar.",
    "  Bunları YAZMA (yazsan da ezilir, yalnız taslağı yavaşlatır): eser/üye nesnelerinde title, year, width, height, depth,",
    "  edition, imageUrls YOK; avatarImageUrl, profileImageUrls, websiteUrl, links YOK. Eser nesnesi = sourceId + aşağıdaki alanlar.",
    "  (SERIES nesnesinin kendi title'ı yazılır.) Senin işin şunlar:",
    "  • mediumText (Türkçe, ör. mediums [Oil] + materials [Canvas] → \"Tuval üzerine yağlı boya\"); medium enum'u yalnız tek ve açık eşleşmede;",
    "  • category (kaynak category → enum: Painting→PAINTING, Drawing→DRAWING, Photography→PHOTOGRAPHY, Sculpture→SCULPTURE,",
    "    Printmaking→PRINTMAKING, Digital→DIGITAL_ART, Mixed Media/Collage→MIXED_MEDIA, Installation→INSTALLATION, Textile→TEXTILE_ART);",
    "  • materialType (materials → enum: Canvas→CANVAS, Paper→PAPER, Wood→WOOD, Metal→METAL… yalnız açık eşleşme);",
    "  • description: kaynak açıklama Türkçeleştirilmiş (anlam değişmeden; boşsa yazma);",
    "  • dimensionsText: \"200 × 120 × 3 cm\" biçiminde (kaynak cm'dir);",
    "  • bio, biography, specialties, birthYear (metinde \"b. 1988\" gibi açıkça yazıyorsa);",
    "  • özgeçmiş: structured.exhibitions metnindeki HER sergi satırı bir exhibitions[] satırı (\"Solo Shows\"/\"Kişisel\" başlığı altındakiler isSolo:true;",
    "    yarışma/fuar/müzayede de sergi satırıdır); education metni (kurum + başlangıç yılı varsa); events ve RECOGNITION metinlerinden",
    "    MAPPING §2.1 kariyer satırları (yılı zorunlu olan türde yıl yoksa yazma). Saatchi'nin kendi rozeti (\"Artist featured in a collection\") KARİYER DEĞİLDİR.",
    "  • coverImageUrl: structured.cover yoksa en temsilî YATAY eserin ilk görseli (yalnız verilen görsellerden).",
    "- subject/styles/keywords Artelivo'ya yazılmaz (MAPPING: üslup/konu doldurulmaz).",
    '- sourceNote: "Instagram hesabı adla arandı, yönetici doğruladı."',
    '- dmLanguage (Artelivo alanı DEĞİL; kod okur ve siler): sanatçıya yazılacak mesajın dili, "tr" ya da "en".',
    "  Türkçe konuştuğu açıksa \"tr\": Türkçe ad-soyad, Türkçe metin, Türkiye'de doğum/eğitim, yurt dışındaki Türkler de.",
    "  Türkiye'de yaşasa da yabancıysa (yabancı ad, Türkiye dışında doğum/eğitim, Türkçe hiçbir iz yok) \"en\". Emin değilsen ülke TR ise \"tr\", değilse \"en\".",
    "",
    "Çıktı: YALNIZ tek bir JSON nesnesi (```json bloğu içinde), başka açıklama yok.",
    SCHEMA_SUMMARY,
    "",
    "=== MAPPING.md ===",
    mappingRules(),
  ].join("\n");
}

export function extractionRequest(input: {
  scraped: ScrapedArtist;
  name: string;
  instagramUrl: string;
  city: string | null;
  /** Turda seçilen ülke — taslağın `country` alanı (ISO-2). */
  countryIso: string;
}): string {
  return JSON.stringify(
      {
        task: "Bu sanatçının taslak JSON'unu üret.",
        name: input.name,
        city: input.city,
        country: input.countryIso,
        instagramUrl: input.instagramUrl,
        sourceUrl: input.scraped.profileUrl,
        profileText: input.scraped.profileText,
        ...(input.scraped.structured
          ? { structured: input.scraped.structured }
          : {
              avatarImages: input.scraped.avatarImages,
              coverImages: input.scraped.coverImages,
              works: input.scraped.works,
            }),
      },
      null,
      2,
    );
}

/**
 * Claude'un ilk cevapta atladığı eserler (uzun listelerde oluyor): yalnız
 * onların works[] nesnelerini, aynı kurallarla (Türkçe teknik/açıklama,
 * enum'lar) ister. Dönen her nesnede `sourceId` olmalı.
 */
export async function extractMissingWorks(
  works: StructuredWork[],
): Promise<Array<Record<string, unknown>>> {
  const { json } = await askFreeJson({
    purpose: "taslak-eksik",
    system: extractionSystem(),
    prompt: JSON.stringify(
      {
        task:
          "Önceki cevapta şu eserler yoktu. YALNIZ bunların content.works[] nesnelerini ver: " +
          '{ "works": [ … ] }. Her biri kind "ARTWORK", kaynaktaki sourceId AYNEN (title/year/ölçü/imageUrls YAZMA, kod yazar); mediumText ve description Türkçe; ' +
          "category / materialType / medium enum'ları kurallara göre.",
        works,
      },
      null,
      2,
    ),
    effort: "medium",
  });
  const list = (json as { works?: unknown })?.works;
  return Array.isArray(list)
    ? list.filter((w): w is Record<string, unknown> => Boolean(w) && typeof w === "object")
    : [];
}

export async function extractDraft(
  prompt: string,
): Promise<{ draft: Record<string, unknown>; raw: string }> {
  const { json, raw } = await askFreeJson({
    purpose: "taslak",
    system: extractionSystem(),
    prompt,
    effort: "medium",
  });
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("Claude taslak nesnesi döndürmedi.");
  }
  return { draft: json as Record<string, unknown>, raw };
}
