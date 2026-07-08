-- ============================================================
-- 074: ISO アルコールチェック（運転前後の酒気帯び確認）
-- 実行先: Supabase SQL Editor
-- 目的:
--   道路交通法の安全運転管理者制度に基づくアルコールチェック記録の電子化。
--   現場が都度記録する類のため、起票（POST）は requireAuth のみ、
--   編集・削除は管理者のみ。RLS はオフ（アプリ側で制御）。
-- ============================================================

DROP TABLE IF EXISTS iso_alcohol_checks CASCADE;
CREATE TABLE iso_alcohol_checks (
  id         SERIAL PRIMARY KEY,
  check_date DATE NOT NULL,
  driver     TEXT NOT NULL,             -- 運転者
  timing     TEXT NOT NULL,             -- 出発/帰着
  method     TEXT NOT NULL,             -- 目視/検知器/リモート
  result     TEXT NOT NULL DEFAULT '非検知' CHECK (result IN ('検知', '非検知')),
  value      NUMERIC,                   -- 検知器の数値（mg/L等）
  checker    TEXT,                      -- 確認者
  note       TEXT,
  created_by TEXT,                      -- 起票アカウント（email）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_iso_alcohol_date ON iso_alcohol_checks(check_date DESC);
CREATE INDEX idx_iso_alcohol_driver ON iso_alcohol_checks(driver);

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('074_iso_alcohol_checks', now(), 'ISO アルコールチェック（出発/帰着の酒気帯び確認記録）') ON CONFLICT (version) DO NOTHING;
