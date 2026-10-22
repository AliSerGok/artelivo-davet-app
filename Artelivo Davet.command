#!/bin/bash
# Çift tıklayınca Artelivo Davet Masası'nı başlatır ve tarayıcıda açar.
# Pencereyi kapatmak uygulamayı da kapatır.
# Masaüstündeki kısayol bir sembolik bağlantı: gerçek klasöre git.
SELF="$0"
[ -L "$SELF" ] && SELF="$(readlink "$SELF")"
cd "$(dirname "$SELF")" || exit 1

# nvm ile kurulu Node'u bul (Finder'dan açılan Terminal profili yüklemeyebilir).
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js bulunamadı. https://nodejs.org adresinden kur (22 veya üstü)."
  read -n 1 -s -r -p "Kapatmak için bir tuşa bas..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "İlk açılış: bağımlılıklar kuruluyor…"
  if command -v pnpm >/dev/null 2>&1; then pnpm install; else npm install; fi
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "⚠️  .env oluşturuldu — anahtarları doldurup yeniden aç: $(pwd)/.env"
  open -e .env
  read -n 1 -s -r -p "Kapatmak için bir tuşa bas..."
  exit 1
fi

# Anahtarlar yalnız bu kullanıcıya okunur olsun.
chmod 600 .env 2>/dev/null

# Önceki açılıştan geride kalmış bir sunucu varsa (bu klasörden) kapat; yoksa
# yeni açılış "port kullanımda" diye düşer.
for pid in $(lsof -tiTCP:4317 -sTCP:LISTEN 2>/dev/null); do
  if [ "$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" = "$(pwd)" ]; then
    echo "Önceki oturum kapatılıyor…"
    kill "$pid" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -9 "$pid" 2>/dev/null
  fi
done

# tsx'in sarmalayıcısı yerine tek süreç: pencere kapanınca (SIGHUP) sunucu
# doğrudan sinyali alır, öksüz kalmaz.
exec node --import tsx src/server.ts
