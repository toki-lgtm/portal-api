-- ============================================================
-- 024: 工事管理 - 提出書類の添付ファイル（共有ドライブ保存）
-- 実行先: Supabase SQL Editor
-- 目的:
--   submission_documents（書類1件）に複数の実ファイルを紐づける。
--   ファイル本体は標準方針どおり共有ドライブ(Drive API)へ保存し、
--   ここには参照(file_ref = "drive:<fileId>" もしくは Supabaseパス)とメタのみ持つ。
--   保存先フォルダ: （DRIVE_FOLDER_ID）/工事管理/<工事名>/<NN_大分類名>/
-- ============================================================

DROP TABLE IF EXISTS submission_files CASCADE;

CREATE TABLE submission_files (
  id           BIGSERIAL PRIMARY KEY,
  document_id  BIGINT NOT NULL REFERENCES submission_documents(id) ON DELETE CASCADE,
  project_id   BIGINT REFERENCES construction_projects(id) ON DELETE CASCADE,
  file_ref     TEXT NOT NULL,                          -- "drive:<fileId>" または Supabaseストレージのパス
  file_name    TEXT NOT NULL,                          -- 元のファイル名
  mime_type    TEXT,
  size_bytes   BIGINT,
  uploaded_by  TEXT,                                   -- アップロード者メール
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sub_files_doc     ON submission_files(document_id);
CREATE INDEX IF NOT EXISTS idx_sub_files_project ON submission_files(project_id);
