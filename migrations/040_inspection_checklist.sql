-- ============================================================
-- 040: 工事管理 - 検査書類チェックリスト ＆ 書類整理（保管庫）への再編
-- 実行先: Supabase SQL Editor
-- 目的:
--   (1) 書類整理（保管庫）= submission_documents を実フォルダ体系(00〜12)で整理。
--       既存の提出書類/添付ファイルは保全し、旧9分類→13フォルダへマッピング。
--       内容のない自動生成プレースホルダ行のみ掃除。
--   (2) 検査書類チェックリスト = 発注者の「完成・完了検査チェックリスト.xls」の
--       【】項目をマスタ化(新設/改修編)。工事ごとに複製し、達成状況を管理。
--       書類整理の書類を linked_document_id で紐づけ、1日1回のAI棚卸しで自動✓。
--   旧「提出書類チェックリスト(全123種マスタ生成)」運用は廃止。
-- 冪等: 何度流しても安全（DROP/IF NOT EXISTS/重複ガード）。
-- ============================================================

-- ── 1) 検査チェックリスト・マスタ（Excel由来・版別）────────────
DROP TABLE IF EXISTS project_inspection_items CASCADE;
DROP TABLE IF EXISTS inspection_checklist_master CASCADE;

CREATE TABLE inspection_checklist_master (
  id          BIGSERIAL PRIMARY KEY,
  edition     TEXT NOT NULL,                 -- '新設' / '改修'
  section     TEXT NOT NULL,                 -- 区分・工種（見出し）
  item_name   TEXT NOT NULL,                 -- 書類名 / 確認項目
  note        TEXT,                          -- 補足
  sort_order  INT  NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX idx_insp_master_ed ON inspection_checklist_master(edition);

INSERT INTO inspection_checklist_master (edition, section, item_name, note, sort_order) VALUES
('新設', '契約関係書類', '契約書写', NULL, 1),
('新設', '契約関係書類', '現場説明書', NULL, 2),
('新設', '契約関係書類', '現場代理人通知書', NULL, 3),
('新設', '契約関係書類', '契約工程表', NULL, 4),
('新設', '契約関係書類', '設計図書（変更分含）', NULL, 5),
('新設', '契約関係書類', '発生材報告書', NULL, 6),
('新設', '局提出書類（監督官控え）', 'CORINS写（変更分含）', NULL, 7),
('新設', '局提出書類（監督官控え）', '仮設物設置願書', NULL, 8),
('新設', '局提出書類（監督官控え）', '下請負者通知書', NULL, 9),
('新設', '局提出書類（監督官控え）', '工事監督官検査等願書', NULL, 10),
('新設', '局提出書類（監督官控え）', '建設業退職金共済制度の掛金領収書', NULL, 11),
('新設', '局提出書類（監督官控え）', '火災保険等加入状況報告書', NULL, 12),
('新設', '局提出書類（監督官控え）', '工事打合せ簿', '※リスト表を含む', 13),
('新設', '現場で作成する書類', '進行状況報告書', NULL, 14),
('新設', '現場で作成する書類', '総合施工計画書', '※工事着手に先立ち監督官に提出', 15),
('新設', '現場で作成する書類', '総合工程表', NULL, 16),
('新設', '現場で作成する書類', '工事実施工程表（赤実線入）', NULL, 17),
('新設', '現場で作成する書類', '月・週間工程表', NULL, 18),
('新設', '現場で作成する書類', '工事日誌(写し)', NULL, 19),
('新設', '現場で作成する書類', '工程会議議事録等', NULL, 20),
('新設', '現場で作成する書類', '災害防止（工事安全）協議会議事録等', NULL, 21),
('新設', '現場で作成する書類', '店社パトロ－ル記録簿', NULL, 22),
('新設', '現場で作成する書類', '安全教育、新規入場者、ＴＢＭ、ＫＹ記録簿', NULL, 23),
('新設', '現場で作成する書類', '使用重機、車両等の点検整備記録の写し', NULL, 24),
('新設', '現場で作成する書類', '足場、支保工、山留め等の使用中の点検及び管理表', NULL, 25),
('新設', '現場で作成する書類', '建退共証紙受け払い記録簿', NULL, 26),
('新設', '現場で作成する書類', '施工体制台帳、施工体系図関係書類', NULL, 27),
('新設', '現場で作成する書類', '工事監督官及び技術者との連絡調整書類', NULL, 28),
('新設', '現場で作成する書類', '契約書19条第１項第１号から第５号に係わる照査', NULL, 29),
('新設', '現場で作成する書類', '出来形管理図関係書類', NULL, 30),
('新設', '現場で作成する書類', '品質管理関係書類', NULL, 31),
('新設', '現場で作成する書類', '工事写真', '工事種別に順を追って流れ写真まとめ', 32),
('新設', '現場で作成する書類', '施工計画書', NULL, 33),
('新設', '現場で作成する書類', '国有財産図', '※工事完成１０日前までに監督官に提出', 34),
('新設', '現場で作成する書類', '完成図', '※原図・複写図、CADデータ', 35),
('新設', '現場で作成する書類', '工事完成写真', '※デ－タ共', 36),
('新設', '現場で作成する書類', '予備備品等引渡書', NULL, 37),
('新設', '現場で作成する書類', '保全に関する資料', '※クリアケ－スファイルで提出', 38),
('新設', '各工事共通', '施工図(躯体･建具)製本', '※紙ファイル綴じでも可', 39),
('新設', '各工事共通', '材料一覧、承諾書、搬入資料（納品書･出荷証明書）', NULL, 40),
('新設', '各工事共通', '排出ガス対策型建設機械の証明 （カタログ写し、写真）', NULL, 41),
('新設', '各工事共通', '監督官が必要と指示したカタログ類等の写', NULL, 42),
('新設', '各工事共通', '施工計画書', NULL, 43),
('新設', '仮設工事', '総合仮設計画書', '※総合安全計画', 44),
('新設', '仮設工事', '建物位置決定資料', NULL, 45),
('新設', '仮設工事', '指定仮設の実施記録、写真共', '※現場説明書も確認', 46),
('新設', '仮設工事', '指定仮設安全検討資料', NULL, 47),
('新設', '仮設工事', 'ＢＭ及びＧＬ計測記録', NULL, 48),
('新設', '土工事', '施工の確認事項・写真のポイント', NULL, 49),
('新設', '地業工事', '施工の確認事項・写真のポイント', NULL, 50),
('新設', 'コンクリート工事', '施工の確認事項・写真のポイント', NULL, 51),
('新設', '型枠工事', '施工の確認事項・写真のポイント', NULL, 52),
('新設', '鉄筋工事', '施工の確認事項・写真のポイント', NULL, 53),
('新設', '鉄骨工事', '施工の確認事項・写真のポイント', NULL, 54),
('新設', '鉄骨工事', '工事写真', '工場製作・現場建方の写真', 55),
('新設', '鉄骨工事', '工事写真', '工場及び現場の錆止塗料の塗装状況の写真', 56),
('新設', 'ＣＢ・ＡＬＣ・ＰＣ板・ＰＣ工事', '施工の確認事項・写真のポイント', NULL, 57),
('新設', '防水工事', '施工の確認事項・写真のポイント', NULL, 58),
('新設', '防水工事', '工事写真', '工程順の流れ写真', 59),
('新設', '防水工事', '工事写真', '防水端部の金物押え写真', 60),
('新設', '防水工事', '工事写真', '脱気塔取付位置の写真', 61),
('新設', '石工事', '施工の確認事項・写真のポイント', NULL, 62),
('新設', 'タイル工事', '施工の確認事項・写真のポイント', NULL, 63),
('新設', '木工事', '施工の確認事項・写真のポイント', NULL, 64),
('新設', '屋根及びとい工事', '施工の確認事項・写真のポイント', NULL, 65),
('新設', '金属工事', '施工の確認事項・写真のポイント', NULL, 66),
('新設', '左官工事', '施工の確認事項・写真のポイント', NULL, 67),
('新設', '左官工事', '工事写真', '工程順の流れ写真', 68),
('新設', '建具工事', '施工の確認事項・写真のポイント', NULL, 69),
('新設', '建具工事', '工事写真', '工場及び現場の錆止塗料の塗装状況の写真（鋼製建具）', 70),
('新設', '建具工事', '施工図', NULL, 71),
('新設', '硝子工事', '施工の確認事項・写真のポイント', NULL, 72),
('新設', '塗装工事', '施工の確認事項・写真のポイント', NULL, 73),
('新設', '塗装工事', '工事写真', '工程順の流れ写真', 74),
('新設', '塗装工事', '工事写真', '空缶写真', 75),
('新設', '内装工事', '施工の確認事項・写真のポイント', NULL, 76),
('新設', '内装工事', '工事写真', '工程順の流れ写真', 77),
('新設', '内装工事', '施工図', NULL, 78),
('新設', '仕上げﾕﾆｯﾄ工事', '施工の確認事項・写真のポイント', NULL, 79),
('新設', '解体工事', '施工の確認事項・写真のポイント', NULL, 80),
('新設', '解体工事', '解体材精算', NULL, 81),
('改修', '契約関係書類', '契約書写', NULL, 82),
('改修', '契約関係書類', '現場説明書', NULL, 83),
('改修', '契約関係書類', '現場代理人通知書', NULL, 84),
('改修', '契約関係書類', '契約工程表', NULL, 85),
('改修', '契約関係書類', '設計図書（変更分含）', NULL, 86),
('改修', '契約関係書類', '発生材報告書', NULL, 87),
('改修', '局提出書類（監督官控え）', 'CORINS写（変更分含）', NULL, 88),
('改修', '局提出書類（監督官控え）', '仮設物設置願書', NULL, 89),
('改修', '局提出書類（監督官控え）', '下請負者通知書', NULL, 90),
('改修', '局提出書類（監督官控え）', '工事監督官検査等願書', NULL, 91),
('改修', '局提出書類（監督官控え）', '建設業退職金共済制度の掛金領収書', NULL, 92),
('改修', '局提出書類（監督官控え）', '火災保険等加入状況報告書', NULL, 93),
('改修', '局提出書類（監督官控え）', '工事打合せ簿', '※リスト表を含む', 94),
('改修', '現場で作成する書類', '進行状況報告書', NULL, 95),
('改修', '現場で作成する書類', '総合施工計画書', '※工事着手に先立ち監督官に提出', 96),
('改修', '現場で作成する書類', '総合工程表', NULL, 97),
('改修', '現場で作成する書類', '工事実施工程表（赤実線入）', NULL, 98),
('改修', '現場で作成する書類', '月・週間工程表', NULL, 99),
('改修', '現場で作成する書類', '工事日誌(写し)', NULL, 100),
('改修', '現場で作成する書類', '工程会議議事録等', NULL, 101),
('改修', '現場で作成する書類', '災害防止（工事安全）協議会議事録等', NULL, 102),
('改修', '現場で作成する書類', '店社パトロ－ル記録簿', NULL, 103),
('改修', '現場で作成する書類', '安全教育、新規入場者、ＴＢＭ、ＫＹ記録簿', NULL, 104),
('改修', '現場で作成する書類', '使用重機、車両等の点検整備記録の写し', NULL, 105),
('改修', '現場で作成する書類', '足場、支保工、山留め等の使用中の点検及び管理表', NULL, 106),
('改修', '現場で作成する書類', '建退共証紙受け払い記録簿', NULL, 107),
('改修', '現場で作成する書類', '施工体制台帳、施工体系図関係書類', NULL, 108),
('改修', '現場で作成する書類', '工事監督官及び技術者との連絡調整書類', NULL, 109),
('改修', '現場で作成する書類', '契約書19条第１項第１号から第５号に係わる照査', NULL, 110),
('改修', '現場で作成する書類', '出来形管理図関係書類', NULL, 111),
('改修', '現場で作成する書類', '品質管理関係書類', NULL, 112),
('改修', '現場で作成する書類', '工事写真', '工事種別に順を追って流れ写真まとめ', 113),
('改修', '現場で作成する書類', '施工計画書', NULL, 114),
('改修', '現場で作成する書類', '国有財産図', '※工事完成１０日前までに監督官に提出', 115),
('改修', '現場で作成する書類', '完成図', '※原図・複写図、CADデータ', 116),
('改修', '現場で作成する書類', '工事完成写真', '※デ－タ共', 117),
('改修', '現場で作成する書類', '予備備品等引渡書', NULL, 118),
('改修', '現場で作成する書類', '保全に関する資料', '※クリアケ－スファイルで提出', 119),
('改修', '各工事共通', '施工図(躯体･建具)製本', '※紙ファイル綴じでも可', 120),
('改修', '各工事共通', '材料一覧、承諾書、搬入資料（納品書･出荷証明書）', NULL, 121),
('改修', '各工事共通', '排出ガス対策型建設機械の証明 （カタログ写し、写真）', NULL, 122),
('改修', '各工事共通', '監督官が必要と指示したカタログ類等の写', NULL, 123),
('改修', '各工事共通', '施工計画書', NULL, 124),
('改修', '仮設工事', '総合仮設計画書', '※総合安全計画', 125),
('改修', '仮設工事', '指定仮設の実施記録、写真共', '※現場説明書も確認', 126),
('改修', '仮設工事', '指定仮設安全検討資料', NULL, 127),
('改修', '防水改修工事', '施工の確認事項・写真のポイント', NULL, 128),
('改修', '防水改修工事', '工事写真', NULL, 129),
('改修', '外壁改修工事', '施工の確認事項・写真のポイント', NULL, 130),
('改修', '外壁改修工事', '工事写真', NULL, 131),
('改修', '建具改修工事', '施工の確認事項・写真のポイント', NULL, 132),
('改修', '建具改修工事', '施工図', NULL, 133),
('改修', '建具改修工事', '硝子工事', NULL, 134),
('改修', '建具改修工事', '工事写真', NULL, 135),
('改修', '内装改修工事', '施工の確認事項・写真のポイント', NULL, 136),
('改修', '内装改修工事', '施工図', NULL, 137),
('改修', '内装改修工事', '工事写真', NULL, 138),
('改修', '塗装改修工事', '施工の確認事項・写真のポイント', NULL, 139),
('改修', '塗装改修工事', '工事写真', NULL, 140),
('改修', '塗装改修工事', '工事写真', '空缶写真', 141),
('改修', '耐震改修工事', '施工の確認事項・写真のポイント', NULL, 142),
('改修', '耐震改修工事', '工事写真', NULL, 143),
('改修', '環境配慮改修工事', '施工の確認事項・写真のポイント', NULL, 144),
('改修', '環境配慮改修工事', '工事写真', NULL, 145),
('改修', '解体・改修工事', '施工の確認事項・写真のポイント', NULL, 146),
('改修', '解体・改修工事', '解体材精算', NULL, 147);

-- ── 2) 工事ごとの検査チェック項目（マスタ複製＋達成状況）─────────
CREATE TABLE project_inspection_items (
  id            BIGSERIAL PRIMARY KEY,
  project_id    BIGINT NOT NULL REFERENCES construction_projects(id) ON DELETE CASCADE,
  master_id     BIGINT REFERENCES inspection_checklist_master(id),
  edition       TEXT NOT NULL,
  section       TEXT NOT NULL,
  item_name     TEXT NOT NULL,
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'      -- pending 未 / done 済 / na 対象外
                CHECK (status IN ('pending','done','na')),
  linked_document_id BIGINT REFERENCES submission_documents(id) ON DELETE SET NULL,
  ai_checked_at TIMESTAMPTZ,                          -- AI棚卸し最終実行
  ai_note       TEXT,                                 -- AI判定理由
  ai_confidence NUMERIC,
  checked_by    TEXT,                                 -- 人手で✓を付けた人
  checked_at    TIMESTAMPTZ,
  sort_order    INT  NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pii_project ON project_inspection_items(project_id);
CREATE INDEX idx_pii_status  ON project_inspection_items(status);
CREATE INDEX idx_pii_linked  ON project_inspection_items(linked_document_id);

-- ── 3) 書類整理（保管庫）= submission_documents に 00〜12 フォルダ分類を追加 ──
ALTER TABLE submission_documents ADD COLUMN IF NOT EXISTS folder_no   INT;
ALTER TABLE submission_documents ADD COLUMN IF NOT EXISTS folder_name TEXT;

