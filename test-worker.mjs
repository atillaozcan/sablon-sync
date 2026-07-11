// Worker'ı gerçek workerd olmadan doğrula: env.DB'yi node:sqlite ile taklit et.
// Çalıştır: node --experimental-sqlite test-worker.mjs
import { DatabaseSync } from 'node:sqlite'
import worker from './src/index.js'

const db = new DatabaseSync(':memory:')
const r2 = new Map()
function stmt(sql) {
  return {
    _sql: sql, _args: [],
    bind(...a) { this._args = a; return this },
    all() { return { results: db.prepare(sql).all(...this._args) } },
    first() { const r = db.prepare(sql).get(...this._args); return r ?? null },
    run() { return db.prepare(sql).run(...this._args) },
  }
}
const env = {
  DB: {
    prepare: (sql) => stmt(sql),
    batch: async (stmts) => { for (const s of stmts) db.prepare(s._sql).run(...s._args) },
  },
  BUCKET: {
    async put(key, body, opts) { const buf = body != null ? await new Response(body).arrayBuffer() : new ArrayBuffer(0); r2.set(key, { buf, ct: (opts && opts.httpMetadata && opts.httpMetadata.contentType) || 'application/octet-stream' }) },
    async get(key) { const v = r2.get(key); return v ? { body: v.buf, httpMetadata: { contentType: v.ct } } : null },
    async delete(key) { r2.delete(key) },
  },
}

const call = async (method, path, { token, body } = {}) => {
  const headers = {}
  if (token) headers.Authorization = 'Bearer ' + token
  if (body) headers['Content-Type'] = 'application/json'
  const req = new Request('http://localhost' + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const res = await worker.fetch(req, env)
  let j = null; try { j = await res.clone().json() } catch {}
  return { status: res.status, j }
}
const callRaw = async (method, path, { token, body, ct } = {}) => {
  const headers = {}
  if (token) headers.Authorization = 'Bearer ' + token
  if (ct) headers['Content-Type'] = ct
  const req = new Request('http://localhost' + path, { method, headers, body })
  const res = await worker.fetch(req, env)
  return res
}

let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg) } else { fail++; console.log('  ✗ FAIL:', msg) } }

console.log('1) health (kurulmadan)')
let r = await call('GET', '/health')
ok(r.status === 200 && r.j.initialized === false, 'health initialized=false')

console.log('2) auth yokken pull reddedilir')
r = await call('GET', '/pull?since=0')
ok(r.status === 401, 'pull 401 (not-initialized)')

console.log('3) setup token üretir')
r = await call('POST', '/setup', { body: { token: 'secret123' } })
ok(r.status === 200 && r.j.token === 'secret123', 'setup returns token')

console.log('4) setup ikinci kez 409')
r = await call('POST', '/setup', { body: { token: 'x' } })
ok(r.status === 409, 'setup already-initialized 409')

console.log('5) yanlış token 403')
r = await call('GET', '/pull?since=0', { token: 'wrong' })
ok(r.status === 403, 'pull wrong token 403')

console.log('6) push bir kayıt')
r = await call('POST', '/push', { token: 'secret123', body: { records: [{ tbl: 'ks_customers', id: '1', data: JSON.stringify({ id: 1, name: 'Ali' }) }] } })
ok(r.status === 200 && r.j.records === 1, 'push 1 record')

console.log('7) pull since=0 kaydı döndürür')
r = await call('GET', '/pull?since=0', { token: 'secret123' })
ok(r.status === 200 && r.j.records.length === 1 && JSON.parse(r.j.records[0].data).name === 'Ali', 'pull returns Ali')
const ts1 = r.j.records[0].updated_at
ok(ts1 > 0, 'record has server updated_at')

console.log('8) pull since=now boş döner (delta)')
r = await call('GET', '/pull?since=' + ts1, { token: 'secret123' })
ok(r.status === 200 && r.j.records.length === 0, 'delta since=ts1 empty')

console.log('9) LWW: güncelleme kazanır')
await new Promise(res => setTimeout(res, 5))
r = await call('POST', '/push', { token: 'secret123', body: { records: [{ tbl: 'ks_customers', id: '1', data: JSON.stringify({ id: 1, name: 'Veli' }) }] } })
r = await call('GET', '/pull?since=0', { token: 'secret123' })
ok(r.j.records.length === 1 && JSON.parse(r.j.records[0].data).name === 'Veli', 'update overwrote → Veli')

console.log('10) silme (tombstone) senkronu')
r = await call('POST', '/push', { token: 'secret123', body: { records: [{ tbl: 'ks_customers', id: '1', data: null, deleted: 1 }] } })
r = await call('GET', '/pull?since=0', { token: 'secret123' })
ok(r.j.records.length === 1 && r.j.records[0].deleted === 1, 'deleted=1 tombstone returned')

console.log('11) kv senkronu')
r = await call('POST', '/push', { token: 'secret123', body: { kv: [{ k: 'ks_set_brandName', v: JSON.stringify('Dükkan') }] } })
r = await call('GET', '/pull?since=0', { token: 'secret123' })
ok(r.j.kv.length === 1 && JSON.parse(r.j.kv[0].v) === 'Dükkan', 'kv brandName synced')

console.log('12) R2 dosya: PUT/GET/DELETE')
let fr = await callRaw('PUT', '/file/f_test1', { token: 'secret123', ct: 'text/plain', body: 'merhaba-dosya-baytları' })
ok(fr.status === 200, 'file PUT 200')
fr = await callRaw('GET', '/file/f_test1', { token: 'secret123' })
const ftext = await fr.text()
ok(fr.status === 200 && ftext === 'merhaba-dosya-baytları', 'file GET içerik doğru')
ok(fr.headers.get('content-type') === 'text/plain', 'file content-type korunur')
fr = await callRaw('GET', '/file/f_yok', { token: 'secret123' })
ok(fr.status === 404, 'olmayan dosya 404')
fr = await callRaw('PUT', '/file/f_x', { ct: 'text/plain', body: 'x' })
ok(fr.status === 403, 'auth yok file PUT 403')
fr = await callRaw('DELETE', '/file/f_test1', { token: 'secret123' })
ok(fr.status === 200, 'file DELETE 200')
fr = await callRaw('GET', '/file/f_test1', { token: 'secret123' })
ok(fr.status === 404, 'silinen dosya 404')

console.log('13) reset confirm gerektirir')
r = await call('POST', '/reset', { token: 'secret123' })
ok(r.status === 400, 'reset without confirm 400')
r = await call('POST', '/reset?confirm=1', { token: 'secret123' })
ok(r.status === 200, 'reset confirm ok')
r = await call('GET', '/pull?since=0', { token: 'secret123' })
ok(r.j.records.length === 0 && r.j.kv.length === 0, 'after reset empty')

console.log('\n' + (fail === 0 ? '✅ TÜM TESTLER GEÇTI' : '❌ ' + fail + ' TEST BAŞARISIZ') + ' (' + pass + ' geçti)')
process.exit(fail === 0 ? 0 : 1)
