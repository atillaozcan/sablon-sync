// Şablon Sync — Cloudflare Worker + D1 senkron sunucusu.
// Müşterinin KENDİ Cloudflare hesabına kurulur (tek-tık Deploy). Verisi onun hesabında kalır.
//
// Uç noktalar:
//   GET  /            → tarayıcıda "çalışıyor" durum sayfası (müşteri güveni için)
//   GET  /health      → { ok, initialized, now }
//   POST /setup       → ilk kurulum: kimlik anahtarı (token) üretir/kaydeder (bir kereye mahsus)
//   GET  /pull?since= → verilen zamandan sonra değişen satırlar (records + kv)  [auth]
//   POST /push        → yerelde değişen satırları yükle (son-yazan-kazanır, sunucu saati)  [auth]
//   POST /reset       → tüm veriyi sil (baştan senkron için)  [auth + ?confirm=1]
//   PUT/GET/DELETE /file/<fid> → dosya/belge deposu (R2); kayıt yalnız fid referansı tutar  [auth]
//
// Güvenlik: Bearer token (D1 meta'da saklanır ya da env.SYNC_TOKEN ile sabitlenir).
// Şifreleme aktar: TLS (HTTPS). İsteyen istemci yükü ayrıca istemci-tarafı şifreleyebilir.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } })

let schemaReady = false
async function ensureSchema(env) {
  if (schemaReady) return
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS records (tbl TEXT NOT NULL, id TEXT NOT NULL, data TEXT, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tbl, id))`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_records_updated ON records(updated_at)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, updated_at INTEGER NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_kv_updated ON kv(updated_at)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`),
  ])
  schemaReady = true
}

async function getMeta(env, k) {
  const row = await env.DB.prepare(`SELECT v FROM meta WHERE k = ?`).bind(k).first()
  return row ? row.v : null
}
async function setMeta(env, k, v) {
  await env.DB.prepare(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(k, v).run()
}

// Aktif token: sabit env varsa onu, yoksa D1'de saklananı kullanır.
async function activeToken(env) {
  return (env.SYNC_TOKEN && String(env.SYNC_TOKEN)) || (await getMeta(env, 'auth_token'))
}
async function requireAuth(request, env) {
  const token = await activeToken(env)
  if (!token) return json({ error: 'not-initialized' }, 401)
  const auth = request.headers.get('Authorization') || ''
  if (auth !== 'Bearer ' + token) return json({ error: 'unauthorized' }, 403)
  return null // yetkili
}

const STATUS_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Şablon Sync</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;height:100vh;margin:0}
.card{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:32px 40px;text-align:center;max-width:420px}
h1{margin:0 0 6px;font-size:20px}.ok{color:#34d399;font-size:44px}.hint{color:#94a3b8;font-size:13px;line-height:1.5}</style>
<div class="card"><div class="ok">☁️✓</div><h1>Şablon Sync çalışıyor</h1>
<p class="hint">Bu, programınızın bulut senkron sunucusudur ve sizin kendi Cloudflare hesabınızda çalışır. Verileriniz size aittir.<br><br>Bu adresi programın <b>Ayarlar → Cloud</b> ekranına yapıştırın.</p></div>`

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'

    try {
      await ensureSchema(env)

      if (path === '/' && request.method === 'GET')
        return new Response(STATUS_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS } })

      if (path === '/health' && request.method === 'GET')
        return json({ ok: true, initialized: !!(await activeToken(env)), now: Date.now() })

      // İlk kurulum — token üret/kaydet (yalnızca henüz kurulmadıysa).
      if (path === '/setup' && request.method === 'POST') {
        if (await activeToken(env)) return json({ error: 'already-initialized' }, 409)
        const body = await request.json().catch(() => ({}))
        const token = (body && typeof body.token === 'string' && body.token) || crypto.randomUUID()
        await setMeta(env, 'auth_token', token)
        return json({ ok: true, token })
      }

      // Buradan sonrası yetki ister.
      if (path === '/pull' && request.method === 'GET') {
        const deny = await requireAuth(request, env); if (deny) return deny
        const since = Number(url.searchParams.get('since') || 0) || 0
        const limit = Math.min(Number(url.searchParams.get('limit') || 5000) || 5000, 10000)
        const recs = await env.DB.prepare(
          `SELECT tbl, id, data, updated_at, deleted FROM records WHERE updated_at > ? ORDER BY updated_at ASC LIMIT ?`
        ).bind(since, limit).all()
        const kvs = await env.DB.prepare(
          `SELECT k, v, updated_at FROM kv WHERE updated_at > ? ORDER BY updated_at ASC LIMIT ?`
        ).bind(since, limit).all()
        return json({ now: Date.now(), limit, records: recs.results || [], kv: kvs.results || [] })
      }

      if (path === '/push' && request.method === 'POST') {
        const deny = await requireAuth(request, env); if (deny) return deny
        const body = await request.json().catch(() => ({}))
        const now = Date.now() // sunucu saati = tek saat alanı (istemci saat sapması sorunu olmaz)
        const stmts = []
        for (const r of (body.records || [])) {
          if (r == null || r.tbl == null || r.id == null) continue
          stmts.push(env.DB.prepare(
            `INSERT INTO records (tbl, id, data, updated_at, deleted) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(tbl, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted`
          ).bind(String(r.tbl), String(r.id), r.data == null ? null : String(r.data), now, r.deleted ? 1 : 0))
        }
        for (const e of (body.kv || [])) {
          if (e == null || e.k == null) continue
          stmts.push(env.DB.prepare(
            `INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`
          ).bind(String(e.k), e.v == null ? null : String(e.v), now))
        }
        if (stmts.length) await env.DB.batch(stmts)
        return json({ ok: true, now, records: (body.records || []).length, kv: (body.kv || []).length })
      }

      if (path === '/reset' && request.method === 'POST') {
        const deny = await requireAuth(request, env); if (deny) return deny
        if (url.searchParams.get('confirm') !== '1') return json({ error: 'confirm-required' }, 400)
        await env.DB.batch([
          env.DB.prepare(`DELETE FROM records`),
          env.DB.prepare(`DELETE FROM kv`),
        ])
        return json({ ok: true })
      }

      // Dosya/belge deposu (R2). Kayıt sadece fid referansı tutar; blob R2'de.
      if (path.startsWith('/file/')) {
        const deny = await requireAuth(request, env); if (deny) return deny
        if (!env.BUCKET) return json({ error: 'no-bucket' }, 501)
        const fid = decodeURIComponent(path.slice('/file/'.length))
        if (!fid) return json({ error: 'bad-fid' }, 400)
        if (request.method === 'PUT') {
          const ct = request.headers.get('Content-Type') || 'application/octet-stream'
          await env.BUCKET.put(fid, request.body, { httpMetadata: { contentType: ct } })
          return json({ ok: true, fid })
        }
        if (request.method === 'GET') {
          const obj = await env.BUCKET.get(fid)
          if (!obj) return json({ error: 'not-found' }, 404)
          const h = new Headers(CORS)
          h.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream')
          h.set('Cache-Control', 'private, max-age=31536000')
          return new Response(obj.body, { headers: h })
        }
        if (request.method === 'DELETE') {
          await env.BUCKET.delete(fid)
          return json({ ok: true })
        }
        return json({ error: 'method-not-allowed' }, 405)
      }

      return json({ error: 'not-found' }, 404)
    } catch (err) {
      return json({ error: 'server-error', detail: String(err && err.message || err) }, 500)
    }
  },
}
