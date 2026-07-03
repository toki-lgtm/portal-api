-- ============================================================
-- 052: 工事管理 — 施工計画書の生成ジョブ／成果物管理
-- 実行先: Supabase SQL Editor
-- 目的:
--   工事ごとに「施工計画書」をポータルから生成する。Word 生成は python-docx +
--   Word COM に依存するため Render(Linux) 上では動かせない。よって見積比較(P2)と
--   同じハイブリッド方式を採る：
--     ポータル(Render) が共有ドライブ 06.施工計画書\_queue にジョブを投入
--       → このPC常駐エージェント(seko_agent.py)が docx を生成
--       → ポータルが Drive 経由で成果物を回収し保管庫へ
--   本テーブルは 1 生成ジョブ = 1 行。工事マスタ(master_json)・状態・成果物参照を保持する。
--
--   RLS はオフ（他の工事管理テーブルと同様。アプリ側 requireAuth +
--   requireConstructionAccess で制御）。
-- 関連: construction_projects(023) / construction_boq(026) / 見積比較キュー(036)
-- ============================================================

DROP TABLE IF EXISTS construction_seko_plans CASCADE;

CREATE TABLE construction_seko_plans (
  id            BIGSERIAL PRIMARY KEY,
  project_id    BIGINT NOT NULL REFERENCES construction_projects(id) ON DELETE CASCADE,

  -- 施工計画書の種別（MVP は総合のみ。工種別・自主検査CLは段階2で拡張）
  plan_type     TEXT NOT NULL DEFAULT 'soukatsu'
                CHECK (plan_type IN ('soukatsu', 'koshu', 'checklist')),
  title         TEXT,                          -- 例「総合施工計画書」

  -- 生成に使った工事マスタ（基本情報＋補完入力を統合したもの）
  master_json   JSONB,

  -- ジョブ状態（エージェントが status.json 経由で更新 → ポータルが同期）
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'processing', 'done', 'error')),
  message       TEXT,                          -- エージェントからの状態メッセージ

  -- 共有ドライブ _queue 上のジョブ位置（結果ポーリング用）
  job_name      TEXT,                          -- ジョブフォルダ名 <projectId>__<ts>
  job_folder_id TEXT,                          -- Drive フォルダ ID

  -- 成果物（生成された docx）
  output_ref    TEXT,                          -- drive:<id> もしくは Supabase パス
  output_name   TEXT,                          -- ファイル名
  document_id   BIGINT REFERENCES submission_documents(id) ON DELETE SET NULL, -- 保管庫への紐付け（任意）

  generated_by  TEXT,                          -- 生成実行者メール
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE construction_seko_plans DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_seko_plans_project ON construction_seko_plans(project_id);
CREATE INDEX IF NOT EXISTS idx_seko_plans_status  ON construction_seko_plans(status);

-- 台帳へ記録（051 schema_migrations_ledger 方式。version=拡張子なしフルファイル名）
INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('052_construction_seko_plans', now(), '施工計画書の生成ジョブ／成果物管理')
ON CONFLICT (version) DO NOTHING;
