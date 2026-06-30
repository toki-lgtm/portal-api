-- ============================================================
-- 045: 工事管理 - 書類分類の実態整合（マスタに保管庫folder_noを内蔵）
-- 実行先: Supabase SQL Editor
-- 背景（疑義の正体）:
--   書類マスタ required_doc_templates は当初「業務フェーズ9分類(category_no 1-9)」で作られ、
--   画面・実フォルダは「保管庫00〜15(folder_no)」。040 は両者を後付けで機械変換したが、
--   (a) マスタ自身に folder_no が無く、generateChecklist が folder_no をコピーしないため
--       040 以降に作る新規工事の書類は folder_no=NULL → 全部 04 扱いに落ちる。
--   (b) 040 の変換は安全書類・産廃を 04 に押し込み、13/14 が空のまま＝実工事と不一致。
--   Gドライブ実工事8件の分類方法を突合し、実態に合う割当へ是正する。
-- 本マイグレーションの内容:
--   (1) required_doc_templates に folder_no / folder_name を追加し、突合結果で全件付与。
--   (2) 既存のテンプレ由来 submission_documents を、マスタの新 folder へ再同期。
--       （手入力＝template_id IS NULL の書類はユーザ配置を尊重し触らない）
--   (3) フォルダ 15「入門・立入申請」を新設（セキュリティ書類の専用置き場）。
-- 是正の要点:
--   ・安全記録6書類・台風対策 → 13.KY・新規・安全書類
--   ・発生材調書・マニフェスト・アスベスト → 14.産廃関係
--   ・基地立入依頼/立入許可申請 → 15.入門・立入申請（新設）
--   ・品質は分離: 材料承認/出荷証明/数量比較・保証書 → 08、試験成績・検査報告類 → 10
--   ・定例会議議事録 → 12、完成図・国有財産図 → 07
-- 冪等: 何度流しても安全（IF NOT EXISTS / 全件CASE上書き）。
-- ============================================================

-- ── 1) マスタへ保管庫フォルダ列を追加 ─────────────────────────
ALTER TABLE required_doc_templates ADD COLUMN IF NOT EXISTS folder_no   INT;
ALTER TABLE required_doc_templates ADD COLUMN IF NOT EXISTS folder_name TEXT;

-- ── 2) 突合結果に基づく folder_no の割当（全件CASEで確定）──────
UPDATE required_doc_templates SET folder_no = CASE
  -- 1. 契約・設計図書
  WHEN category_no = 1 AND subcategory = '設計図書' THEN 1            -- 01.設計図書
  WHEN category_no = 1                              THEN 2            -- 02.契約関係（契約・リサイクル説明）
  -- 2. 着手・届出
  WHEN category_no = 2 AND subcategory = '工程表'   THEN 3            -- 03.工程表
  WHEN category_no = 2 AND subcategory = '基地'     THEN 15           -- 15.入門・立入申請
  WHEN category_no = 2                              THEN 4            -- 04.施主提出書類（着手届・各種届・仮設願）
  -- 3. 施工計画
  WHEN category_no = 3 AND subcategory = '施工体制' THEN 9            -- 09.施工体制
  WHEN category_no = 3                              THEN 5            -- 05.施工計画書
  -- 4. 施工管理
  WHEN category_no = 4 AND doc_name LIKE '%議事録%'           THEN 12 -- 12.打合議事録
  WHEN category_no = 4 AND subcategory = '打合せ'             THEN 6  -- 06.工事打合簿
  WHEN category_no = 4 AND subcategory = '施工図'             THEN 7  -- 07.施工図・詳細図・完成図
  WHEN category_no = 4 AND subcategory = '材料'               THEN 8  -- 08.材料承認・数量
  WHEN category_no = 4 AND subcategory = 'コンクリート'
                       AND doc_name LIKE '%打設計画%'          THEN 5  -- 打設計画書→05(計画)
  WHEN category_no = 4 AND subcategory = 'コンクリート'        THEN 10 -- 配合報告等→10(試験・記録)
  WHEN category_no = 4                                        THEN 4  -- 運営（休止届・進行状況・色彩）→04
  -- 5. 品質・出来形 → 10（試験・検査・出来形記録）
  WHEN category_no = 5 THEN 10
  -- 6. 安全・環境
  WHEN category_no = 6 AND subcategory = '環境' AND doc_name LIKE '%ホルムアルデヒド%' THEN 10 -- 室内環境試験→10
  WHEN category_no = 6 AND subcategory = '環境' THEN 14               -- 発生材・マニフェスト・アスベスト→14
  WHEN category_no = 6                          THEN 13               -- 安全記録・台風対策→13
  -- 7. 工事写真 → 10
  WHEN category_no = 7 THEN 10
  -- 8. 検査 → 04（検査願・完成通知・現場整理調書）
  WHEN category_no = 8 THEN 4
  -- 9. 完成・引渡
  WHEN category_no = 9 AND subcategory = '完成図' THEN 7              -- 07.完成図・国有財産図
  WHEN category_no = 9 AND doc_name LIKE '%保証書%' THEN 8            -- 保証書→08
  WHEN category_no = 9                           THEN 4              -- 引渡・保全・予備品・CORINS・電子納品→04
  ELSE 4
