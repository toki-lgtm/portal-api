-- ============================================================
-- 063: ISO 内部監査（実施記録＋指摘事項）
-- 実行先: Supabase SQL Editor
-- 目的:
--   内部監査(9001/45001/14001)の実施記録を蓄積し、指摘事項(適合/観察/不適合/対象外)を
--   条項・部門別に残す。審査懸念No.2「内部監査の実施記録の運用」対応。
--   2025年度分は初回実施済だが実データ移行はせず、空テーブルで運用開始。RLSオフ。
-- ============================================================

DROP TABLE IF EXISTS iso_audit_findings CASCADE;
DROP TABLE IF EXISTS iso_internal_audits CASCADE;

CREATE TABLE iso_internal_audits (
  id             SERIAL PRIMARY KEY,
  audit_year     INT,
  auditor        TEXT,
  purpose        TEXT,
  criteria       TEXT,
  summary        TEXT,
  conclusion     TEXT,
  leader         TEXT,
  approved_date  DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE iso_audit_findings (
  id          SERIAL PRIMARY KEY,
  audit_id    INT NOT NULL REFERENCES iso_internal_audits(id) ON DELETE CASCADE,
  clause      TEXT,
  dept        TEXT,
  category    TEXT CHECK (category IN ('適合','観察','不適合','対象外')),
  finding     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_iso_audit_findings_audit ON iso_audit_findings(audit_id);

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('063_iso_internal_audits', now(), 'ISO 内部監査＋指摘事項（審査懸念No.2運用）。seedなし') ON CONFLICT (version) DO NOTHING;
