-- ============================================================
-- 086: ISO 顧客満足度調査データ投入（INSERT専用）
-- 実行先: Supabase SQL Editor
-- 目的:
--   出典: G:\...\051_工事成績表定評\工事成績評定.xlsx
--   公共工事の工事成績評定（工事別・個別点数）をproject別にINSERT。
--   R6(2024)年度分6件・R7(2025)年度分4件（本ファイルに記載の範囲）。
--   normalized_score = 評定点そのもの（100点満点）。
--   q1_score/q2_score/created_by は公共評定にはアンケート設問が
--   存在しないため対象外・NULLのまま。工期はother_commentに出典として保持。
--
--   ※ 民間工事の顧客満足度アンケート（q1/q2個別スコア）は、原本の
--     構造化データが見つからず、このmigrationでは投入していない。
--     依頼時に挙げられた「民間2件・73点/75点」は、本xlsxのR7年度分
--     （対馬地区魚礁整備工事＝対馬市＝73点、厳原中学校特別教室改修工事＝
--     対馬市＝75点）と数値・件数が一致しており、実際は民間調査ではなく
--     この公共評定2件を指している可能性が高い（要確認・二重計上回避のため
--     別枠での投入は見送り）。
-- ============================================================

INSERT INTO iso_customer_satisfaction (
  project_name, source_type, customer, sent_date, received_date,
  q1_score, q1_comment, q2_score, q2_comment, other_comment,
  normalized_score, created_by
) VALUES
('飼所川河川緊急浚渫推進工事', '公共評定', '長崎県', NULL, NULL,
  NULL, NULL, NULL, NULL, 'R6(2024)年度工事成績評定／工期: R5.12.22～R6.7.28', 74, NULL),
('(仮称)豊玉認定こども園建設工事(建築主体)', '公共評定', '対馬市', NULL, NULL,
  NULL, NULL, NULL, NULL, 'R6(2024)年度工事成績評定／工期: R5.2.3～R6.8.31', 87, NULL),
('対馬空港消防車庫新築工事', '公共評定', '長崎県', NULL, NULL,
  NULL, NULL, NULL, NULL, 'R6(2024)年度工事成績評定／工期: R6.5.22～R6.12.18', 75, NULL),
('主要地方道上対馬豊玉線道路改良工事(函渠工)', '公共評定', '長崎県', NULL, NULL,
  NULL, NULL, NULL, NULL, 'R6(2024)年度工事成績評定／工期: R6.1.4～R7.2.28', 77, NULL),
('佐護川総合流域防災工事（２工区）', '公共評定', '長崎県', NULL, NULL,
  NULL, NULL, NULL, NULL, 'R6(2024)年度工事成績評定／工期: R4.11.1～R7.3.19', 65, NULL),
('海栗島(5)火薬庫新設等建築その他工事', '公共評定', '九州防衛局', NULL, NULL,
  NULL, NULL, NULL, NULL, 'R6(2024)年度工事成績評定／工期: R5.8.10～R7.3.14', 80, NULL),
('対馬地区魚礁整備工事（佐護湊工区）', '公共評定', '対馬市', NULL, NULL,
  NULL, NULL, NULL, NULL, 'R7(2025)年度工事成績評定／工期: R6.9.21～R7.5.30', 73, NULL),
('厳原中学校特別教室改修工事', '公共評定', '対馬市', NULL, NULL,
  NULL, NULL, NULL, NULL, 'R7(2025)年度工事成績評定／工期: R6.12.10～R7.11.28', 75, NULL),
('対馬空港庁舎無線機器室外1カ所空気調和設備工事', '公共評定', '大阪航空局', NULL, NULL,
  NULL, NULL, NULL, NULL, 'R7(2025)年度工事成績評定／工期: R7.4.9～R7.11.14', 70, NULL),
('一重漁港自然災害防止工事', '公共評定', '長崎県', NULL, NULL,
  NULL, NULL, NULL, NULL, 'R7(2025)年度工事成績評定／工期: R7.4.26～R8.1.30', 76, NULL);

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('086_iso_customer_satisfaction_data', now(), 'ISO 顧客満足度（公共評定10件、工事成績評定.xlsxより）') ON CONFLICT (version) DO NOTHING;
