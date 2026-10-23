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
  Davet kapanınca `artists` satırı silinir ama ad + Instagram/kaynak linki `invite_outcomes`'ta kalır
  (kullanıcı 2026-10-23: "Davet sonuçları" sayfası — kim aldı, kim sildi; veri yalnız bu bilgisayarda).
- Ülke ve eser aralığı TURA ÖZEL (kullanıcı, 2026-10-19; varsayılan Türkiye, 10–30). Aralık dışı = `seen` içinde `works:N`, başka aralıkta yeniden bakılır.
- DM'ler samimi, her biri farklı; Artelivo ücretsiz; "sanat uygulaması" değil, tüm sanat dünyasını buluşturan ve ilk arkadaşlarını arayan, vizyoner ve kendine güvenen bir platform olarak, samimi ve sıcak bir dille tanıtılır; onaylı şablon `src/ai/dm.ts` `TEMPLATE` (sanatçıya göre kişiselleşir); TEK paragraf + imza, tek DM (tanıtım paragrafı 2026-10-21 kaldırıldı); Türk olmayanlara İngilizce
  (2026-10-21; ülke yetmez — dil `artists.dm_lang`, taslakta Claude tahmin eder, Mesajlar'dan değişir;
  `TEMPLATE_EN` çevirisi); kaynak ve
  "istemezseniz silinir" bilgisi her mesajda.
- İletişim bilgileri `artists.contacts` (JSON, `src/contacts`); Artelivo'ya gitmez, taslağın `email`
  alanı silinir. Instagram onayından sonra **bağlantı keşfi** (`discover` işi, `src/discover`): Saatchi +
  Instagram bio'su (onayda açık sayfadan okunur) + linkler; derinlik 2, en çok 15 sayfa (kullanıcı 2026-10-23).
  Sanatçının verdiği platform linkleri de AÇILIR (kullanıcı: "linklere gidip iyice bak"): Pinterest profil
  verisi (`partner.contact_email/phone`, girişsiz), Facebook "İletişim bilgileri" (giriş ister), Threads/
  TikTok/YouTube/Behance sayfası. Yalnız X, LinkedIn, Instagram kaydedilir; istisna: Instagram bio'sunda
  anılan @hesaplar (en çok 3) DM ile aynı sınır/beklemeyle açılır, e-postası yalnız hesap adı sanatçının
  adını taşıyorsa güvenilir (kullanıcı 2026-10-23). Platformda çıkan site 2. turda taranır.
  Telefonlar da (kullanıcı 2026-10-23): `tel:`, + ya da 0 ile başlayan 10–15 hane, WhatsApp linkinden numara;
  WhatsApp/Telegram linkleri sanatçının kendi sayfasında ad taşımasa da kaydedilir. Shopier platformdur.
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

### Oturum denetimi — `/session-review`

Kod değiştiren bir oturumun sonunda ya da kullanıcı istediğinde `session-review` skill'ini çalıştır.
Diff'i git'e göre değil, SessionStart ve Edit/Write hook'larının (`.claude/hooks/`) kaydettiği oturum
başı dosya hallerine göre alır; kapı `scripts/review/gate.mjs` (tsc, migration yalnız sona eklenir,
`scripts/review/invariants.json`'daki kilitli karar satırları). Bu yüzden:

- **Dosyaları Edit/Write ile düzenle.** Bash ile (`sed -i`, heredoc) yapılan düzenlemeyi kayıt görmez;
  dosya "atanamadı" diye düşer ve `--adopt` ile elle sahiplenilmesi gerekir.
- Kilitli kararı tutan bir satır taşınırsa `invariants.json`'daki kuralı da taşı.
- Önceden var olan sorunlar oturumun bulgusu değildir; ayrı listelenir ve oturumda düzeltilmez.
