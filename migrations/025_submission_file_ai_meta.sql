-- ============================================================
-- 025: 工事管理 - 提出書類ファイルに「出所」と「AI振り分け」メタを付与
-- 実行先: Supabase SQL Editor
-- 目的:
--   - 入札管理から工事へ昇格した際に引き継いだ書類（source='bid'）を識別する。
--   - アップロード時に Gemini が内容を読み取り自動で振り分けた結果を保持し、
--     UI でバッジ表示・後からの見直しに使う（ai_classified / ai_confidence / ai_note）。
--   いずれも additive（既存データに影響なし。デフォルトは従来＝手動扱い）。
-- ============================================================

ALTER TABLE submission_files ADD COLUMN IF NOT EXISTS source        TEXT    NOT NULL DEFAULT 'manual';
  -- 'manual'（手動アップロード） / 'bid'（入札から引継ぎ） / 'auto'（AI自動振り分けアップロード）
ALTER TABLE submission_files ADD COLUMN IF NOT EXISTS ai_classified BOOLEAN NOT NULL DEFAULT FALSE;
  -- Gemini が書類種別を判定して紐付けた場合 TRUE
ALTER TABLE submission_files ADD COLUMN IF NOT EXISTS ai_confidence NUMERIC;
  -- 判定の確信度（0.0〜1.0）。AI 判定時のみ
ALTER TABLE submission_files ADD COLUMN IF NOT EXISTS ai_note       TEXT;
  -- 判定理由・元の入札書類種別など（監査・見直し用の短いメモ）
