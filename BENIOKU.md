# Artelivo Davet Masası

Saatchi Art'tan Türk sanatçıları bulur, Instagram hesaplarıyla eşleştirir, senin onayınla
Artelivo'da gizli bir taslak profil açar ve sanatçıya Instagram'dan kişiye özel bir davet
mesajı gönderir. Bulut rutini kullanılmaz; her şey bu bilgisayarda çalışır.

## Açmak

**Masaüstündeki "Artelivo Davet"** (ya da bu klasördeki `Artelivo Davet.command`) — çift tıkla.
Terminal açılır, uygulama tarayıcıda `http://127.0.0.1:4317` adresinde açılır. Terminal
penceresini kapatmak uygulamayı kapatır.

İlk açılışta:

1. `.env` dosyası oluşur ve açılır. Doldur:
   - `ARTIST_INVITE_AGENT_KEY` ve `ARTIST_INVITE_LINK_KEY`: Artelivo sunucusundaki `.env`'den.
   - Claude için anahtar GEREKMEZ: bu Mac'teki Claude Code (`claude`, Max hesabıyla girişli)
     kullanılır; ek ücret yok.
2. Yeniden aç → **Ayarlar → "Instagram'a giriş (bir kez)"**. Açılan Chrome penceresinde
   Instagram'a gir (ana tarayıcındaki hesapla aynı). Oturum bu pencerenin profilinde kalır.
3. **Ayarlar → "Bağlantıları dene"**: üç ✓ görmelisin.
4. **Ayarlar → test kullanıcı adını yaz → "Kendime test DM'i gönder"**: DM gönderimi çalışıyor mu.

## Akış

1. **Turlar** → kaynak + branş, ülke, eser aralığı (en az – en çok), kaç kişi →
   "Taramayı başlat". Saatchi'de branş + ülke listesinden, daha önce bakılmamış ve eser
   sayısı aralıkta olan sanatçılar toplanır. Aralık dışında kalan biri, sayısı başka bir
   turun aralığına girerse o turda yeniden gelir (yalnız eser sayısı tutulur, kişi bilgisi değil).
   Instagram'a arka planda istek ATILMAZ (hesabı korumak için); Saatchi profilinde Instagram
   linki varsa aday olarak hazır gelir. Bitince bildirim gelir.
   Tarama yarıda kalırsa (hata, uygulama kapandı) turda **"Devam ettir"** kaldığı sayfadan sürer.
2. **"Pencereyi aç"** → ekran ikiye bölünür: solda Saatchi profili, sağda Instagram adayı.
   Sol pencerenin altındaki çubuk: **Onayla (A) · Reddet (R) · Diğer profil (D) · Geç (G)**,
   ayrıca elle kullanıcı adı girme. Aday yoksa sağ pencerede Instagram araması adla hazır
   açılır: doğru profile tıkla → **"Sağdaki profili kullan (U)"**. Karar verince sıradakinin
   pencereleri açılır.
3. **Sanatçılar** → seç → **"Seçililerin taslağını oluştur"**. Taslaklar sırayla, tek tek
   oluşur (Saatchi'deki her şey MAPPING.md kurallarıyla alınır).
4. **"Seçililerin önizlemelerini aç"** → ana tarayıcında (Artelivo'ya yönetici girişli)
   önizlemeler açılır → her birinde **"Onayla"**. "Durumları yenile" ile burada da
   "Önizleme onaylı" görünür.
5. Seç → **"Seçililere mesaj hazırla"** → **Mesajlar**'da her mesajı oku, istersen düzelt.
   Davet linki mesaj hazırlanırken alınır ve mesajın içine yazılır (30 gün o an başlar;
   mesajları göndermeye yakın hazırla). Elle düzenlerken linki silersen gönderimde sona eklenir.
6. **"Seçilileri gönder"** → her biri için link alınır, Instagram'da profile gidilip DM
   gönderilir; günlük sınır ve bekleme süreleriyle, tek tek.

Sanatçı linki açınca e-postasını yazar, 6 haneli kodla doğrular ve profili alır — ya da
"istemiyorum" der, taslak silinir ve bir daha yazılmaz. Durumlar ("Profili aldı",
"Reddetti") Artelivo'dan kendiliğinden çekilir.

## Kurallar ve gizlilik

- Taranan herkes yalnız profil adresinin **özeti** olarak tutulur (`seen`); ad ve link
  yalnız sen karar verene kadar durur. Reddettiğin aday silinir, bir daha taranmaz.
- Instagram hız sınırları **Ayarlar**'da. Sınır dolunca iş ertesi sabaha kalır.
- `ARTIST_INVITE_LINK_KEY` yalnız bu bilgisayarda durur.

## Dosyalar

- `data/davet.sqlite` — yerel veritabanı · `data/chrome-profile` — Instagram oturumu
- `data/screenshots` — hata anlarının ekran görüntüleri
- Yeni bir kaynak site: `src/sources/<site>/` + `src/sources/index.ts`'e bir satır.
