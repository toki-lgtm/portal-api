-- ============================================================
-- 068: ISO 顧客満足度調査
-- 実行先: Supabase SQL Editor
-- 目的:
--   民間調査（アンケート）/公共評定を記録。設問1・2の点数とコメント、
--   総合コメント、正規化点数（比較用）を保持。
--   閲覧=全社員、登録・編集・削除は管理者のみ（アンケート回収は事務局が集約入力）。
--   RLS はオフ（アプリ側で制御）。
-- ============================================================

DROP TABLE IF EXISTS iso_customer_satisfaction CASCADE;
CREATE TABLE iso_customer_satisfaction (
  id                SERIAL PRIMARY KEY,
  project_name      TEXT,                 -- 工事名
  source_type       TEXT NOT NULL DEFAULT '民間調査'
                       CHECK (source_type IN ('民間調査', '公共評定')),
  customer          TEXT,                 -- 顧客・発注者名
  sent_date         DATE,                 -- 調査発送日
  received_date     DATE,                 -- 回収日
  q1_score          INT CHECK (q1_score BETWEEN 1 AND 5),
  q1_comment        TEXT,
  q2_score          INT CHECK (q2_score BETWEEN 1 AND 5),
  q2_comment        TEXT,
  other_comment     TEXT,
  normalized_score  NUMERIC,             -- 正規化点数（比較用）
  created_by        TEXT,                -- 登録アカウント（email）
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_iso_csat_received ON iso_customer_satisfaction(received_date DESC);

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('068_iso_customer_satisfaction', now(), 'ISO 顧客満足度調査（民間調査/公共評定）') ON CONFLICT (version) DO NOTHING;
