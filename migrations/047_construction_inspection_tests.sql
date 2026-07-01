-- ============================================================
-- 047: 工事管理 - 受検・試験リスト（特記仕様書から抽出する検査・試験・測定）
-- 実行先: Supabase SQL Editor
-- 目的:
--   特記仕様書（官庁営繕の選択式仕様書。「※印＝実施する」様式）から、
--   工事中〜完成時に「発注者から受ける検査」「化学物質濃度試験」「法定検査」
--   「その他の試験・測定」を抽出し、工事ごとに一覧化して実施状況を追跡する。
--   ※ 既存の「検査書類チェックリスト(project_inspection_items)」は"提出書類"の管理。
--     こちらは"実地の受検・試験・測定"の管理で、別概念・別テーブル。
-- 運用:
--   特記仕様書をアップロード → AIが該当項目を抽出（※行わない等は対象外として記録）
--   → 画面のプレビューで人が是正 → 一括登録。以後、予定日・実施日・合否を管理し、
--   成績書（保管庫 submission_documents）と linked_document_id で紐づける。
-- 冪等: 何度流しても安全（IF NOT EXISTS）。既存データは削除しない。
-- ============================================================

CREATE TABLE IF NOT EXISTS project_inspection_tests (
  id            BIGSERIAL PRIMARY KEY,
  project_id    BIGINT NOT NULL REFERENCES construction_projects(id) ON DELETE CASCADE,

  -- 区分: 発注者検査 / 化学物質濃度試験 / 法定検査 / その他試験
  category      TEXT NOT NULL DEFAULT 'その他試験',
  name          TEXT NOT NULL,                -- 検査・試験・測定の名称
  target        TEXT,                         -- 対象（工程/室/材料/物質）
  timing        TEXT,                         -- 実施時期（工程上のどこか。例: 工事完成時）
  basis         TEXT,                         -- 根拠（特記の項番/ページ・標準仕様書の条番号）
  witness       TEXT,                         -- 立会区分（発注者立会/自主/特定行政庁/消防 等）

  -- 実施する(true) / 対象外=特記で「行わない・適用しない」(false)。対象外も記録として残す。
  applicable    BOOLEAN NOT NULL DEFAULT TRUE,

  status        TEXT NOT NULL DEFAULT 'planned'  -- planned 予定 / requested 依頼済 / done 実施済 / passed 合格 / failed 不合格 / na 対象外
                CHECK (status IN ('planned','requested','done','passed','failed','na')),
  scheduled_date DATE,                         -- 予定日
  done_date      DATE,                         -- 実施日
  result_note    TEXT,                         -- 結果・所見メモ
  linked_document_id BIGINT REFERENCES submission_documents(id) ON DELETE SET NULL,  -- 成績書・報告書（保管庫）

  source        TEXT NOT NULL DEFAULT 'manual',  -- 'ai' AI抽出 / 'manual' 手入力
  ai_confidence NUMERIC,                        -- AI抽出の確信度 0.0〜1.0
  ai_reason     TEXT,                           -- AI抽出の根拠メモ

  sort_order    INT  NOT NULL DEFAULT 0,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pit_project  ON project_inspection_tests(project_id);
CREATE INDEX IF NOT EXISTS idx_pit_category ON project_inspection_tests(category);
CREATE INDEX IF NOT EXISTS idx_pit_status   ON project_inspection_tests(status);
CREATE INDEX IF NOT EXISTS idx_pit_linked   ON project_inspection_tests(linked_document_id);
