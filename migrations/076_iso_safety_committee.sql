-- ============================================================
-- 076: ISO 安全衛生委員会（月次議事録）
-- 実行先: Supabase SQL Editor
-- 目的:
--   毎月の安全衛生委員会の議事録を電子化。閲覧=全社員、
--   追加・編集は管理者のみ（月次で確実に記録する運用のため）。
--   RLS はオフ（アプリ側で制御）。
-- ============================================================

DROP TABLE IF EXISTS iso_safety_committee CASCADE;
CREATE TABLE iso_safety_committee (
  id             SERIAL PRIMARY KEY,
  meeting_date   DATE NOT NULL,
  location       TEXT,                  -- 開催場所
  chair          TEXT,                  -- 議長
  attendees      TEXT,                  -- 出席者
  accident_count INT DEFAULT 0,         -- 災害件数
  ky_report      TEXT,                  -- KY活動報告
  patrol_result  TEXT,                  -- 巡回結果
  notes          TEXT,                  -- 注意事項
  discussion     TEXT,                  -- 協議事項
  next_date      DATE,                  -- 次回開催日
  summary_by     TEXT,                  -- 総評者
  summary        TEXT,                  -- 総評
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_iso_safety_committee_date ON iso_safety_committee(meeting_date DESC);

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('076_iso_safety_committee', now(), 'ISO 安全衛生委員会（月次議事録）') ON CONFLICT (version) DO NOTHING;
