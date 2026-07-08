-- ============================================================
-- 097: 翌日の現場別人員（LINEグループの投稿から自動抽出）
-- 実行先: Supabase SQL Editor
-- 目的:
--   各現場監督が夕方にグループLINEへ流す「翌営業日の作業予定＋人員」投稿を、
--   AI(Gemini)で構造化し「翌営業日・現場ごとの人員配置」として蓄積・表示する。
--   ・毎晩20:00(JST)の cron が当日ぶんの発言を読み、翌営業日ぶんを洗い替えで保存
--   ・恒久データはここ(Supabase)に置く（line_messages は日次でDrive退避されるため、
--     抽出結果は独立して保持する）
--   ・work_date × site_name を単位に1行。人員は members(JSONB)に配列で保持。
--   既存テーブルには一切触れない新規テーブル（低リスク）。
-- ============================================================

CREATE TABLE IF NOT EXISTS site_assignments (
  id             BIGSERIAL PRIMARY KEY,
  work_date      DATE NOT NULL,               -- 対象作業日（＝翌営業日）
  site_name      TEXT NOT NULL,               -- 現場名
  work_content   TEXT,                        -- 作業内容（要約）
  members        JSONB NOT NULL DEFAULT '[]', -- 人員 [{name, company, count}]
  member_count   INTEGER NOT NULL DEFAULT 0,  -- 合計人数（個人＋協力会社の人数）
  group_name     TEXT,                        -- 元グループ名
  source_sender  TEXT,                        -- 元発言者
  source_date    DATE,                        -- 投稿日（＝前営業日）
  raw_text       TEXT,                        -- 元発言の本文（見直し・監査用）
  edited         BOOLEAN NOT NULL DEFAULT false, -- 管理者が手修正したか（再抽出で保護）
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_assignments_work_date ON site_assignments(work_date);
CREATE INDEX IF NOT EXISTS idx_site_assignments_source    ON site_assignments(source_date);

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('097_site_assignments', now(), '翌日の現場別人員(site_assignments)を新設。LINE投稿→Gemini抽出→翌営業日ぶんを保存')
ON CONFLICT (version) DO NOTHING;
