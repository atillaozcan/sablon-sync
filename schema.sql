-- Şablon Sync — D1 şeması. Worker ilk istekte bunu otomatik oluşturur (ensureSchema),
-- ama istersen elle de kurabilirsin:  wrangler d1 execute sablon-sync-db --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS records (
  tbl        TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  data       TEXT,                        -- satırın JSON'u (silinmişse NULL olabilir)
  updated_at INTEGER NOT NULL,            -- sunucu saati (son-yazan-kazanır + delta imleci)
  deleted    INTEGER NOT NULL DEFAULT 0,  -- mezar taşı (silme senkronu)
  PRIMARY KEY (tbl, id)
);
CREATE INDEX IF NOT EXISTS idx_records_updated ON records(updated_at);

CREATE TABLE IF NOT EXISTS kv (
  k          TEXT PRIMARY KEY,
  v          TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kv_updated ON kv(updated_at);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
