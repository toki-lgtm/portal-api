-- ============================================================
-- 066: ISO 事故報告書（九州防衛局書式・第1報/第2報）
-- 実行先: Supabase SQL Editor
-- 目的:
--   工事関係者・公衆災害・もらい事故の発生を記録し、続報（労基署/警察対応、
--   事後対応）を積み上げる。閲覧=全社員、起票（POST）は現場もするため
--   requireAuthのみ、編集・削除は管理者のみ。
--   RLS はオフ（アプリ側で制御）。
-- ============================================================

DROP TABLE IF EXISTS iso_accident_updates CASCADE;
DROP TABLE IF EXISTS iso_accidents CASCADE;

CREATE TABLE iso_accidents (
  id                  SERIAL PRIMARY KEY,
  project_name        TEXT,                 -- 工事名
  ordering_agency     TEXT,                 -- 発注機関
  occurred_at         TIMESTAMPTZ,          -- 発生日時
  accident_type       TEXT,                 -- 工事関係者/公衆災害/もらい事故
  victim_affiliation  TEXT,                 -- 元請/下請
  victim_name         TEXT,                 -- 被災者氏名
  victim_age          INT,                  -- 被災者年齢
  victim_gender       TEXT,                 -- 被災者性別
  symptom             TEXT,                 -- 傷病名・症状
  occupation          TEXT,                 -- 職種
  summary             TEXT,                 -- 発生状況
  status              TEXT NOT NULL DEFAULT '進行中'
                        CHECK (status IN ('進行中', '復帰待ち', '完治', '完了')),
  created_by          TEXT,                 -- 起票アカウント（email）
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_iso_accidents_occurred ON iso_accidents(occurred_at DESC);

CREATE TABLE iso_accident_updates (
  id             SERIAL PRIMARY KEY,
  accident_id    INT NOT NULL REFERENCES iso_accidents(id) ON DELETE CASCADE,
  report_no      INT,                 -- 報番号（第1報/第2報...）
  report_date    DATE,
  cause_factors  TEXT,                -- 人的/物的/環境的要因
  labor_bureau   TEXT,                -- 労基署対応
  police         TEXT,                -- 警察対応
  followup       TEXT,                -- 事後対応
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_iso_accident_updates_accident ON iso_accident_updates(accident_id);

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('066_iso_accidents', now(), 'ISO 事故報告書（九州防衛局書式・第1報/第2報の続報管理）') ON CONFLICT (version) DO NOTHING;
