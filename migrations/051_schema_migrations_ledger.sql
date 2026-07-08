-- ============================================================
-- 051: schema_migrations 記録テーブル（適用台帳のDB版）
-- 実行先: Supabase SQL Editor
-- 目的:
--   どの migration を本番に流したかを DB 側にも記録し、記憶頼みをやめる。
--   既存の全 migration（001〜050）は 2026-07-02 に本番へ実データ問い合わせで
--   適用済みを確認済みのため、ここで遡及記録する。
--   今後は migration を流すたびに、末尾で INSERT を1行追加する運用にする。
--   既存テーブルには一切触れない新規テーブル（低リスク）。
-- ============================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,                    -- ファイル名（拡張子なし）。衝突分はフル名で一意
  applied_at  TIMESTAMPTZ,                         -- 実際に流した日時（既存分は不明のため NULL）
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),  -- この台帳に記録した日時
  note        TEXT
);

-- ── 既存 migration の遡及記録（2026-07-02 実データ照合で適用確認済み） ──
INSERT INTO schema_migrations (version, note) VALUES
  ('001_init_schema',                       '遡及記録: 2026-07-02 適用確認'),
  ('002_seed_initial_data',                 '遡及記録: 2026-07-02 適用確認'),
  ('003_inspection_flow',                   '遡及記録: 2026-07-02 適用確認'),
  ('004_multi_photos',                      '遡及記録: 2026-07-02 適用確認'),
  ('005_issue_templates',                   '遡及記録: 2026-07-02 適用確認'),
  ('006_staff_roles',                       '遡及記録: 2026-07-02 適用確認'),
  ('007_user_settings',                     '遡及記録: 2026-07-02 適用確認'),
  ('008_employee_directory',                '遡及記録: 2026-07-02 適用確認'),
  ('009_staff_company',                     '遡及記録: 2026-07-02 適用確認'),
  ('010_staff_address',                     '遡及記録: 2026-07-02 適用確認'),
  ('011_qualification_cert_image',          '遡及記録: 2026-07-02 適用確認'),
  ('012_email_password',                    '遡及記録: 2026-07-02 適用確認'),
  ('013_shared_mailboxes',                  '遡及記録: 2026-07-02 適用確認'),
  ('014_announcements',                     '遡及記録: 2026-07-02 適用確認'),
  ('015_bid_projects',                      '遡及記録: 2026-07-02 適用確認'),
  ('016_qualification_cert_meta',           '遡及記録: 2026-07-02 適用確認'),
  ('017_bid_period_remarks',                '遡及記録: 2026-07-02 適用確認'),
  ('018_bid_amount',                        '遡及記録: 2026-07-02 適用確認'),
  ('019_feedback',                          '遡及記録: 2026-07-02 適用確認'),
  ('020_circular_documents',                '遡及記録: 2026-07-02 適用確認'),
  ('021_workscope_distribution',            '遡及記録: 2026-07-02 適用確認'),
  ('022_workscope_consents',                '遡及記録: 2026-07-02 適用確認'),
  ('023_construction_management',           '遡及記録: 2026-07-02 適用確認'),
  ('024_submission_files',                  '遡及記録: 2026-07-02 適用確認'),
  ('025_submission_file_ai_meta',           '遡及記録: 2026-07-02 適用確認'),
  ('026_construction_boq',                  '遡及記録: 2026-07-02 適用確認（027で作り直し）'),
  ('027_construction_boq_hierarchy',        '遡及記録: 2026-07-02 適用確認'),
  ('028_construction_boq_ratios',           '遡及記録: 2026-07-02 適用確認'),
  ('029_construction_design_changes',       '遡及記録: 2026-07-02 適用確認'),
  ('030_regulations',                       '遡及記録: 2026-07-02 適用確認'),
  ('031_construction_boq_mode',             '遡及記録: 2026-07-02 適用確認'),
  ('032_app_usage',                         '遡及記録: 2026-07-02 適用確認'),
  ('033_business_cards',                    '遡及記録: 2026-07-02 適用確認'),
  ('034_card_categories',                   '遡及記録: 2026-07-02 適用確認'),
  ('035_card_personal_labels',              '遡及記録: 2026-07-02 適用確認'),
  ('036_estimate_comparison',               '遡及記録: 2026-07-02 適用確認'),
  ('037_construction_photos',               '遡及記録: 2026-07-02 適用確認'),
  ('038_photo_spec_master_seed',            '遡及記録: 2026-07-02 適用確認'),
  ('039_exam_prep',                         '遡及記録: 2026-07-02 適用確認'),
  ('040_doboku_exam',                       '遡及記録: 2026-07-02 適用確認（採番衝突: 040）'),
  ('040_inspection_checklist',              '遡及記録: 2026-07-02 適用確認（採番衝突: 040）'),
  ('041_doboku_pq_review_flag',             '遡及記録: 2026-07-02 適用確認（採番衝突: 041）'),
  ('041_inspection_auto_sweep',             '遡及記録: 2026-07-02 適用確認（採番衝突: 041）'),
  ('041_workscope_monitoring',              '遡及記録: 2026-07-02 適用確認（採番衝突: 041）'),
  ('042_inspection_swept_flag',             '遡及記録: 2026-07-02 適用確認'),
  ('045_doc_classification_realign',        '遡及記録: 2026-07-02 適用確認'),
  ('046_bid_docs_realign',                  '遡及記録: 2026-07-02 適用確認'),
  ('047_construction_inspection_tests',     '遡及記録: 2026-07-02 適用確認'),
  ('048_photo_nodes_from_inspection_tests', '遡及記録: 2026-07-02 適用確認'),
  ('049_company_calendar',                  '遡及記録: 2026-07-02 適用確認'),
  ('050_inspection_checklist_reseed',       '遡及記録: 2026-07-02 適用確認'),
  ('051_schema_migrations_ledger',          'この台帳自身')
ON CONFLICT (version) DO NOTHING;

-- ── 今後の運用テンプレ（新しい migration を流すたびに、その SQL 末尾に足す） ──
--   INSERT INTO schema_migrations (version, applied_at, note)
--   VALUES ('052_xxx', now(), '')
--   ON CONFLICT (version) DO NOTHING;
