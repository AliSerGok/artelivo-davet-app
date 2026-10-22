# CLAUDE.md — Artelivo Davet Masası

Yerel masaüstü aracı (Node 24 + TypeScript, `tsx` ile çalışır, build yok). Kullanıcı belgesi:
[BENIOKU.md](BENIOKU.md). Artelivo'nun kendisi `../artemiz` deposunda.

## Kilitli kararlar (kullanıcı, 2026-10-19)

- **Bulut rutini kullanılmaz ve ayarlarına dokunulmaz.** Her şey bu uygulamada.
- Tarayıcıyı uygulama sürer (Playwright, `channel: "chrome"`, kalıcı profil `data/chrome-profile`).
  Ana Chrome profiline bağlanılmaz (Chrome 136+ reddeder); Instagram'a bu profilde bir kez girilir.
- Instagram hesabı = kullanıcının kendi hesabı (ayrı hesap yok). Hız sınırları ayarlardan.
- Sahiplenme linki YALNIZ bu uygulamada: `ARTIST_INVITE_LINK_KEY` ile `…/artist-invites/:id/link`.
  Link MESAJ HAZIRLANIRKEN alınıp metne yazılır (kullanıcı 2026-10-19; 30 gün o an başlar); gönderimde
  aynı link yeniden doğrulanır, metinde yoksa eklenir. Ajan anahtarı linki alamaz.
- KVKK: taranan herkes `seen`'de yalnız HMAC özeti; aday adı/linki yalnız karar verilene kadar.
- Ülke ve eser aralığı TURA ÖZEL (kullanıcı, 2026-10-19; varsayılan Türkiye, 10–30). Aralık dışı = `seen` içinde `works:N`, başka aralıkta yeniden bakılır.
- DM'ler samimi, her biri farklı; Artelivo ücretsiz; "sanat uygulaması" değil, tüm sanat dünyasını buluşturan ve ilk arkadaşlarını arayan, vizyoner ve kendine güvenen bir platform olarak, samimi ve sıcak bir dille tanıtılır; onaylı şablon `src/ai/dm.ts` `TEMPLATE` (sanatçıya göre kişiselleşir); TEK paragraf + imza, tek DM (tanıtım paragrafı 2026-10-21 kaldırıldı); Türk olmayanlara İngilizce
  (2026-10-21; ülke yetmez — dil `artists.dm_lang`, taslakta Claude tahmin eder, Mesajlar'dan değişir;
  `TEMPLATE_EN` çevirisi); kaynak ve
  "istemezseniz silinir" bilgisi her mesajda.
- İletişim bilgileri `artists.contacts` (JSON, `src/contacts`); Artelivo'ya gitmez, taslağın `email`
  alanı silinir. Instagram onayından sonra **bağlantı keşfi** (`discover` işi, `src/discover`): Saatchi +
  Instagram bio'su (onayda açık sayfadan okunur) + linkler; derinlik 2, en çok 15 sayfa (kullanıcı 2026-10-23).
- Kanallar (kullanıcı 2026-10-23): Instagram DM; "Mesaj" düğmesi yoksa **Threads** (aynı sınır/bekleme);
  güvenilir e-posta varsa **her durumda** davet e-postası da (`email` işi, info@artelivo.com, artemiz SMTP'si,
  metin DM'in aynısı). Pinterest ve Saatchi mesaj kanalı DEĞİL. Davetler Instagram kanalında kalır
  (artemiz'in e-posta kanalı linki DM'e vermez).
- Taslak alan kuralları artemiz'deki `apps/web/agent/artist-invites/MAPPING.md`'den OKUNUR (kopya yok).

## Yapı

- `src/sources/` — kaynak site adaptörleri (`SourceAdapter`); yeni site = yeni adaptör.
  Saatchi verisi sayfadaki `__NEXT_DATA__`'dan okunur (cm ölçü, tam hakkında/sergi metni, kapak,
  atölye, sosyal linkler, seriler); görünen metin yalnız yedek. Eser kimliği = adresteki sayı
  (eski eserlerde JSON `artworkID` farklı — çift okuma tuzağı).
- `src/drafts/structured.ts` — kaynak verisi taslağa KODLA yazılır (ölçü, yıl, görsel, başlık,
  portre, kapak, linkler); Claude metin/sınıflandırma yapar. Gönderimden önce `auditDraft`
  taslağı kaynağa karşı denetler, sonuç sanatçının satırında.
- `src/instagram/` — YALNIZ DM (Playwright, oturumlu). Arka plan arama/profil istekleri
  kaldırıldı (2026-10-19: topsearch 404, web_profile_info 429); arama onay penceresinde, elle.
- `src/artelivo/` — sanatçı daveti ajan API'si istemcisi.
- `src/ai/` — Claude Code CLI (`claude -p`, Max planı; API anahtarı alt sürece VERİLMEZ —
  kullanıcı kararı: ek ücret yok): taslak çıkarma, DM metni.
- `src/jobs/` — tek kuyruk, sırayla; `queue.ts` + `handlers.ts`.
- `src/review/` — bölünmüş ekran onay akışı (sol pencereye kontrol çubuğu basılır).
- `src/server.ts` — yerel arayüz (Hono, `127.0.0.1:4317`, Origin/Host kontrolü).

## Kontrol

`pnpm typecheck`. Instagram ve Saatchi arayüzleri değişirse yalnız ilgili adaptör güncellenir.
