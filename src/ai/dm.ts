import { z } from "zod";

import { askJson } from "./claude.js";

// ============================================================================
// Kişiye özel Instagram mesajı. Kullanıcının kuralları ve örnekleri (2026-10-19; tanıtım 2026-10-21):
//   1. paragraf — "Merhaba <Ad>, ben Ali, Artelivo'dan." Artelivo'nun vizyonu (tüm sanat
//      dünyasını buluşturan platform, ilk arkadaşlarını arıyor), sanatçılara ücretsiz;
//      eserlerini/serilerini ADIYLA anıp ne derlediğimizi ve emek verdiğimizi
//      samimi anlatır; davet linki bu paragrafta; isterse sahiplenir, istemezse
//      siler.
//   (2. paragraf — Artelivo tanıtımı — kaldırıldı, kullanıcı 2026-10-21: tek mesaj.)
//   İmza "Sevgiler, Ali". E-posta / spam cümlesi YOK (mesaj Instagram'dan gider).
// Türk olmayanlara İngilizce (kullanıcı, 2026-10-21): aynı şablonun çevirisi,
// aynı kurallar. Dil sanatçının satırında (`dm_lang`).
// Link mesaja HAZIRLANIRKEN konur (kullanıcı linki elle eklemez).
// ============================================================================

/** Eski mesajlarda kalan yer tutucu — gönderimde yine linkle değişir. */
export const LINK_PLACEHOLDER = "{LINK}";

/**
 * Kullanıcının onayladığı ŞABLON (2026-10-21). Her mesaj buna göre kurulur;
 * sanatçıya ait kısım (kaynak, eser/seri adları, sergi, portre…) kişiselleşir.
 */
const TEMPLATE = `
Selam Seren, ben Ali, Artelivo'dan. Artelivo'yu sanatçıları, sanatseverleri, toplulukları ve iş dünyasını buluşturmak, sanatla ilgilenen herkesin bağ kurup birlikte örgütlenebileceği bir yer olsun diye kuruyoruz. Bu hayale çok inanıyoruz; sanatçılara ücretsiz ve şimdi ilk yol arkadaşlarımızı arıyoruz, sizi de aramızda görmek isteriz. Saatchi Art profilinizden In the Space Between. İstanbul ve Salt on the Skin. Sea Memory dahil sekiz akrilik işinizi portrenizle birlikte derledik; tek tek toplamak biraz emek istedi ama keyifliydi 🙂 Profiliniz şu an yalnızca size görünüyor, buradan bakabilirsiniz: <LINK> İsterseniz sahiplenebilir, istemezseniz aynı linkten tek tıkla silebilirsiniz.

Sevgiler, Ali
`;

/** TEMPLATE'in İngilizcesi (Türk olmayan sanatçılar; yapı ve ton aynı). */
const TEMPLATE_EN = `
Hi Seren, I'm Ali from Artelivo. We're building Artelivo to bring artists, art lovers, communities and the business world together, a place where everyone who cares about art can connect and organize together. We truly believe in this dream; it's free for artists, and right now we're looking for our first companions on the way, we'd love to have you with us. From your Saatchi Art profile, we gathered eight of your acrylic works, including In the Space Between. Istanbul and Salt on the Skin. Sea Memory, together with your portrait; collecting them one by one took some effort, but it was a joy 🙂 Your profile is visible only to you right now, you can take a look here: <LINK> If you like it, you can claim it; if not, you can delete it with one click from the same link.

Warmly, Ali
`;

export type DmLang = "tr" | "en";