END;

-- ── 3) 標準小分類(subcategory)を実工事のフォルダ名に揃える ────
-- 実フォルダで共通して使われる中分類へ正規化（folder_no 確定後に適用）。
UPDATE required_doc_templates SET subcategory = CASE
  WHEN folder_no = 1  THEN '設計図書'
  WHEN folder_no = 2  AND doc_name LIKE '%リサイクル%' THEN 'リサイクル'
  WHEN folder_no = 2  THEN '契約'
  WHEN folder_no = 3  THEN '工程表'
  WHEN folder_no = 4  AND doc_name LIKE '%進行状況%'   THEN '進行状況報告書'
  WHEN folder_no = 4  AND doc_name LIKE '%休止%'       THEN '現場閉所(休止)届'
  WHEN folder_no = 4  AND doc_name LIKE '%色彩%'       THEN '色彩計画'
  WHEN folder_no = 4  AND doc_name LIKE '%検査願%'     THEN '監督官検査願'
  WHEN folder_no = 4  AND (doc_name LIKE '%完成通知%' OR doc_name LIKE '%引渡%' OR doc_name LIKE '%指定部分%') THEN '完成通知書・引渡書'
  WHEN folder_no = 4  AND doc_name LIKE '%整理調書%'   THEN '現場整理調書'
  WHEN folder_no = 4  AND doc_name LIKE '%予備品%'     THEN '予備品等引渡書'
  WHEN folder_no = 4  AND doc_name LIKE '%保全%'       THEN '保全'
  WHEN folder_no = 4  AND doc_name LIKE '%CORINS%'     THEN 'CORINS'
  WHEN folder_no = 4  AND doc_name LIKE '%電子納品%'   THEN '電子納品'
  WHEN folder_no = 4  AND doc_name LIKE '%仮設%'       THEN '仮設'
  WHEN folder_no = 4  THEN '着手・届出'
  WHEN folder_no = 5  THEN '施工計画書'
  WHEN folder_no = 6  THEN '工事打合せ簿'
  WHEN folder_no = 7  AND (doc_name LIKE '%完成図%' OR doc_name LIKE '%国有財産%') THEN '完成図'
  WHEN folder_no = 7  THEN '施工図'
  WHEN folder_no = 8  AND doc_name LIKE '%保証書%'     THEN '保証書'
  WHEN folder_no = 8  AND doc_name LIKE '%出荷証明%'   THEN '出荷証明書'
  WHEN folder_no = 8  AND doc_name LIKE '%数量%'       THEN '材料数量比較'
  WHEN folder_no = 8  THEN '材料承認'
  WHEN folder_no = 9  THEN '施工体制台帳'
  WHEN folder_no = 10 AND category_no = 7 THEN '工事写真'
  WHEN folder_no = 10 THEN '試験・検査報告'
  WHEN folder_no = 12 THEN '定例会議'
  WHEN folder_no = 13 AND doc_name LIKE '%新規入場%' THEN '新規入場者教育'
  WHEN folder_no = 13 AND doc_name LIKE '%台風%'     THEN '防災'
  WHEN folder_no = 13 THEN '安全記録'
  WHEN folder_no = 14 AND doc_name LIKE '%アスベスト%' THEN 'アスベスト'
  WHEN folder_no = 14 THEN '発生材・マニフェスト'
  WHEN folder_no = 15 THEN '入門・立入申請'
  ELSE subcategory
END;

-- ── 4) folder_name を folder_no から確定 ──────────────────────
UPDATE required_doc_templates SET folder_name = CASE folder_no
  WHEN 0 THEN '入札時資料' WHEN 1 THEN '設計図書' WHEN 2 THEN '契約関係'
  WHEN 3 THEN '工程表' WHEN 4 THEN '施主提出書類' WHEN 5 THEN '施工計画書'
  WHEN 6 THEN '工事打合簿' WHEN 7 THEN '施工図・詳細図・完成図'
  WHEN 8 THEN '材料承認・数量' WHEN 9 THEN '施工体制'
  WHEN 10 THEN '工事写真・工事記録・検査関係' WHEN 11 THEN '協力会社見積・作業指示書'
  WHEN 12 THEN '打合議事録' WHEN 13 THEN 'KY・新規・安全書類'
  WHEN 14 THEN '産廃関係' WHEN 15 THEN '入門・立入申請' ELSE '施主提出書類'
END;

-- ── 5) 既存のテンプレ由来 submission_documents を新フォルダへ再同期 ──
-- 手入力（template_id IS NULL）はユーザ配置を尊重して触らない。
UPDATE submission_documents sd
SET folder_no    = t.folder_no,
    folder_name  = t.folder_name,
    subcategory  = t.subcategory,
    category_no  = t.folder_no,
    category     = t.folder_name
FROM required_doc_templates t
WHERE sd.template_id = t.id
  AND t.folder_no IS NOT NULL;

-- ── 6) 確認用ビュー（任意・実行後の分布チェック）───────────────
-- SELECT folder_no, folder_name, count(*) FROM required_doc_templates
--   GROUP BY folder_no, folder_name ORDER BY folder_no;
