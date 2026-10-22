import type { Page } from "playwright";

import type { Country } from "./countries.js";

// ============================================================================
// Kaynak site adaptörü. Yeni bir site = bu arayüzün yeni bir uygulaması +
// `sources/index.ts`'e bir satır. Akışın geri kalanı siteyi bilmez.
// ============================================================================

export interface ListedArtist {
  name: string;
  /** Kaynaktaki profil adresi — kimliği ve KVKK "kaynak" cevabı. */
  profileUrl: string;
}

export interface ProfileSummary {
  name: string;
  city: string | null;
  worksCount: number | null;
  /** Profildeki serbest metin (bio, hakkında) — eşleştirme ipucu. */
  bio: string | null;
  /** Sanatçının profilinde KENDİ yazdığı Instagram kullanıcı adı, varsa. */
  instagramHandle: string | null;
}

export interface ScrapedWork {
  url: string;
  /** Sayfanın görünen metni (başlık, teknik, ölçü, yıl, açıklama…). */
  text: string;
  /** Büyük boy görsel adresleri, sayfadaki sırayla. */
  images: string[];
}

/**
 * Kaynağın KENDİ yapılandırılmış verisi (Saatchi: sayfadaki __NEXT_DATA__).
 * Metinden okunmuş tahmin değil: ölçü, yıl, görsel gibi alanlar taslağa
 * buradan kodla yazılır; Claude yalnız metin/sınıflandırma işini yapar.
 */
export interface StructuredWork {
  sourceId: string;
  url: string;
  title: string;
  year: number | null;
  /** Kaynağın kategori adı ("Painting", "Photography"…). */
  category: string | null;
  mediums: string[];
  materials: string[];
  widthCm: number | null;
  heightCm: number | null;
  depthCm: number | null;
  description: string | null;
  /** Özgün (tek) eser satışta/listede var. */
  isOriginal: boolean;
  /** Sınırlı baskı adedi, varsa. */
  limitedEditionUnits: number | null;
  panels: number | null;
  subject: string | null;
  styles: string[];
  keywords: string[];
  /** Büyük boy görseller, ana görsel önce. */
  images: string[];
  /** Kaynakta satış durumu (bilgi; taslağa yazılmaz). */
  availability: string | null;
}

export interface StructuredSeries {
  title: string;
  description: string | null;
  url: string;
  memberIds: string[];
}

export interface StructuredArtist {
  name: string;
  city: string | null;
  region: string | null;
  country: string | null;
  about: string | null;
  education: string | null;
  exhibitions: string | null;
  events: string | null;
  badges: string[];
  avatar: string | null;
  cover: string | null;
  studioImages: string[];
  website: string | null;
  /** Hesaptaki e-posta alanı (çoğu profilde boş, 2026-10-23). */
  email: string | null;
  instagram: string | null;
  socials: Array<{ label: string; url: string }>;
  worksTotal: number;
  works: StructuredWork[];
  series: StructuredSeries[];
}

export interface ScrapedArtist {
  /** Varsa kaynağın kendi verisi; yoksa yalnız metin alanları dolu. */
  structured?: StructuredArtist;
  profileUrl: string;
  /** Profil + hakkında/CV sayfalarının görünen metni. */
  profileText: string;
  /** Profil görseli (portre) adayları, kapak adayları. */
  avatarImages: string[];
  coverImages: string[];
  works: ScrapedWork[];
}

export interface SourceAdapter {
  id: string;
  label: string;
  /** Kaynağın branş/kategori listesi (değer → görünen ad). */
  categories: Array<{ value: string; label: string }>;
  /**
   * Branş + ülke filtresiyle listeyi sayfa sayfa gezer. `accept` false
   * dönen kişiyi atlar (zaten görülmüş vb.); `onArtist` her yeni kişi için
   * çağrılır ve true dönerse hedef doldu demektir.
   */
  collect(
    page: Page,
    category: string,
    country: Country,
    accept: (artist: ListedArtist) => boolean,
    onArtist: (artist: ListedArtist) => Promise<boolean>,
    /**
     * Devam: `startPage`'den başlar (yarım kalan turda son BİTEN sayfanın
     * bir sonrası); her sayfa bitince `onPage` ile kaydedilir.
     */
    resume: { startPage: number; onPage: (page: number) => void },
  ): Promise<{ pages: number; exhausted: boolean }>;
  profile(
    page: Page,
    profileUrl: string,
    country: Country
  ): Promise<ProfileSummary>;
  scrapeAll(page: Page, profileUrl: string): Promise<ScrapedArtist>;
}
