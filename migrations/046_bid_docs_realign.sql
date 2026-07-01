-- ============================================================
-- 046: 工事管理 - 入札関係書類を「00.入札時資料」へ寄せる補正
-- 実行先: Supabase SQL Editor
-- 背景:
--   045 で 契約・設計図書フェーズ(category_no=1/契約)を 02.契約関係 に置いたが、
--   Gドライブ実工事(海栗島外(6)・芦屋外(6) 等)の 00.入札時資料 を確認すると、
--   「③落札後提出資料」として 請負代金内訳書・リサイクル関係・契約工程表 が 00 に入り、
--   02.契約関係 は 実契約書・契約保証書・注文書請書・コリンズ・現場代理人通知 等が入る。
--   よって 請負代金内訳書・リサイクル説明書 は 02→00 が正。
--   加えて総合評価型の入札提出物「総合評価計画書」「施工能力評価表」も 00 が正。
-- 内容:
--   (1) 請負代金内訳書・リサイクル説明書 → folder 0（小分類=落札後提出資料）
--   (2) 総合評価計画書(技術提案) → folder 0（小分類=入札関係）
--   (3) 施工能力評価表 をマスタに新規追加 → folder 0（無ければ挿入・冪等）
--   (4) 既存のテンプレ由来 submission_documents を新フォルダへ再同期
-- 冪等: 何度流しても安全。
-- ============================================================

-- ── 1) 既存マスタの再割当（02/05 → 00.入札時資料）─────────────
UPDATE required_doc_templates
SET folder_no = 0, folder_name = '入札時資料',
    subcategory = CASE
      WHEN doc_name LIKE '%総合評価%' THEN '入札関係'
      ELSE '落札後提出資料'
    END
WHERE doc_name IN ('請負代金内訳書', 'リサイクル説明書', '総合評価計画書(技術提案)');

-- ── 2) 施工能力評価表 をマスタへ追加（未登録なら）───────────────
INSERT INTO required_doc_templates
  (category_no, category, subcategory, doc_name, trade, work_category,
   submit_timing, deadline_code, approval_route, form_no, retention, is_security,
   sort_order, folder_no, folder_name)
SELECT 1, '契約・設計図書', '入札関係', '施工能力評価表', '共通', '共通',
       '入札時', 'BEFORE_CONTRACT', '-', NULL, '5年', FALSE,
       3, 0, '入札時資料'
WHERE NOT EXISTS (
  SELECT 1 FROM required_doc_templates WHERE doc_name = '施工能力評価表'
);

-- ── 3) 既存のテンプレ由来 submission_documents を再同期 ─────────
-- 手入力(template_id IS NULL)は触らない。
UPDATE submission_documents sd
SET folder_no    = t.folder_no,
    folder_name  = t.folder_name,
    subcategory  = t.subcategory,
    category_no  = t.folder_no,
    category     = t.folder_name
FROM required_doc_templates t
WHERE sd.template_id = t.id
  AND t.folder_no IS NOT NULL
  AND t.doc_name IN ('請負代金内訳書', 'リサイクル説明書', '総合評価計画書(技術提案)', '施工能力評価表');

-- ── 確認用（任意）──────────────────────────────────────────
-- SELECT folder_no, folder_name, doc_name FROM required_doc_templates
--   WHERE folder_no = 0 ORDER BY sort_order;
