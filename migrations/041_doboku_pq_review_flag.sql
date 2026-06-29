-- ============================================================
-- 041: 過去問に「要復習」フラグを追加
-- 実行先: Supabase SQL Editor（DATABASE_URL 未設定のため手動適用）
-- 目的:
--   間違えた／後で解き直したい過去問に、受験者が手動で印を付けられるようにする。
--   穴埋め・記述を問わず付与可。「要復習だけ」を集中して解き直す導線に使う。
--
--   保存先は学習記録テーブル doboku_pq_progress（個人 × 過去問）に列を1本追加するだけ。
--   additive（列追加のみ）なので再実行・既存データに無害。
-- ============================================================

ALTER TABLE doboku_pq_progress
  ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT FALSE;

-- 「要復習だけ」を素早く引くための部分インデックス（フラグONの行だけを対象）
CREATE INDEX IF NOT EXISTS idx_doboku_pq_progress_review
  ON doboku_pq_progress (staff_id, subject_id)
  WHERE needs_review = TRUE;