-- 旧9分類(category_no)＋subcategory/doc_name から実フォルダ(00〜12)へマッピング
UPDATE submission_documents SET folder_no = CASE
  WHEN category_no = 1 AND subcategory = '設計図書' THEN 1            -- 01.設計図書
  WHEN category_no = 1 THEN 2                                        -- 02.契約関係
  WHEN category_no = 2 AND subcategory = '工程表' THEN 3             -- 03.工程表
  WHEN category_no = 2 THEN 4                                        -- 04.施主提出書類
  WHEN category_no = 3 AND subcategory = '施工体制' THEN 9           -- 09.施工体制
  WHEN category_no = 3 THEN 5                                        -- 05.施工計画書
  WHEN category_no = 4 AND doc_name LIKE '%議事録%' THEN 12          -- 12.打合議事録
  WHEN category_no = 4 AND subcategory = '打合せ' THEN 6             -- 06.工事打合簿
  WHEN category_no = 4 AND subcategory = '施工図' THEN 7             -- 07.施工図・詳細図・完成図
  WHEN category_no = 4 AND subcategory IN ('材料','コンクリート') THEN 8  -- 08.材料承認・数量
  WHEN category_no = 4 THEN 4                                        -- 04.施主提出書類（運営等）
  WHEN category_no = 5 THEN 8                                        -- 08.材料承認・数量（品質・出来形）
  WHEN category_no = 6 THEN 4                                        -- 04.施主提出書類（安全・環境）
  WHEN category_no = 7 THEN 10                                       -- 10.工事写真
  WHEN category_no = 8 THEN 4                                        -- 04.施主提出書類（検査願等）
  WHEN category_no = 9 AND subcategory = '完成図' THEN 7             -- 07.施工図・詳細図・完成図
  WHEN category_no = 9 THEN 4                                        -- 04.施主提出書類（完成・引渡）
  ELSE 4
