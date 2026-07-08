-- ============================================================
-- 060: ISO 年間スケジュール
-- 実行先: Supabase SQL Editor
-- 目的:
--   審査懸念No.2（9.2）＝内部監査の実施時期が具体的に規定されていない、への対応。
--   内部監査=毎年11月／マネジメントレビュー=毎年12月を明文レコード化。
--   14001（環境）の審査・運用予定（1次審査≈2026年11月/2次≈2027年1月、
--   内部監査・レビュー2026-09-24）も登録。
--   RLS はオフ（アプリ側 requireAuth/requireAdmin で制御）。
-- ============================================================

DROP TABLE IF EXISTS iso_schedule CASCADE;
CREATE TABLE iso_schedule (
  id           SERIAL PRIMARY KEY,
  event_type   TEXT NOT NULL,                 -- 内部監査/マネジメントレビュー/審査/校正/フロン点検/訓練 等
  standard     TEXT[] NOT NULL DEFAULT '{}',  -- {'Q','S','E'}
  title        TEXT NOT NULL,
  planned_date DATE,                          -- 予定（月のみは月初）
  planned_note TEXT,                          -- '毎年11月','2026年11月(未定)' 等
  actual_date  DATE,                          -- 実施日
  status       TEXT NOT NULL DEFAULT 'planned'
                 CHECK (status IN ('planned','done','skipped')),
  note         TEXT,
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 9001/45001（認証済・毎年の定例）
INSERT INTO iso_schedule (event_type, standard, title, planned_note, sort_order) VALUES
  ('内部監査',             '{Q,S}', '内部監査（品質・労働安全衛生）', '毎年11月', 1),
  ('マネジメントレビュー', '{Q,S}', 'マネジメントレビュー（品質・労働安全衛生）', '毎年12月', 2);

-- 14001（環境・審査に向けた予定）
INSERT INTO iso_schedule (event_type, standard, title, planned_date, planned_note, sort_order) VALUES
  ('内部監査',             '{E}', '内部監査（環境）',             DATE '2026-09-24', '14001運用', 3),
  ('マネジメントレビュー', '{E}', 'マネジメントレビュー（環境）', DATE '2026-09-24', '14001運用', 4),
  ('審査',                 '{E}', 'ISO14001 1次審査',            DATE '2026-11-01', '2026年11月（未定）', 5),
  ('審査',                 '{E}', 'ISO14001 2次審査',            DATE '2027-01-01', '2027年1月（未定）', 6);

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('060_iso_schedule', now(), 'ISO 年間スケジュール（懸念2・内部監査時期明文化）') ON CONFLICT (version) DO NOTHING;
