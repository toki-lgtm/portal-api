-- ============================================================
-- 106: 郵便局 年間指名 — 案件添付ファイル（共有ドライブ保存）＋提出書類チェック
-- 実行先: Supabase SQL Editor
-- 目的:
--   post_office_cases（案件＝様式1-6の1行）に、実ファイル（見積書PDF・完成書類・
--   現調写真 等）を複数紐づける。ファイル本体は標準方針どおり共有ドライブ(Drive API)へ
--   保存し、ここには参照(file_ref="drive:<fileId>")とメタ・書類種別(doc_type)のみ持つ。
--   保存先フォルダ: （共有ドライブ）/07.郵便局年間指名/案件添付/<年度>/<整理番号_施設名>/
--
--   doc_type は「標準提出書類」の語彙（見積書 / 石綿事前調査(様式1-3) / 現地調査写真 /
--   注文書・請書 / 施工計画書 / 工事写真帳 / 完成届・検査調書・引渡書 / 請求書 / その他）。
--   フェーズ別チェックリスト（提出済/未提出）は、この doc_type の有無からアプリ側で算出する
--   （工事管理の submission_documents のような別マスタは作らない。郵便局は小規模・定型のため）。
--
--   AI 自動振り分け（source='auto' / ai_classified 等）は工事管理 submission_files と同方式。
--   RLS は他テーブルと同様オフ（アプリ側 requireAuth + requirePostOfficeAccess で制御）。
-- 冪等: DROP → CREATE。106 は additive な新規テーブルのみ（既存 103/104 に影響なし）。
-- ============================================================

DROP TABLE IF EXISTS post_office_case_files CASCADE;

CREATE TABLE post_office_case_files (
  id            BIGSERIAL PRIMARY KEY,
  case_id       BIGINT NOT NULL REFERENCES post_office_cases(id) ON DELETE CASCADE,
  doc_type      TEXT NOT NULL DEFAULT 'その他',          -- 標準提出書類の語彙（下記）
  file_ref      TEXT NOT NULL,                            -- "drive:<fileId>" または Supabaseストレージのパス
  file_name     TEXT NOT NULL,                            -- 元のファイル名
  mime_type     TEXT,
  size_bytes    BIGINT,
  source        TEXT NOT NULL DEFAULT 'manual',           -- 'manual'（手動）/ 'auto'（AI自動振り分け）
  ai_classified BOOLEAN NOT NULL DEFAULT FALSE,           -- Gemini が書類種別を判定して紐付けた場合 TRUE
  ai_confidence NUMERIC,                                  -- 判定の確信度（0.0〜1.0）
  ai_note       TEXT,                                     -- 判定理由（監査・見直し用の短いメモ）
  uploaded_by   TEXT,                                     -- アップロード者メール
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_files_case ON post_office_case_files(case_id);
CREATE INDEX IF NOT EXISTS idx_po_files_type ON post_office_case_files(doc_type);

-- 適用記録（台帳）
INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('106_post_office_case_files', now(), '郵便局 案件添付ファイル＋提出書類チェックリスト') ON CONFLICT (version) DO NOTHING;
