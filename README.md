# ☁️ Şablon Sync — Bulut Senkron Sunucusu

Bu, Şablon programlarının **bulut senkron** sunucusudur. **Cloudflare Worker + D1** (serverless SQLite) **+ R2** (dosya/belge deposu) üstünde çalışır ve **müşterinin KENDİ Cloudflare hesabına** kurulur. Veriler müşteride kalır; bizim altyapımıza gitmez. Ücretsiz plan bir işletme için fazlasıyla yeter (D1: 5 GB, 5M okuma/gün · R2: 10 GB, egress bedava · Worker: 100k istek/gün).

> Aynı sözleşme NAS/Docker ile de karşılanabilir (bkz. `docs/CLOUD.md`). Uygulama yalnızca bir **URL + anahtar** bilir; arka uç takılıp çıkar.

---

## 🟢 Müşteri için: "Ben sadece tıklayayım" (teknik bilgi gerekmez)

1. **Ücretsiz Cloudflare hesabı aç:** https://dash.cloudflare.com/sign-up (yalnızca e-posta + şifre).
2. Aşağıdaki **Deploy** butonuna bas → Cloudflare açılır → **"Authorize"** de.
   Cloudflare, Worker + D1 veritabanını **senin hesabına** otomatik kurar.

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/atillaozcan/sablon-sync-worker)

   > Bu buton, kodu **senin Cloudflare hesabına** kurar (Worker + D1 + R2). Kod GitHub'da (public) durur — veri hep senin hesabında kalır.
3. Kurulum bitince Cloudflare sana bir **adres** verir: `https://sablon-sync.<hesabın>.workers.dev`
4. Bu adresi programda **Ayarlar → ☁️ Cloud → "Cloud'u Bağla"** kutusuna yapıştır, **Bağlan**'a bas. Program anahtarı otomatik alır. **Bitti.** ✅

Diğer bilgisayarları eklemek için: ilk bilgisayardaki **Ayarlar → Cloud**'da görünen **URL + anahtarı** öbür bilgisayara gir → aynı veriyi görürler.

---

## 🛠️ Kurucu (biz) için: elle kurulum / test

**Tek komut:** `./deploy.sh` (login + D1 oluştur + id yaz + deploy).

```bash
cd cloud/sablon-sync-worker
npm install
npm test                       # node:sqlite ile mantık testi (15 test) — eski macOS'te de çalışır

# 1) D1 veritabanı oluştur (çıkan database_id'yi wrangler.jsonc'a yaz)
npx wrangler d1 create sablon-sync-db

# 2) (opsiyonel) şemayı elle kur — Worker zaten ilk istekte otomatik kurar
npx wrangler d1 execute sablon-sync-db --remote --file=schema.sql

# 3) Yayınla
npx wrangler deploy
```

Sabit anahtar istersen (TOFU yerine): `npx wrangler secret put SYNC_TOKEN` → Worker onu kullanır, `/setup` devre dışı kalır.

### Yerel test
```bash
npx wrangler dev            # http://localhost:8787
curl localhost:8787/health
curl -X POST localhost:8787/setup -d '{"token":"test"}'
curl -X POST localhost:8787/push -H 'Authorization: Bearer test' \
  -H 'Content-Type: application/json' \
  -d '{"records":[{"tbl":"ks_customers","id":"1","data":"{\"id\":1,\"name\":\"Deneme\"}"}]}'
curl 'localhost:8787/pull?since=0' -H 'Authorization: Bearer test'
```

---

## 🔌 API (senkron sözleşmesi)

| Uç | Yöntem | Açıklama |
|---|---|---|
| `/` | GET | Tarayıcıda "çalışıyor" durum sayfası |
| `/health` | GET | `{ ok, initialized, now }` |
| `/setup` | POST | İlk kurulum: token üretir/kaydeder (bir kereye mahsus) |
| `/pull?since=<ts>` | GET | `since`'ten sonra değişen satırlar `{ now, records[], kv[] }` — **auth** |
| `/push` | POST | Değişen satırları yükle (son-yazan-kazanır, sunucu saati) — **auth** |
| `/reset?confirm=1` | POST | Tüm veriyi sil (baştan senkron) — **auth** |
| `/file/<fid>` | PUT/GET/DELETE | Dosya/belge deposu (R2) — kayıt yalnız fid tutar — **auth** |

Yetki: `Authorization: Bearer <token>`. Çakışma çözümü: **son-yazan-kazanır** (sunucu saatiyle) → istemci saat sapması sorun çıkarmaz. Silmeler `deleted=1` mezar taşıyla senkronlanır.

## 🔒 Güvenlik
- Taşımada **TLS/HTTPS** (Cloudflare otomatik).
- Depolama müşterinin **kendi hesabında** (biz erişemeyiz).
- İstenirse istemci, yükü göndermeden önce **istemci-tarafı şifreleyebilir** (Cloudflare bile okuyamaz).
- Yerel disk şifresi ayrı katman: FileVault/BitLocker + (opsiyonel) SQLCipher.
