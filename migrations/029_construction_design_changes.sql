-- ============================================================
-- 029: 工事管理 - 設計変更（変更契約）対応
-- 実行先: Supabase SQL Editor
-- 目的:
--   施工中に発生する設計変更（数量増減・追加工事・工法変更等）を記録し、
--   変更契約の締結とそれに伴う工事基本情報（金額・工期）の更新を管理する。
--
--   - construction_projects に当初値保存列・変更回数列を追加（additive）
--   - construction_design_changes      : 設計変更ヘッダ（1工事に複数回）
--   - construction_design_change_files : 変更関連書類（変更指示書/変更契約書 等）
--   - construction_boq / construction_trade_summary に change_id 列を追加（additive）
--     NULL=当初版、値あり=その設計変更の変更後版。既存の当初版BOQ処理に影響しない。
--
--   RLS は他テーブルと同様にオフ（アプリ側 requireAuth + requireConstructionAccess で制御）。
-- ============================================================

-- ── 1) 工事案件に当初値・変更管理列を追加（additive）──────────────────────────
ALTER TABLE construction_projects ADD COLUMN IF NOT EXISTS original_contract_amount          NUMERIC;       -- 当初契約金額（第1回設計変更適用時に退避）
ALTER TABLE construction_projects ADD COLUMN IF NOT EXISTS original_end_date                 DATE;          -- 当初工期末（同上）
ALTER TABLE construction_projects ADD COLUMN IF NOT EXISTS original_completion_inspection_date DATE;        -- 当初完成検査(予定)日（同上）
ALTER TABLE construction_projects ADD COLUMN IF NOT EXISTS change_count                      INTEGER NOT NULL DEFAULT 0;  -- 適用済み設計変更の件数
ALTER TABLE construction_projects ADD COLUMN IF NOT EXISTS latest_change_at                  TIMESTAMPTZ;   -- 直近の設計変更適用日時

-- ── 2) 設計変更ヘッダ ─────────────────────────────────────────────────────────
DROP TABLE IF EXISTS construction_design_change_files CASCADE;
DROP TABLE IF EXISTS construction_design_changes       CASCADE;