/** Kullanıcının verdiği örnek mesajlar (e-posta yerine Instagram'a uyarlanmış). Ton bunlar. */
const EXAMPLES = `
Örnek 1:
Merhaba Nurgül, ben Ali, Artelivo'dan. Artelivo'yu sanatçıları, sanatseverleri, sanat topluluklarını ve iş dünyasını bir araya getirmek, sanatla ilgilenen herkesin bağlantı kurup örgütlenebileceği bir yer olsun diye kuruyoruz. Büyük hayal kuruyoruz ve buna gerçekten inanıyoruz; sanatçılara tamamen ücretsiz ve bu yolda ilk arkadaşlarımızı arıyoruz. Heykellerinizi, Absent, Dialogue ve Portable Ground gibi projelerinizi, sergilerinizi ve eğitim geçmişinizi tek tek derleyip sizin için bir profil hazırladık; bu kolay bir iş değildi, epey emek verdik 🙂 Profiliniz şu an yalnızca size görünüyor, buradan bakabilirsiniz: <LINK> İsterseniz sahiplenin, istemezseniz aynı linkten tek tıkla silebilirsiniz.

Örnek 2 (yalnız 1. paragraf):
Selam Pelin, ben Ali, Artelivo'dan. Artelivo, sanat dünyasının tamamını, yani sanatçıyı, sanatseveri, toplulukları ve kurumları buluşturmayı hayal eden, sanatçılara ücretsiz bir platform. Vizyonumuza çok güveniyoruz; ilk yol arkadaşlarımızı arıyoruz ve sizi de aramızda görmekten mutluluk duyarız. Renkli balık serinizden Derin Su(lar), Nirengi ve Alvo(ra) gibi işlerinizi portrenizle birlikte sizin için profile dönüştürdük; tek tek toplamak biraz zaman aldı ama değdi 😊 …

Örnek 3 (yalnız 1. paragraf):
Merhaba Tülay, ben Ali, Artelivo'dan. … Dilek Ağaçları, Doku Dokuma ve Semboller serilerinizi, kişisel ve karma sergilerinizi, hem hekim hem sanatçı hikâyenizi sizin için bir profilde topladık. Çok sayıda eser olduğu için seri seri ilerlemek epey emek istedi, ama değdi 🙂 … Bir eksik ya da yanlışı varsa söylemenizi isterim.
`;

const DmSchema = z.object({ text: z.string() });

export interface DmFacts {
  /** Profildeki ad (Saatchi'de Türkçe karaktersiz olabilir). */
  name: string;
  /** Kaynak: "Saatchi Art". */
  sourceLabel: string;
  /** Biyografi (Türkçe; adın Türkçe yazımı buradan anlaşılabilir). */
  biography: string | null;
  city: string | null;
  series: string[];
  workTitles: string[];
  worksCount: number;
  exhibitionsCount: number;
  soloCount: number;
  hasEducation: boolean;
  careerTitles: string[];
  hasPortrait: boolean;
  specialties: string[];
}

/**
 * Dil taslakta belirlenmediyse (eski satırlar): ad, biyografi ve şehirden.
 * Biyografi taslakta Türkçeleştirildi; asıl ipucu ad ve hikâye.
 */
export async function guessDmLang(facts: DmFacts, country: string): Promise<DmLang> {
  const out = await askJson({
    purpose: "dm-dil",
    schema: z.object({ language: z.enum(["tr", "en"]) }),
    effort: "low",
    system: [
      "Bir sanatçıya yazılacak Instagram mesajının dilini seç: \"tr\" ya da \"en\".",
      "Türkçe konuştuğu açıksa \"tr\" (Türkçe ad-soyad, Türkiye'de doğum/eğitim; yurt dışındaki Türkler de).",
      "Türkiye'de yaşasa da yabancıysa (yabancı ad, Türkiye dışında doğum/eğitim) \"en\".",
      `Emin değilsen: ${country === "TR" ? '"tr"' : '"en"'}.`,
    ].join("\n"),
    user: JSON.stringify({
      name: facts.name,
      city: facts.city,
      country,
      biography: facts.biography?.slice(0, 800) ?? null,
    }),
  });
  return out.language;
}

