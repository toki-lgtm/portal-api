-- ============================================================
-- 064: ISO 是正処置（ISO 10.2・中核ワークフロー）
-- 実行先: Supabase SQL Editor
-- 目的:
--   不適合(苦情/事故/監査/監視測定/目標未達/その他)発生時の是正処置を
--   起票→原因特定→計画→実施→有効性確認→完了（有効性なしなら再計画）で追跡する。
--   実データなし・新規運用開始のため空テーブル。RLSオフ。
-- ============================================================

DROP TABLE IF EXISTS iso_corrective_actions CASCADE;
CREATE TABLE iso_corrective_actions (
  id               SERIAL PRIMARY KEY,
  title            TEXT NOT NULL,
  dept             TEXT,
  nonconformity    TEXT,                 -- 不適合内容
  correction       TEXT,                 -- 応急処置（対処）
  source_type      TEXT CHECK (source_type IN ('complaint','accident','audit','monitoring','target','other')),
  source_ref       TEXT,                 -- 元レコードの参照メモ
  cause            TEXT,                 -- 原因
  similar_check    TEXT,                 -- 類似事例の有無・確認
  plan             TEXT,                 -- 是正処置計画（5W1H）
  result           TEXT,                 -- 結果
  effectiveness    TEXT CHECK (effectiveness IN ('有','無')),
  status           TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','原因特定','計画','実施','有効性確認','完了','再計画')),
  ms_change        TEXT,                 -- マネジメントシステムへの変更
  planned_date     DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_iso_ca_status ON iso_corrective_actions(status);

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('064_iso_corrective_actions', now(), 'ISO 是正処置ワークフロー（ISO10.2）。seedなし') ON CONFLICT (version) DO NOTHING;
