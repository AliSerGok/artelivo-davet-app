---
name: session-review
description: Bu oturumda yapılan değişikliği denetler — istenen iş doğru yapıldı mı, yeni hata veya regresyon var mı, kilitli kararlar (DM kuralları, KVKK, davet linki, hız sınırları) korunuyor mu, tsc geçiyor mu. Oturum başındaki dosya hallerine göre çalışır; önceden var olan sorunları oturumun bulgusu saymaz. "Oturumu denetle", "session review", "yaptığımızı kontrol et", "bitirmeden önce gözden geçir" denildiğinde ya da kullanıcı oturumu kapatırken bir değişiklik yapılmışsa kullan. Genel proje denetimi için DEĞİL.
---

# Session Review

Amaç **daha çok bulgu değil**: oturumun değişikliği için önemli, kanıtlı,
tekrarsız ve doğrulanabilir bir karar. Önem, kanıt, aidiyet ve "bitti"
tanımları [references/severity.md](references/severity.md)'de. Oradaki
sözleşmenin dışına çıkan bir bulgu rapora girmez.

## Çalıştırma ilkeleri

- **Sınırlı bir prosedür, açık uçlu bir arama değil.** Bir tam tur, düzeltme
  varsa bir artımlı yeniden kontrol, sonra biter. "Başka ne var" turu yok.
- **Önce deterministik, sonra model.** tsc ve kapı denetimlerinin bulduğunu
  bir agent'a yeniden buldurma.
- **İnceleme sırasında kod düzeltme.** Önce rapor; düzeltmeye kullanıcı karar verir.
- **Dış eylem yok.** İnceleme uygulamayı başlatmaz, `scripts/try-*.ts`
  çalıştırmaz, `data/` DB'sine yazmaz, tarayıcıyı sürmez, DM/e-posta
  göndermez, Artelivo API'sine yazmaz.
- Bu oturumda kodu sen yazdın. Bulguları kendin yargılama: inceleme
  `session-reviewer`'ın, hüküm `finding-verifier`'ın işi. Senin işin
  orkestrasyon, birleştirme ve rapor.

## 0. Oturum kimliği