END
WHERE folder_no IS NULL;

UPDATE submission_documents SET folder_name = CASE folder_no
  WHEN 0 THEN '入札時資料' WHEN 1 THEN '設計図書' WHEN 2 THEN '契約関係'
  WHEN 3 THEN '工程表' WHEN 4 THEN '施主提出書類' WHEN 5 THEN '施工計画書'
  WHEN 6 THEN '工事打合簿' WHEN 7 THEN '施工図・詳細図・完成図'
  WHEN 8 THEN '材料承認・数量' WHEN 9 THEN '施工体制' WHEN 10 THEN '工事写真'
  WHEN 11 THEN '協力会社見積' WHEN 12 THEN '打合議事録' ELSE '施主提出書類'
END
WHERE folder_name IS NULL;

-- ── 4) 内容のない自動生成プレースホルダ行を掃除（ファイル・記載のある行は保全）──
DELETE FROM submission_documents sd
WHERE sd.template_id IS NOT NULL
  AND sd.status = 'not_started'
  AND sd.note IS NULL
  AND sd.file_ref IS NULL
  AND NOT EXISTS (SELECT 1 FROM submission_files f WHERE f.document_id = sd.id);

-- ── 5) 既存工事へ検査チェック項目を生成（work_category で版を選択）──────
INSERT INTO project_inspection_items
  (project_id, master_id, edition, section, item_name, note, sort_order)
SELECT p.id, m.id, m.edition, m.section, m.item_name, m.note, m.sort_order
FROM construction_projects p
JOIN inspection_checklist_master m
  ON m.edition = CASE WHEN p.work_category = '改修' THEN '改修' ELSE '新設' END
WHERE p.is_active = TRUE
  AND m.is_active = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM project_inspection_items x WHERE x.project_id = p.id
  );
