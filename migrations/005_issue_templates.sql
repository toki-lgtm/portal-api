-- ============================================================
-- 005: 指摘内容テンプレート（過去の指摘内容を再利用するためのストック）
-- 実行先: Supabase SQL Editor
-- 目的: 「指摘あり」で入力した指摘内容を項目（inspection_master）単位で蓄積し、
--       他現場で同じ項目を点検する際に選択入力できるようにする。
-- ============================================================

CREATE TABLE IF NOT EXISTS issue_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id TEXT REFERENCES inspection_master(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 同一項目に同一内容を重複登録しない（重複時は use_count を加算する運用）
CREATE UNIQUE INDEX IF NOT EXISTS uq_issue_templates_item_content
  ON issue_templates(item_id, content);

-- 項目ごとに利用頻度順で引けるようにする
CREATE INDEX IF NOT EXISTS idx_issue_templates_item_id
  ON issue_templates(item_id);
