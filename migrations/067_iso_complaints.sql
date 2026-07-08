-- ============================================================
-- 067: ISO 苦情記録
-- 実行先: Supabase SQL Editor
-- 目的:
--   顧客・第三者からの苦情の受付〜原因〜対応〜是正効果確認までを記録。
--   現場も起票するため POST は requireAuth のみ、編集・削除は管理者のみ。
--   2025年実績なしのため seed 不要。
--   RLS はオフ（アプリ側で制御）。
-- ============================================================

DROP TABLE IF EXISTS iso_complaints CASCADE;
CREATE TABLE iso_complaints (
  id             SERIAL PRIMARY KEY,
  received_date  DATE,                 -- 受付日
  receiver       TEXT,                 -- 受付者
  method         TEXT,                 -- 一般/施主/その他
  project_name   TEXT,                 -- 関連工事名
  complainant    TEXT,                 -- 申出者
  content        TEXT NOT NULL,        -- 苦情内容
  cause          TEXT,                 -- 原因
  response       TEXT,                 -- 対応内容
  prevention     TEXT,                 -- 再発防止策
  effectiveness  TEXT,                 -- 是正効果の確認
  approver       TEXT,                 -- 承認者
  status         TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', '対応中', 'closed')),
  created_by     TEXT,                 -- 起票アカウント（email）
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_iso_complaints_date ON iso_complaints(received_date DESC);

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('067_iso_complaints', now(), 'ISO 苦情記録（受付〜原因〜対応〜是正効果確認）') ON CONFLICT (version) DO NOTHING;
