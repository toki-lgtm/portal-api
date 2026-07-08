-- ============================================================
-- 098: 呼び名→正式氏名の対応表（人員配置の名前照合を確定的に補正）
-- 実行先: Supabase SQL Editor
-- 目的:
--   LINEの人員報告はニックネーム・下の名前・カタカナ（例: ヒロミ）が多く、
--   AIの読み推測では別人に誤爆しうる（例: ヒロミ→別姓の「廣美」）。
--   確定済みの「呼び名→正式氏名」をここに持ち、抽出結果をコード側で確実に置き換える。
--   ・管理者が画面で人員名を手修正すると、その呼び名→氏名が自動でここに学習される。
--   ・alias は呼び名（本文の表記のまま）。full_name は staff_master の正式氏名。
-- 既存テーブルには一切触れない新規テーブル（低リスク）。
-- ============================================================

CREATE TABLE IF NOT EXISTS name_aliases (
  alias       TEXT PRIMARY KEY,           -- 本文中の呼び名（例: ヒロミ、弘さん）
  full_name   TEXT NOT NULL,              -- 正式氏名（staff_master.name）
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('098_name_aliases', now(), '呼び名→正式氏名の対応表(name_aliases)を新設。人員配置の名前照合を確定補正・手修正から学習')
ON CONFLICT (version) DO NOTHING;
