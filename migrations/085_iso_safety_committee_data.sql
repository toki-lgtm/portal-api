-- ============================================================
-- 085: ISO 安全衛生委員会 議事録データ投入（INSERT専用）
-- 実行先: Supabase SQL Editor
-- 目的:
--   出典: G:\...\004_安全衛生委員会議事録\5.4,7.4安全衛生委員会議事録.docx
--   2025年8月4日開催分の議事録1件を iso_safety_committee にINSERT。
--   ※ R07.08.28／R07.09.25／R07.10.30／R7.11／R7.12 の各回はGoogleドライブの
--     .gdoc実体（ローカルファイルとして読み取り不可）のため対象外。
--     このdocx1件のみが確認できた実データ。
-- ============================================================

INSERT INTO iso_safety_committee (
  meeting_date, location, chair, attendees, accident_count,
  ky_report, patrol_result, notes, discussion, next_date,
  summary_by, summary
) VALUES (
  '2025-08-04',
  '本社　会議室',
  '中原釈統',
  NULL,
  0,
  '今後は積極的に報告してほしいです。他工事にも生かすことができるようヒヤリハットの事例があれば共有して下さい。なおヒヤリハット報告は月30件が目標です。',
  '７月に実施した巡回点検の結果は「良好」でした。引き続き、基本動作を遵守して下さい。',
  '熱中症対策について・平均気温が高いので、熱中症には十分に注意して下さい。・適切に水分補給してください。・塩分補給も大事です。塩飴やタブレットを用意しています。適切に摂取して下さい。・支給した空調服も確実に着用して下さい。・休憩も適切にとり、現場責任者の指示に従って作業して下さい。',
  NULL,
  NULL,
  '中原主税',
  '今月も無事故でお仕事お願いします。'
);

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('085_iso_safety_committee_data', now(), 'ISO 安全衛生委員会データ投入（2025-08-04開催分1件、原本docxより）') ON CONFLICT (version) DO NOTHING;
