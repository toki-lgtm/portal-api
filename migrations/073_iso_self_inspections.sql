-- ============================================================
-- 073: ISO 自主検査（重機・機械等の年次/月次/始業時点検）
-- 実行先: Supabase SQL Editor
-- 目的:
--   重機・機械類の法定/社内自主検査記録を一元管理（3年保管が目安）。
--   現場が都度記録する類のため、起票（POST）は requireAuth のみ、
--   編集・削除は管理者のみ。RLS はオフ（アプリ側で制御）。
-- ============================================================

DROP TABLE IF EXISTS iso_self_inspections CASCADE;
CREATE TABLE iso_self_inspections (
  id              SERIAL PRIMARY KEY,
  machine         TEXT NOT NULL,        -- 機種
  machine_no      TEXT,                 -- 号機・管理番号
  inspection_type TEXT NOT NULL CHECK (inspection_type IN ('年次', '月次', '始業時')),
  inspect_date    DATE NOT NULL,
  inspector       TEXT,                 -- 検査者
  result          TEXT NOT NULL DEFAULT '良' CHECK (result IN ('良', '否')),
  defects         TEXT,                 -- 指摘事項
  doc_link        TEXT,                 -- 記録PDF（Drive）
  created_by      TEXT,                 -- 起票アカウント（email）
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_iso_self_insp_date ON iso_self_inspections(inspect_date DESC);
CREATE INDEX idx_iso_self_insp_machine ON iso_self_inspections(machine, machine_no);

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('073_iso_self_inspections', now(), 'ISO 自主検査（重機・機械の年次/月次/始業時点検記録）') ON CONFLICT (version) DO NOTHING;
