-- ============================================================
-- 104: 郵便局 年間指名 — 様式1-6 生成ジョブ追跡（post_office_monthly_submissions 拡張）
-- 実行先: Supabase SQL Editor
-- 目的:
--   Phase 2 の「月次様式1-6の自動生成」を、施工計画書(seko)と同じ郵便受け方式で回すため、
--   生成ジョブの状態と成果物参照を post_office_monthly_submissions に持たせる。
--   ポータル(Render)が _queue にジョブ投入 → このPC常駐 po_agent.py が po_gen.py で xlsx 生成 →
--   共有ドライブへ回収 → ここの status/output_ref を更新。
-- 冪等: ADD COLUMN IF NOT EXISTS のみ。既存 103 のテーブルに列を足す。
-- ============================================================

ALTER TABLE post_office_monthly_submissions
  ADD COLUMN IF NOT EXISTS status         TEXT DEFAULT 'queued',   -- queued/processing/done/error
  ADD COLUMN IF NOT EXISTS message        TEXT,                    -- 進捗・エラーメッセージ
  ADD COLUMN IF NOT EXISTS report_date    DATE,                    -- 報告日（様式のAM12）
  ADD COLUMN IF NOT EXISTS job_name       TEXT,                    -- _queue のジョブフォルダ名
  ADD COLUMN IF NOT EXISTS job_folder_id  TEXT,                    -- 共有ドライブのジョブフォルダID
  ADD COLUMN IF NOT EXISTS output_name    TEXT,                    -- 生成ファイル名
  ADD COLUMN IF NOT EXISTS output_ref     TEXT,                    -- 成果物参照（例 drive:<id>）
  ADD COLUMN IF NOT EXISTS master_json    JSONB,                   -- 生成に使った入力（meta+cases）
  ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_po_sub_status ON post_office_monthly_submissions(status);
CREATE INDEX IF NOT EXISTS idx_po_sub_year_created
  ON post_office_monthly_submissions(fiscal_year, created_at DESC);
