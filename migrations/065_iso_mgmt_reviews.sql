-- ============================================================
-- 065: ISO マネジメントレビュー（ISO 9.3）
-- 実行先: Supabase SQL Editor
-- 目的:
--   経営層によるマネジメントレビューの実施記録。インプット/アウトプット項目を
--   条項別に保持する。実データなし・新規運用開始のため空テーブル。RLSオフ。
-- ============================================================

DROP TABLE IF EXISTS iso_mgmt_review_items CASCADE;
DROP TABLE IF EXISTS iso_mgmt_reviews CASCADE;

CREATE TABLE iso_mgmt_reviews (
  id           SERIAL PRIMARY KEY,
  review_date  DATE,
  location     TEXT,
  attendees    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE iso_mgmt_review_items (
  id          SERIAL PRIMARY KEY,
  review_id   INT NOT NULL REFERENCES iso_mgmt_reviews(id) ON DELETE CASCADE,
  io_type     TEXT CHECK (io_type IN ('input','output')),
  clause_ref  TEXT,
  label       TEXT,
  content     TEXT,
  sort_order  INT DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_iso_review_items_review ON iso_mgmt_review_items(review_id);

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('065_iso_mgmt_reviews', now(), 'ISO マネジメントレビュー（ISO9.3）＋インプット/アウトプット項目。seedなし') ON CONFLICT (version) DO NOTHING;
