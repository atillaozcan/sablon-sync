#!/usr/bin/env bash
# Şablon Sync — Cloudflare Worker + D1'i TEK KOMUTLA yayınla (kurucu için).
# Müşterinin hesabına deploy etmek için önce o hesapla `npx wrangler login` yapılır.
set -euo pipefail
cd "$(dirname "$0")"

echo "☁️  Şablon Sync — Cloudflare deploy"
command -v npx >/dev/null 2>&1 || { echo "Hata: node/npx gerekli."; exit 1; }
[ -d node_modules ] || npm install

# 1) Oturum (gerekiyorsa tarayıcı açılır)
npx wrangler whoami >/dev/null 2>&1 || npx wrangler login

# 2) D1 veritabanı oluştur (varsa mevcut id'yi bul), database_id'yi wrangler.jsonc'a yaz
OUT="$(npx wrangler d1 create sablon-sync-db 2>&1 || true)"
ID="$(printf '%s' "$OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)"
if [ -z "$ID" ]; then
  # D1 zaten var → mevcut id'yi hesap listesinden çek (config'e bağlı değil)
  ID="$(npx wrangler d1 list --json 2>/dev/null | python3 -c 'import sys,json;d=json.load(sys.stdin);print(next((x["uuid"] for x in d if x.get("name")=="sablon-sync-db"),""))' 2>/dev/null || true)"
fi
if [ -n "$ID" ]; then
  # database_id değerini (placeholder ya da eski) $ID ile değiştir
  sed -i.bak -E "s/(\"database_id\"[[:space:]]*:[[:space:]]*\")[^\"]*(\")/\1$ID\2/" wrangler.jsonc && rm -f wrangler.jsonc.bak
  echo "✓ D1 id: $ID (wrangler.jsonc'a yazıldı)"
else
  echo "⚠ D1 id alınamadı — wrangler.jsonc'daki database_id'yi elle kontrol et."
  printf '%s\n' "$OUT" | tail -3
fi

# 3) R2 bucket (dosya/belge deposu) oluştur (varsa yoksay)
npx wrangler r2 bucket create sablon-sync-files 2>&1 | grep -iE "created|already|success" | head -1 || true
echo "✓ R2 bucket: sablon-sync-files"

# 3) Yayınla
npx wrangler deploy

echo ""
echo "✅ Bitti. Yukarıda çıkan  https://sablon-sync.<hesap>.workers.dev  adresini"
echo "   programda Ayarlar → ☁️ Cloud ekranına yapıştırıp 'Bağlan'a bas."