`$CLAUDE_REVIEW_SESSION` (SessionStart hook'u yazar). Yoksa scratchpad
dizininin **bir üst klasörünün adı** oturum kimliğidir
(`…/<oturum-kimliği>/scratchpad`). Son parça her zaman `scratchpad`'dır, kimlik
değildir. Betiklere `--session <id>` ile ver.

**Kayıt yoksa** (oturum hook'lardan önce başladıysa), `session-scope.mjs`
"Oturum kaydı yok" der. O zaman:

- Bu oturumda düzenlediğin dosyaları konuşmadan listele.
- Her dosyanın eski halini `git show HEAD:<yol>` ile scratchpad'de bir
  `review/preimages/<yol>` dizinine çıkar. Diff'i `git diff HEAD -- <dosyalar>`
  ile, yeni dosyalar için `git diff --no-index /dev/null <yol>` ile al ve
  `review/session.diff` olarak kaydet. Agent'lara bu yolları ver, çünkü
  `.claude/session-review/<id>/` dizini yok. `report.md` ve
  `preexisting.md`'yi de aynı yere yaz.
- Oturum başındaki `git status`'ta (konuşmanın başında) temiz görünen ve
  aradaki commit'lerin dokunmadığı dosyalarda HEAD sürümü gerçek eski haldir.
  Bunlar için aidiyet sağlamdır. Geri kalan dosyalar için raporun başına şunu
  yaz: "⚠️ Başlangıç kaydı yok — diff HEAD'e göre; başka oturumların
  commitlenmemiş değişiklikleri karışmış olabilir, aidiyetler zayıf."
- gate.mjs çalışmaz. `pnpm typecheck`'i elle çalıştır; `src/db/index.ts`
  değiştiyse `MIGRATIONS`'ın eski kayıtlarının aynen durduğunu ve
  `scripts/review/invariants.json`'daki desenlerin yerinde olduğunu elle
  kontrol et. §8'deki artımlı mod da çalışmaz; yeniden kontrolü düzeltilen
  dosyalara bakarak elle yap.

## 1. Kabul listesi — diff'e bakmadan ÖNCE

Konuşmadan kullanıcının bu oturumda istediklerini numaralı, test edilebilir
maddeler halinde yaz. Örnek: "Instagram'da 'Mesaj' düğmesi yoksa DM Threads'ten
gider; aynı günlük sınır ve bekleme uygulanır." Kullanıcının sonradan
değiştirdiği istekler son haliyle yazılır. Bu oturumda verilen ve CLAUDE.md'ye
"kilitli karar" olarak yazılan kararlar da maddedir. Bu liste inceleyicinin
ölçütüdür. Diff'ten sonra yazılırsa yapılanı tarif eder, istenen yerine.

## 2. Kapsam

```bash
node scripts/review/session-scope.mjs --session <id>                  # ilk inceleme
node scripts/review/session-scope.mjs --session <id> --incremental    # damgadan sonrası
```

`⚠️ ATANAMADI` listesi doluysa:

- Bu oturumda **Bash ile** düzenlediğin dosyaları sahiplen:
  `--adopt yol1,yol2`. Bu çağrı kapsamı da yeniden üretir. Oturum başında
  git dışında olan bir dosya sahiplenilemez, çünkü eski hali bilinmez; betik
  bunu söyler. O dosyayı elle incele.
- Geri kalanlar başka oturumların işidir. İnceleme dışında kalır ve raporda
  tek satırla not edilir. Asla toptan sahiplenme.

## 3. Deterministik kapı

```bash
node scripts/review/gate.mjs --session <id>
```

Üç denetim:

- **tsc** (`tsconfig` yalnız `src/`'i kapsar). Hata yerleri:
  - `added-line` → YENİ.
  - `touched-file` → büyük olasılıkla YENİ; pre-image'a bak.
  - `untouched-file` → REGRESYON adayı (değişen bir tip/imza) ya da başka
    oturumun işi. Hatanın sembolü oturumun değiştirdiği bir şeye bağlanıyorsa
    REGRESYON, bağlanmıyorsa ATANAMADI.
  - `△ tsconfig dışında` (ör. `scripts/*.ts`) → tip denetimi yok; inceleyiciye söyle.
- **migrations** — `MIGRATIONS` yalnız sona eklenir. Eski bir kaydı değiştirmek
  ya da silmek kullanıcının mevcut DB'sinde hiç çalışmaz → S1.
- **invariants** — `scripts/review/invariants.json`'daki kilitli kararların
  satırı silindiyse kapı kapanır. Kod bilerek taşındıysa kuralı da taşı ve
  raporda söyle; kuralı sessizce silme.

Kapı bulguları K3'tür; doğrulamaya gönderilmez.

## 4. İnceleme

Bir **`session-reviewer`** başlat. Prompt'una şunları koy:

- kabul listesi,
- `scope.json` ve `session.diff` yolları,
- pre-image dizini,
- kapı özeti (3–10 satır).

Senin gerekçeni, uygulama notlarını ve "şunu bilerek yaptım" açıklamalarını
**koyma**. Bağımsızlık buradan gelir.

**Bölme:** yalnız diff çok büyükse (eklenen satır toplamı ~600'ü geçiyor)
alan başına bir `session-reviewer` başlat (ör. `src/server.ts` + `src/ui/` ·
`src/instagram/` + `src/jobs/` + `src/mail/` · geri kalanı), hepsini tek
mesajda. Dikkat türüne göre (güvenlik, performans…) asla bölme; bu, aynı
satıra üç agent baktırır ve tekrar üretir.

## 5. Birleştirme

- Bulguları parmak izine göre birleştir. Aynı iz, aynı bulgudur. En yüksek
  kanıtı ve tüm kaynakları tut.
- Kapının zaten raporladığı bir şeyi agent da yazdıysa kapınınkini tut.
- ÖNCEDEN VAR olanları ayır. Karara girmezler.
- K1 olanları "doğrulanmamış risk" bölümüne taşı.

## 6. Doğrulama

Kapıdan gelmeyen her S1/S2 adayı için bir `finding-verifier` başlat. Hepsini
tek mesajda başlat; adaylar 3'ten fazlaysa ilgili olanları bir agent'ta
topla. Doğrulayıcıya yalnızca şunları ver:

- parmak izi, iddia, konum, senaryo,
- oturum kimliği ve pre-image yolu.

Bulucunun gerekçesini verme. Hükme göre:

- ÇÜRÜTÜLDÜ → rapordan çıkar (yalnız sayısı yazılır).
- DOĞRULANAMADI → doğrulanmamış riske düşür.
- DOĞRULANDI → doğrulayıcının verdiği önem ve aidiyetle kalır.

S3'ler doğrulanmaz. K2 kalırlar, değilse riske düşerler.

## 7. Rapor

Terminale yaz, aynısını `.claude/session-review/<id>/report.md`'ye kaydet.
Önceden var olan bulguları ayrıca `.claude/session-review/<id>/preexisting.md`'ye
yaz; bunlar proje denetiminin konusudur.

```
# Oturum incelemesi — <KARAR>
<tek cümle gerekçe> · kapsam: <N dosya, +a/-b> · <tam|artımlı>

## Kabul listesi
1. … — tamam|kısmi|eksik — kanıt

## Bulgular (YENİ / REGRESYON)
### S1/S2
- [S? K? A?] dosya:satır — iddia
  senaryo: …
  kanıt: …
### S3
- …

## Doğrulanmamış riskler
- … (neyin kanıtlanması gerekiyor)

## Kontroller
tsc: ✓/✗ · migrations: ✓/✗/— · kilitli kararlar: ✓/✗/—
çürütülen aday: N

## Kapsam dışı
- Önceden var olan: N (preexisting.md) · Başka oturumun değişikliği: N dosya

## Notlar (≤3)
```

Boş bölümleri tek satırla geç ("yok"). Bulgu yoksa rapor kısa olur; kısa
rapor iyi bir sonuçtur.

**Raporu yazar yazmaz damgala.** Damga, raporun kapsadığı hali "incelendi"
diye kaydeder. Düzeltme turunun artımlı diff'i bu damgaya göre alınır;
damga olmadan `--incremental` reddeder.

```bash
node scripts/review/session-scope.mjs --session <id> --stamp
```

## 8. Düzeltmeden sonra

Kullanıcı bulguların düzeltilmesini isterse ve düzeltme yapılırsa:

1. `session-scope.mjs --incremental` ve `gate.mjs` çalıştır. Diff yalnızca
   düzeltmeyi gösterir.
2. Yalnızca düzeltilen bulguları yeniden doğrula: komutu yeniden çalıştır ya
   da zinciri yeniden yürü. Yeni bir inceleyici tarama turu başlatma.
   Düzeltme diff'i büyükse (yeni bir özellik gibi) tek bir `session-reviewer`
   yalnızca o artımlı diff'e bakar.
3. Kararı güncelle ve yeniden damgala (`--stamp`). Sonraki çağrı yalnızca
   bundan sonrasına bakar.
