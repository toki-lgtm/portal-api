-- ============================================================
-- 101: 過去工事アーカイブ 書類単位セグメント（本文全文＋ページ範囲）
-- 実行先: Supabase SQL Editor
-- 目的:
--   1スキャンPDFに複数書類が綴じられている実態に合わせ、索引を「PDF単位」から
--   「書類単位（segment）」に細分化する。各書類の本文全文をテキスト化して保持し、
--   利用者は普段このデータ（本文）を読む。原本PDFは page_start〜page_end で
--   該当ページだけを参照する。
--
--   親: archive_document_index（PDF単位・migration 100）
--   子: archive_document_segments（書類単位）  document_id で親に連結。
--   drive_file_id を非正規化で保持し、単独クエリ・冪等 upsert を容易にする。
--   RLS はオフ（アプリ側 requireAuth / requireAdmin で制御）。
--   全文検索は pg_trgm（body_text / title / keywords）。
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

DROP TABLE IF EXISTS archive_document_segments CASCADE;
CREATE TABLE archive_document_segments (
  id              SERIAL PRIMARY KEY,
  document_id     INT REFERENCES archive_document_index(id) ON DELETE CASCADE,
  drive_file_id   TEXT NOT NULL,                   -- 親PDFの正本ID（参照用・非正規化）
  scope           TEXT NOT NULL DEFAULT 'kouji',
  kouji_folder_id TEXT,
  kouji_name      TEXT,
  file_name       TEXT,
  seg_index       SMALLINT NOT NULL,               -- PDF内の書類の通し番号（0始まり）
  doc_type        TEXT,                            -- 書類種別
  title           TEXT,                            -- 書類名（文書表題）
  doc_date        DATE,                            -- 代表日付
  date_text       TEXT,
  client_name     TEXT,                            -- 発注者
  fiscal_year     TEXT,
  work_type       TEXT,
  page_start      SMALLINT,                        -- 元PDFの開始ページ（1始まり）
  page_end        SMALLINT,                        -- 元PDFの終了ページ（1始まり・含む）
  body_text       TEXT,                            -- 本文全文（マークダウン）
  summary         TEXT,
  keywords        TEXT,
  model           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (drive_file_id, seg_index)
);

CREATE INDEX idx_seg_document   ON archive_document_segments(document_id);
CREATE INDEX idx_seg_drivefile  ON archive_document_segments(drive_file_id);
CREATE INDEX idx_seg_kouji      ON archive_document_segments(kouji_folder_id);
CREATE INDEX idx_seg_doctype    ON archive_document_segments(doc_type);
CREATE INDEX idx_seg_date       ON archive_document_segments(doc_date);
CREATE INDEX idx_seg_body_trgm  ON archive_document_segments USING gin (body_text gin_trgm_ops);
CREATE INDEX idx_seg_title_trgm ON archive_document_segments USING gin (title     gin_trgm_ops);
CREATE INDEX idx_seg_kw_trgm    ON archive_document_segments USING gin (keywords  gin_trgm_ops);

-- 親テーブルに書類数を持たせる（一覧の目安）。
ALTER TABLE archive_document_index ADD COLUMN IF NOT EXISTS seg_count SMALLINT;