export async function writeDm(
  facts: DmFacts,
  link: string,
  lang: DmLang = "tr",
): Promise<string> {
  const out = await askJson({
    purpose: "dm",
    schema: DmSchema,
    effort: "medium",
    system: lang === "en" ? systemEn() : systemTr(),
    user: JSON.stringify({ ...facts, link }),
  });
  let text = out.text.trim();
  // Açılış her zaman "…, ben Ali, Artelivo'dan." / "…, I'm Ali from Artelivo." (kullanıcı, 2026-10-20).
  text =
    lang === "en"
      ? text.replace(
          /^((?:Hi|Hello|Hey)[^,\n]{1,40}),\s*(?:I['’]m|this is) Ali(?:,?\s*from Artelivo)?\s*[.,]/i,
          "$1, I'm Ali from Artelivo.",
        )
      : text.replace(
          /^((?:Merhaba|Selam)[^,\n]{1,40}),\s*ben Ali(?:,?\s*Artelivo['’]?dan)?\s*[.,]/,
          "$1, ben Ali, Artelivo'dan.",
        );
  // Link her durumda mesajda olmalı: yazılmadıysa 1. paragrafın sonuna.
  if (!text.includes(link)) {
    const parts = text.split(/\n\s*\n/);
    const lead = lang === "en" ? "You can view your profile here:" : "Profilinize buradan bakabilirsiniz:";
    parts[0] = `${parts[0]?.trim() ?? ""} ${lead} ${link}`;
    text = parts.join("\n\n");
  }
  return text;
}

function systemTr(): string {
  return [
    "Artelivo adına Ali olarak bir sanatçıya Instagram'dan ilk mesajı yazıyorsun. Türkçe, samimi, sıcak; resmî şablon gibi değil.",
    "Ton ve uzunluk için aşağıdaki örneklere bak; onları kopyalama, her mesaj farklı olsun (giriş: Merhaba/Selam, cümle yapısı, emoji).",
    "",
    "Biçim: tek paragraf + imza, başlık yok. Artelivo'yu tanıtan ikinci bir paragraf YAZMA.",
    '- AYNEN şöyle başla: "Merhaba <Ad>, ben Ali, Artelivo\'dan." ya da "Selam <Ad>, ben Ali, Artelivo\'dan." — YALNIZ ilk ad; Bey/Hanım yok. Ad Türkçe karakterle yazılıysa (biyografide Gülşen, Pazarbaşı gibi) o yazım.',
    "- Artelivo'yu kısa ama vizyonuyla tanıt (1–2 cümle). \"Bir sanat uygulaması\" gibi soğuk/sıradan tanım YOK. Artelivo tüm sanat dünyasını,",
    "  yani sanatçıları, sanatseverleri, sanat topluluklarını ve iş dünyasını bir araya getirmeyi amaçlayan; sanatla ilgilenen herkesin bağlantı kurup",
    "  örgütlenebileceği bambaşka bir vizyonu olan bir platform. Vizyonerdir ve kendine güvenir: bunu \"biz\" diliyle, açıkça ama sıcak bir gururla söyle",
    "  (ör. büyük hayal kurduğumuzu, buna inandığımızı); bu yolda İLK ARKADAŞLARINI arıyor, sanatçıyı da onlardan biri olmaya davet et.",
    "  Sanatçılara ücretsiz olduğunu da söyle. Her mesajda farklı cümlelerle; iddialı ama abartısız, satış dili değil.",
    "- DİL: baştan sona samimi ve sıcak; bir sanatçıya içtenlikle yazan bir insan gibi. Kurumsal, resmî, broşür ya da reklam cümlesi YOK.",
    "- Kaynaktaki profilinden (kaynak adını an) neleri derlediğimiz: serileri ve 2–3 eseri ADIYLA an (verilen adlardan),",
    "  varsa sergi geçmişi / eğitim / ödül / portre. Sayıları kuru liste gibi değil, doğal anlat.",
    "- Bunu tek tek derlemenin emek istediği, samimi ve tatlı bir dille (abartısız).",
    "- Profilin şu an yalnız ona göründüğü ve linkten bakabileceği; linki TAM olarak verildiği gibi, kendi başına yaz.",
    "- İsterse profili sahiplenebileceği, istemezse aynı linkten tek tıkla silebileceği.",
    'İmza: ayrı satırda "Sevgiler, Ali".',
    "",
    'YASAK: e-posta/spam cümlesi (mesaj Instagram\'dan gidiyor), satış dili, aciliyet, uydurma deneyim ("ekranımızda kaldı" gibi),',
    "verilmeyen eser/seri adı, cinsiyet bildiren hitap. Emoji en fazla bir tane.",
    "UZUNLUK (Instagram bir mesajda 1000 karakterden fazlasını keser; mesaj TEK parça gitmeli):",
    "paragraf link dahil EN FAZLA 850 karakter, imza dahil toplam 900'ü geçmesin.",
    "",
    "ŞABLON (kullanıcının onayladığı; mesajı BUNA göre kur, <LINK> yerinde gerçek link olur):",
    TEMPLATE,
    "Şablonun yapısını ve sırasını koru: açılış → Artelivo'nun vizyonu ve ilk yol arkadaşlarını araması → sanatçının profilinden derlediklerimiz ve emek → link → sahiplen/sil → imza.",
    "Artelivo kısmı şablona yakın kalsın (yalnız küçük ifade farkları). Sanatçıya ait kısmı ise TAMAMEN ona göre yaz: kaynak, seriler, eser adları, teknik, sergi/eğitim/ödül, portre.",
    "",
    "Ek ton örnekleri (eski; yapı için değil, sıcaklık için):",
    EXAMPLES,
    ].join("\n");
}

function systemEn(): string {
  return [
    "You are writing, as Ali from Artelivo, a first Instagram message to an artist. ENGLISH, warm and friendly; not like a formal template.",
    "Every message must be different (opening: Hi/Hello, sentence structure, emoji); do not copy the template word for word.",
    "",
    "Format: one paragraph + sign-off, no heading. Do NOT write a second paragraph introducing Artelivo.",
    '- Start EXACTLY like: "Hi <Name>, I\'m Ali from Artelivo." or "Hello <Name>, I\'m Ali from Artelivo." — FIRST name only; no Mr/Ms.',
    "- Introduce Artelivo briefly but with its vision (1–2 sentences). NO cold/ordinary description like \"an art app\". Artelivo aims to bring the whole art world",
    "  together: artists, art lovers, art communities and the business world; a place where everyone who cares about art can connect and organize.",
    "  It is visionary and confident: say it in a \"we\" voice, openly but with warm pride (we dream big, we believe in it); it is looking for its",
    "  FIRST COMPANIONS and invites the artist to be one of them. Say it is free for artists. Different wording each time; bold but not exaggerated, no sales talk.",
    "- TONE: sincere and warm throughout, like a person genuinely writing to an artist. No corporate, brochure or ad sentences.",
    "- What we gathered from their profile on the source (name the source): mention series and 2–3 works BY TITLE (only from the given titles,",
    "  exactly as given), and exhibition history / education / awards / portrait if present. Describe naturally, not as a dry list.",
    "  Some given facts (biography, series names, technique) are in Turkish: translate them naturally; never put Turkish words into the message.",
    "- That gathering it one by one took effort, said in a sweet, sincere way (not exaggerated).",
    "- That the profile is visible only to them right now and they can look at it via the link; write the link EXACTLY as given, on its own.",
    "- That they can claim the profile if they like it, or delete it with one click from the same link.",
    'Sign-off: on its own line, "Warmly, Ali".',
    "",
    "FORBIDDEN: email/spam sentences (the message goes via Instagram), sales talk, urgency, made-up experiences (\"it caught our eye\" etc.),",
    "work/series names not given, gendered forms of address. At most one emoji.",
    "LENGTH (Instagram cuts a message over 1000 characters; it must go as ONE piece):",
    "paragraph including the link AT MOST 850 characters, total with sign-off no more than 900.",
    "",
    "TEMPLATE (approved by the user; build the message on it, <LINK> becomes the real link):",
    TEMPLATE_EN,
    "Keep the template's structure and order: opening → Artelivo's vision and search for its first companions → what we gathered from the artist's profile and the effort → link → claim/delete → sign-off.",
    "Keep the Artelivo part close to the template (small wording differences only). Write the artist part ENTIRELY for them: source, series, work titles, technique, exhibitions/education/awards, portrait.",
  ].join("\n");
}
