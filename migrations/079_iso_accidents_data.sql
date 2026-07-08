-- ============================================================
-- 079: ISO 事故報告書 実データ投入（しまむら対馬店 労災1件）
-- 実行先: Supabase SQL Editor
-- 目的:
--   保管庫「045_事故報告書/事故報告書第1報及び2報【しまむら】.xlsx」の内容を
--   iso_accidents / iso_accident_updates へ投入する。
--   INSERT専用（テーブルは066で作成済・空の状態）。
--
-- 注記（取れなかった項目）:
--   原本の「第２報以降（様式２）」シートは、工事名・発生場所・発注機関名・
--   発生年月日・請負業者名・事故種別・被災者所属/氏名/年齢/性別・職種など
--   ヘッダー部（第1報からの転記）のみ入力済みで、(1)発生状況詳細/(2)発生要因/
--   所轄労働基準監督署の対応/所轄警察署の対応/事故後の対応等/その他 の本文欄は
--   いずれも原本上で空欄（未記入）だった。そのため iso_accident_updates は
--   report_no=2 の行として作成するが、cause_factors/labor_bureau/police/followup は
--   NULLとし、note欄にその旨を明記した。symptom（被災者の症状＝左足踵骨折）は
--   第１報（様式１）シートにのみ記載があったため、そちらから採用している。
-- ============================================================

WITH ins_accident AS (
  INSERT INTO iso_accidents (
    project_name, ordering_agency, occurred_at, accident_type,
    victim_affiliation, victim_name, victim_age, victim_gender,
    symptom, occupation, summary
  )
  VALUES (
    'しまむら対馬店新築工事',
    '株式会社 しまむら',
    '2025-09-18 18:30:00+09',
    '工事関係者事故',
    '下請〔1次下請〕（株式会社赤木）',
    '久原 孝一',
    45,
    '男',
    '左足踵骨折',
    '作業員',
    '脚立足場からの転落。本日、鋼製建具建て込み作業を6名で行っていた。午後６時30分ごろ、脚立にアルミ足場板を乗せて使用し、移動する際にアルミ足場板の端部に足を置いたため、バランスを崩し約2.5ｍの高さから転落した。その際、左足踵を強く打ち、被災者も痛みを訴えた為対馬病院を受診。診察後の所見は左足踵骨折とのこと。被災者が壱岐病院の受診を希望した為、紹介状を書いてもらい、添木処置を行った上で対馬病院から寄宿先へ帰宅。９月19日壱岐病院受診予定（同日朝のジェットフォイルで壱岐に移動）。'
  )
  RETURNING id
)
INSERT INTO iso_accident_updates (
  accident_id, report_no, report_date, cause_factors, labor_bureau, police, followup, note
)
SELECT
  ins_accident.id,
  2,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  '原本「第２報以降（様式２）」シートはヘッダー部（工事名・発生場所・発注機関名・発生年月日・請負業者名・事故種別・被災者所属/氏名/年齢/性別・職種）のみ第1報から転記済で、(1)発生状況詳細・(2)発生要因・所轄労働基準監督署の対応・所轄警察署の対応・事故後の対応等・その他の本文欄は原本上いずれも未記入（空欄）だった。報告日時欄（現在／報告日時）も年月日の入力なし。詳細が判明次第、原本の追記を待って本レコードを更新する必要がある。'
FROM ins_accident;

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('079_iso_accidents_data', now(), 'しまむら対馬店 労災1件（脚立転落・左足踵骨折・下請=赤木）実データ投入。第2報は原本が本文未記入のためnoteのみ')
ON CONFLICT (version) DO NOTHING;