CREATE TABLE construction_design_changes (
  id           BIGSERIAL PRIMARY KEY,
  project_id   BIGINT NOT NULL REFERENCES construction_projects(id) ON DELETE CASCADE,

  -- 変更識別
  change_no    INTEGER NOT NULL,                                          -- 第N回変更（1始まり）
  title        TEXT,                                                      -- 変更件名（例: 第1回設計変更）

  -- 変更理由
  reason_category TEXT CHECK (reason_category IN (
    '数量増減', '設計変更指示', '追加工事', '工法変更', '条件変更', 'その他'
  )),
  reason       TEXT,                                                      -- 変更内容・理由の詳細

  -- ステータス
  status       TEXT NOT NULL DEFAULT 'negotiating' CHECK (status IN (
    'negotiating',  -- 協議中
    'instructed',   -- 指示受領
    'estimating',   -- 見積中
    'contracted',   -- 変更契約済
    'cancelled'     -- 中止
  )),

  -- 変更前後の契約金額
  amount_before NUMERIC,                                                  -- 変更前の契約金額（自動スナップショット）
  amount_after  NUMERIC,                                                  -- 変更後の契約金額

  -- 変更前後の工期末
  end_date_before DATE,                                                   -- 変更前の工期末（自動スナップショット）
  end_date_after  DATE,                                                   -- 変更後の工期末

  -- 変更前後の完成検査(予定)日
  completion_inspection_date_before DATE,                                 -- 変更前（自動スナップショット）
  completion_inspection_date_after  DATE,                                 -- 変更後

  -- 日付
  instruction_date DATE,                                                  -- 変更指示日
  agreement_date   DATE,                                                  -- 変更契約日

  -- 反映状態（工事基本情報への反映済みかどうか）
  applied      BOOLEAN NOT NULL DEFAULT FALSE,
  applied_at   TIMESTAMPTZ,

  -- 補足
  note         TEXT,

  -- 管理
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_active    BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_design_changes_project    ON construction_design_changes(project_id);
CREATE INDEX IF NOT EXISTS idx_design_changes_project_no ON construction_design_changes(project_id, change_no);

-- ── 3) 変更関連書類ファイル ────────────────────────────────────────────────────
-- 既存の submission_files と同じ構造で変更書類専用テーブルを作成。
CREATE TABLE construction_design_change_files (
  id          BIGSERIAL PRIMARY KEY,
  change_id   BIGINT NOT NULL REFERENCES construction_design_changes(id) ON DELETE CASCADE,
  project_id  BIGINT NOT NULL REFERENCES construction_projects(id) ON DELETE CASCADE,

  -- 書類種別
  doc_type    TEXT CHECK (doc_type IN (
    '変更指示書', '変更見積書', '変更契約書', '変更設計図', '変更数量書', 'その他'
  )),

  -- ファイル参照（Drive fileId / Supabaseパス）
  file_ref    TEXT NOT NULL,                                              -- "drive:<fileId>" または Supabaseストレージのパス
  file_name   TEXT NOT NULL,                                              -- 元のファイル名
  mime_type   TEXT,
  size_bytes  BIGINT,

  -- 管理
  uploaded_by TEXT,                                                       -- アップロード者メール
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_design_change_files_change ON construction_design_change_files(change_id);
CREATE INDEX IF NOT EXISTS idx_design_change_files_project ON construction_design_change_files(project_id);

-- ── 4) BOQ 変更版対応（additive）─────────────────────────────────────────────
-- change_id が NULL の既存レコードはすべて当初版として扱われる。
-- FK は変更レコード削除時に CASCADE。当初版(NULL)の取込・取得処理は変化しない。
ALTER TABLE construction_boq          ADD COLUMN IF NOT EXISTS change_id BIGINT REFERENCES construction_design_changes(id) ON DELETE CASCADE DEFAULT NULL;
ALTER TABLE construction_trade_summary ADD COLUMN IF NOT EXISTS change_id BIGINT REFERENCES construction_design_changes(id) ON DELETE CASCADE DEFAULT NULL;

-- 変更版 BOQ のインデックス（当初版とは WHERE change_id IS NULL / IS NOT NULL で分離）
CREATE INDEX IF NOT EXISTS idx_boq_change       ON construction_boq(project_id, change_id);
CREATE INDEX IF NOT EXISTS idx_trade_sum_change ON construction_trade_summary(project_id, change_id);

-- ── construction_trade_summary の UNIQUE 制約を (project_id, trade) から
--    (project_id, change_id, trade) に拡張する。
--    変更版サマリ（change_id NOT NULL）を同じテーブルに共存させるために必要。
--    既存制約名は 027 で CREATE TABLE 時に PostgreSQL が自動付与した名前を使う。
--    Supabase の自動命名は "construction_trade_summary_project_id_trade_key" が一般的。
--    DROP → ADD の順で冪等に実行する（DROP IF EXISTS は PostgreSQL 9.4+ で使用可）。
DO $$
BEGIN
  -- 旧制約を削除（存在しない場合は無視）
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'construction_trade_summary'
      AND constraint_type = 'UNIQUE'
      AND constraint_name = 'construction_trade_summary_project_id_trade_key'
  ) THEN
    ALTER TABLE construction_trade_summary
      DROP CONSTRAINT construction_trade_summary_project_id_trade_key;
  END IF;
  -- 新制約を追加（既に存在する場合は無視）
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'construction_trade_summary'
      AND constraint_type = 'UNIQUE'
      AND constraint_name = 'construction_trade_summary_project_change_trade_key'
  ) THEN
    ALTER TABLE construction_trade_summary
      ADD CONSTRAINT construction_trade_summary_project_change_trade_key
      UNIQUE (project_id, change_id, trade);
  END IF;
END $$;
