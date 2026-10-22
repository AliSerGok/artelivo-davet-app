# Bulgu sözleşmesi — önem, kanıt, aidiyet

Bu dosya `/session-review`'in, `session-reviewer` ve `finding-verifier`
agent'larının ortak dilidir. Bir bulgu bu üç ekseni de taşımadan rapora girmez.

## 1. Önem (S)

| Sınıf   | Ne demek (Davet Masası'na özgü)                                                                                                                                                                                                                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S1**  | Engelleyici. Geri alınamayan dış eylem yanlış gider: yanlış kişiye / iki kez / onaysız DM, Threads mesajı veya e-posta; hız sınırı ya da bekleme atlanır (hesap riski). KVKK ihlali (ham ad/link `seen`'e yazılır; reddedilen adayın satırı kalır; kişi verisi bu bilgisayardan dışarı — Artelivo, log, ağ — çıkar. Kapanan davetin adı yalnız `invite_outcomes`'ta kalabilir). Sahiplenme linki sızar, metinde yanlış/eksik gider ya da ajan anahtarıyla alınır. `ANTHROPIC_API_KEY` alt sürece geçer. Sunucu 127.0.0.1 dışına açılır ya da Origin/Host denetimi delinir. İletişim bilgisi Artelivo'ya gider. Veri kaybı/bozulması; mevcut DB'de çalışmayan migration; `tsc` kırık; bulut rutinine dokunulur |
| **S2**  | Önemli. İstenen iş yanlış veya eksik; daha önce çalışan davranışta regresyon (kuyruk işi takılır, tarama kaldığı yerden sürmez); DM şablon kurallarına aykırı metin (iki paragraf, kaynak / "istemezseniz silinir" eksik, yanlış dil); taslak kaynağa aykırı (ölçü, yıl, görsel) ve `auditDraft` yakalamıyor; sessizce başarısız olan iş (hata kullanıcıya görünmüyor); Artelivo ajan API sözleşmesine uyumsuzluk |
| **S3**  | Küçük. Kenar durum, arayüzde küçük bozukluk, gereksiz tarayıcı/ağ isteği                                                                                                                                                                                                                                                                                                                                 |
| **Not** | İyileştirme önerisi. **Bulgu değildir**, karara girmez, raporda en fazla 3 tane                                                                                                                                                                                                                                                                                                                           |

Stil, isimlendirme, "şöyle daha temiz olur" → Not bile değildir, yazılmaz.

## 2. Kanıt (K)

| Sınıf  | Ne demek                                                                                                                         |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- |
| **K3** | Çalıştırıldı: başarısız bir komut, tsc çıktısı, kapı denetimi ya da yan etkisiz sonda betiği. Çıktının ilgili satırı rapora konur. |
| **K2** | İzlendi: somut girdi → `dosya:satır` zinciri → yanlış sonuç. Zincirin her halkası koddan alıntılanabilir olmalı.                  |
| **K1** | Şüphe: desen benzerliği, "olabilir", "kontrol edilmeli". Somut girdi yok.                                                        |

**Kural: K1 ile S1/S2 olmaz.** K1 bir bulgu değil, "Doğrulanmamış risk"tir;
ayrı bölümde, tek satır, neyin kanıtlanması gerektiğiyle birlikte yazılır.
Deterministik kapıdan (tsc, migrations, invariants) gelen her şey zaten K3'tür.

Sondalar **yan etkisiz** olmalı: `data/` altındaki gerçek DB'ye yazmaz,
tarayıcıyı (Instagram/Threads oturumu) sürmez, DM/e-posta göndermez, Artelivo
API'sine yazmaz. `src/` modülleri gerçek DB'yi dolaylı açtığı için sonda her
zaman `DB_FILE=<probes>/probe.sqlite` ile çalışır. `scripts/try-*.ts` bu
yüzden kanıt aracı değildir.

## 3. Aidiyet (A)

| Sınıf           | Ölçüt                                                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **YENİ**        | Sorunlu satır oturumun eklediği satırlarda (`scope.json` → `addedLines`), ya da kusur pre-image'da yok, şimdiki halde var              |
| **REGRESYON**   | Kusur oturumun DOKUNMADIĞI kodda görünüyor ama sebebi oturumun değişikliği (değişen bir tip, imza, sorgu, ayar, varsayılan değer)      |
| **ÖNCEDEN VAR** | Aynı kusur pre-image'da da var (`.claude/session-review/<sid>/preimages/<yol>`). Karara girmez; rapora ayrı bölümde, düzeltilmez       |
| **ATANAMADI**   | Kusur gerçek ama oturumun değişikliğine bağlanamıyor (ör. `unattributed` listesindeki bir dosya). Tahmin edilmez                       |

Aidiyet her zaman pre-image'a bakılarak verilir, hafızadan değil.

## 4. Parmak izi (tekrarı önleme)

```
<kategori>|<dosya>|<sembol>|<iddianın özü, 8 kelimeyi geçmez>
```

- `kategori`: `correctness`, `regression`, `data-integrity`, `privacy`,
  `outbound` (DM/e-posta/Threads), `rate-limit`, `invite-link`, `security`,
  `error-path`, `contract`, `migration`, `type`, `scope`
- `sembol`: fonksiyon/route/iş türü adı. Satır numarası parmak izine **girmez** (kayar).
- Aynı parmak izi = aynı bulgu. Birleştirilirken en yüksek kanıt sınıfı ve
  tüm kaynaklar (`gate`, `reviewer`) korunur.

## 5. Karar

| Karar              | Koşul                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------- |
| **KALDI**          | En az bir doğrulanmış (K2/K3) YENİ veya REGRESYON S1/S2 açık ve kullanıcı kabul etmedi |
| **NOTLARLA GEÇTİ** | S1/S2 yok; S3, doğrulanmamış risk veya çalıştırılamayan kontrol var                    |
| **GEÇTİ**          | S1/S2/S3 yok, gerekli bütün kontroller çalıştı                                         |

## 6. Bitti sayılmak için (kapsam listesi)

- [ ] Değişen her dosya incelendi ya da gerekçeyle dışarıda bırakıldı
- [ ] Kabul listesindeki her madde: tamam / kısmi / eksik — kanıtıyla
- [ ] `gate.mjs` çalıştı; tsc, migrations ve invariants sonuçları raporda
- [ ] Her S1/S2: düzeltildi ve yeniden doğrulandı, ya da kullanıcı açıkça kabul etti
- [ ] `unattributed` listesi ya sahiplenildi (`--adopt`) ya da "başka oturum" diye not edildi

Bu liste tamamsa inceleme biter. "Başka bir şey var mı" diye ikinci bir tarama
turu **yapılmaz**; aynı diff'i yeniden taramak yalnız örnekleme gürültüsü üretir.
