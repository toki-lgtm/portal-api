-- ============================================================
-- 023: 工事管理（提出書類・検査書類の管理）
-- 実行先: Supabase SQL Editor
-- 目的:
--   公共建築工事（第一弾＝九州防衛局）の提出書類を工事ごとに一元管理する。
--   - construction_projects   : 工事案件本体（入札案件 bid_projects から昇格可）
--   - required_doc_templates  : 必要書類マスタ（雛形）。工事作成時に複製してチェックリスト化
--   - submission_documents    : 工事ごとの提出書類実体（進捗・締切・ファイル参照）
--   分類は「大分類(業務フェーズ1-9) × 横串属性(工種/新設改修/セキュリティ等)」。
--   締切は deadline_code（契約日・完成検査日等の起点）からアプリ側で実日付を算出する。
--   重いファイル（写真/CAD/PDF）は共有ドライブのまま file_ref で参照（本テーブルはメタのみ）。
--   RLS は他テーブルと同様にオフ（アプリ側の requireAuth + requireConstructionAccess で制御）。
--
-- 関連: 権限は staff_app_permissions の app_key='construction'（member/admin）。
--       server.js の allApps に key='construction' を登録すること。
-- ============================================================

-- ── 再実行を安全にするための初期化 ─────────────────────────────
DROP TABLE IF EXISTS submission_documents   CASCADE;
DROP TABLE IF EXISTS required_doc_templates CASCADE;
DROP TABLE IF EXISTS construction_projects  CASCADE;

-- ── 1) 工事案件本体 ───────────────────────────────────────────
CREATE TABLE construction_projects (
  id               BIGSERIAL PRIMARY KEY,

  -- 入札連携（受注 → 工事へ昇格。手動新規作成では NULL）
  bid_project_id   BIGINT REFERENCES bid_projects(id),

  -- 基本情報
  project_name     TEXT NOT NULL,                        -- 工事名
  project_code     TEXT,                                 -- 工事番号 / 契約番号
  client_org       TEXT DEFAULT '九州防衛局',            -- 発注者
  construction_type TEXT NOT NULL DEFAULT '建築'         -- 工種大別
                   CHECK (construction_type IN ('建築','土木','電気','機械','その他')),
  work_category    TEXT NOT NULL DEFAULT '新設'          -- 工事区分
                   CHECK (work_category IN ('新設','改修','その他')),
  location         TEXT,                                 -- 工事場所（基地・駐屯地名 等）

  -- 金額・工期（締切計算の起点となる日付を含む）
  contract_amount  BIGINT,                               -- 契約金額（円）
  contract_date    DATE,                                 -- 契約日（締切計算の起点①）
  start_date       DATE,                                 -- 着工日
  end_date         DATE,                                 -- 工期末
  completion_inspection_date DATE,                       -- 完成検査(予定)日（締切計算の起点②）

  -- 体制
  site_agent_id    TEXT REFERENCES staff_master(id),     -- 現場代理人
  chief_engineer_id TEXT REFERENCES staff_master(id),    -- 監理（主任）技術者

  -- 既存ファイルの所在（共有ドライブの工事フォルダ）
  drive_folder_url TEXT,

  -- ステータス
  status           TEXT NOT NULL DEFAULT 'in_progress'
                   CHECK (status IN (
                     'preparing',   -- 着手準備
                     'in_progress', -- 施工中
                     'inspecting',  -- 検査中
                     'completed',   -- 完成・引渡済
                     'archived'     -- 保管（過年度）
                   )),

  -- 管理
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cons_proj_status   ON construction_projects(status);
CREATE INDEX IF NOT EXISTS idx_cons_proj_bid      ON construction_projects(bid_project_id);
CREATE INDEX IF NOT EXISTS idx_cons_proj_active   ON construction_projects(is_active);

-- ── 2) 必要書類マスタ（雛形）───────────────────────────────────
-- 工事作成時にこのマスタを複製して submission_documents を生成する。
-- 出典: 九州防衛局 工事管理要領「提出書類一覧(工事)」を9大分類へ再編（v0.1）。
CREATE TABLE required_doc_templates (
  id              BIGSERIAL PRIMARY KEY,
  category_no     INT  NOT NULL,                          -- 大分類No(1-9・業務フェーズ)
  category        TEXT NOT NULL,                          -- 大分類名
  subcategory     TEXT,                                   -- 中分類
  doc_name        TEXT NOT NULL,                          -- 書類名称
  trade           TEXT DEFAULT '共通',                    -- 工種（横串属性）
  work_category   TEXT DEFAULT '共通',                    -- 新設 / 改修 / 共通
  submit_timing   TEXT,                                   -- 提出時期（原文）
  deadline_code   TEXT,                                   -- 締切コード（例: CONTRACT+14d, MONTHLY-25, ON_COMPLETION_INSP）
  approval_route  TEXT,                                   -- 決裁（監督官 / 課長 / 支担官 等）
  form_no         TEXT,                                   -- 防衛局標準書式集の様式番号(#)
  retention       TEXT,                                   -- 保存期間（5年 / 10年 / 30年）
  is_security     BOOLEAN NOT NULL DEFAULT FALSE,         -- 防衛局セキュリティ書類（立入/秘密保全/保全教育）
  note            TEXT,
  sort_order      INT  NOT NULL DEFAULT 0,                -- 表示順
  is_active       BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_doc_tmpl_cat ON required_doc_templates(category_no);

-- ── 3) 提出書類（工事ごとの実体）──────────────────────────────
-- ファイル本体は共有ドライブ等に保存し、file_ref で参照（メタのみ記録）。
CREATE TABLE submission_documents (
  id            BIGSERIAL PRIMARY KEY,
  project_id    BIGINT NOT NULL REFERENCES construction_projects(id) ON DELETE CASCADE,
  template_id   BIGINT REFERENCES required_doc_templates(id),  -- 由来テンプレ（手動追加は NULL）

  -- テンプレからの転記（マスタ更新と独立させるためコピー保持）
  category_no   INT  NOT NULL,
  category      TEXT NOT NULL,
  subcategory   TEXT,
  doc_name      TEXT NOT NULL,
  trade         TEXT DEFAULT '共通',
  form_no       TEXT,

  -- 進捗
  status        TEXT NOT NULL DEFAULT 'not_started'
                CHECK (status IN (
                  'not_started',    -- 未着手
                  'drafting',       -- 作成中
                  'internal_review',-- 社内確認
                  'submitted',      -- 提出済
                  'approved',       -- 承認
                  'rejected',       -- 差戻し
                  'na'              -- 対象外
                )),
  due_date      DATE,                                    -- 締切（deadline_code から算出した実日付）
  submitted_at  DATE,
  approved_at   DATE,

  assignee_id   TEXT REFERENCES staff_master(id),        -- 担当
  file_ref      TEXT,                                    -- ファイル参照（Drive fileId / 共有ドライブパス 等）
  note          TEXT,

  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sub_doc_project ON submission_documents(project_id);
CREATE INDEX IF NOT EXISTS idx_sub_doc_status  ON submission_documents(status);
CREATE INDEX IF NOT EXISTS idx_sub_doc_due     ON submission_documents(due_date);
CREATE INDEX IF NOT EXISTS idx_sub_doc_assignee ON submission_documents(assignee_id);

-- ── 4) 必要書類マスタ シード（新設・建築 / 全123件・v0.1）──────
INSERT INTO required_doc_templates
  (category_no, category, subcategory, doc_name, trade, work_category,
   submit_timing, deadline_code, approval_route, form_no, retention, is_security, sort_order)
VALUES
(1, '契約・設計図書', '契約', '請負代金内訳書', '共通', '新設', '契約後2週間以内(一般競争入札のみ)', 'CONTRACT+14d', '監督官', NULL, '5年', FALSE, 1),
(1, '契約・設計図書', '契約', 'リサイクル説明書', '共通', '共通', '契約前', 'BEFORE_CONTRACT', '監督官', NULL, '5年', FALSE, 2),
(1, '契約・設計図書', '設計図書', '設計図書(変更分含む)', '共通', '共通', '契約時', 'ANYTIME', '-', NULL, '5年', FALSE, 3),
(1, '契約・設計図書', '設計図書', '現場説明書(補足説明書)', '共通', '共通', '契約時', 'ANYTIME', '-', NULL, '5年', FALSE, 4),
(2, '着手・届出', '着手', '着工届(特借のみ)', '共通', '新設', '契約後2週間以内', 'CONTRACT+14d', '監督官', NULL, '5年', FALSE, 5),
(2, '着手・届出', '着手', '現場代理人等通知書', '共通', '共通', '契約後2週間以内', 'CONTRACT+14d', '監督官', '1', '5年', FALSE, 6),
(2, '着手・届出', '着手', '現場代理人等変更通知書', '共通', '共通', '変更後2週間以内', 'ON_EVENT', '監督官', '14', '5年', FALSE, 7),
(2, '着手・届出', '工程表', '契約工程表', '共通', '共通', '契約後2週間以内', 'CONTRACT+14d', '監督官', '2', '5年', FALSE, 8),
(2, '着手・届出', '工程表', '変更工程表', '共通', '共通', '変更時', 'ON_EVENT', '監督官', '20', '5年', FALSE, 9),
(2, '着手・届出', '工程表', '実施工程表(赤実線)', '共通', '共通', '契約後速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 10),
(2, '着手・届出', '届出', '工事保険(災害保険等)写し', '共通', '共通', '着工前', 'BEFORE_START', '監督官', NULL, '5年', FALSE, 11),
(2, '着手・届出', '届出', '建退協証紙写し', '共通', '共通', '着工前', 'BEFORE_START', '監督官', '4', '5年', FALSE, 12),
(2, '着手・届出', '届出', 'CORINS登録(着工時)', '共通', '新設', '契約後10日以内(土日除)', 'CORINS+10biz', '監督官', NULL, '5年', FALSE, 13),
(2, '着手・届出', '届出', 'CORINS登録(変更時)', '共通', '共通', '変更後10日以内(土日除)', 'ON_EVENT', '監督官', NULL, '5年', FALSE, 14),
(2, '着手・届出', '届出', '電気保安技術者通知書', '電気', '共通', '契約後14日以内', 'CONTRACT+14d', '監督官', '3', '5年', FALSE, 15),
(2, '着手・届出', '仮設', '仮設建物設置願書', '仮設', '共通', '設置の1週間前', 'ON_EVENT', '課長', '12', '5年', FALSE, 16),
(2, '着手・届出', '基地', '基地立入依頼書', '共通', '共通', '随時', 'ANYTIME', '監督官', '48', '5年', TRUE, 17),
(2, '着手・届出', '基地', '立入許可申請書', '共通', '共通', '随時', 'ANYTIME', '監督官', '49', '5年', TRUE, 18),
(3, '施工計画', '施工計画書', '総合評価計画書(技術提案)', '共通', '新設', '工事着手前/各計画書作成前', 'START-14d', '監督官', NULL, '5年', FALSE, 19),
(3, '施工計画', '施工計画書', '安全衛生施工計画書', '安全', '新設', '工事着手の2週間前', 'START-14d', '監督官', NULL, '5年', FALSE, 20),
(3, '施工計画', '施工計画書', '総合仮設施工計画書', '仮設', '新設', '工事着手の2週間前', 'START-14d', '監督官', NULL, '5年', FALSE, 21),
(3, '施工計画', '施工計画書', '杭打設施工計画書', '地業', '新設', '工事着手の2週間前', 'START-14d', '監督官', NULL, '5年', FALSE, 22),
(3, '施工計画', '施工計画書', '土工事施工計画書', '土工事', '新設', '工事着手の2週間前', 'START-14d', '監督官', NULL, '5年', FALSE, 23),
(3, '施工計画', '施工計画書', '地業工事施工計画書', '地業', '新設', '工事着手の2週間前', 'START-14d', '監督官', NULL, '5年', FALSE, 24),
(3, '施工計画', '施工計画書', '平板載荷試験施工計画書', '地業', '新設', '工事着手の2週間前', 'START-14d', '監督官', NULL, '5年', FALSE, 25),
(3, '施工計画', '施工計画書', '鉄筋工事施工計画書', '鉄筋', '新設', '工事着手の2週間前', 'START-14d', '監督官', NULL, '5年', FALSE, 26),
(3, '施工計画', '施工計画書', '鉄筋ガス圧接工事施工計画書', '鉄筋', '新設', '工事着手の2週間前', 'START-14d', '監督官', NULL, '5年', FALSE, 27),
(3, '施工計画', '施工計画書', '超音波探傷試験検査要領書', '鉄筋', '新設', '工事着手の2週間前', 'START-14d', '監督官', NULL, '5年', FALSE, 28),
(3, '施工計画', '施工計画書', 'コンクリート工事施工計画書', 'コンクリート', '新設', '工事着手の2週間前', 'START-14d', '監督官', NULL, '5年', FALSE, 29),
(3, '施工計画', '施工計画書', '型枠工事施工計画書', 'コンクリート', '新設', '工事着手の2週間前', 'START-14d', '監督官', NULL, '5年', FALSE, 30),
(3, '施工計画', '施工計画書', '鉄骨工事施工計画書', '鉄骨', '新設', '工場製作の2週間前', 'FACTORY-14d', '監督官', NULL, '5年', FALSE, 31),
(3, '施工計画', '施工計画書', 'ブロック工事施工計画書', 'CB/ALC', '新設', '工事着手の2週間前', 'START-14d', '監督官', NULL, '5年', FALSE, 32),
(3, '施工計画', '施工計画書', 'ALCパネル工事施工計画書', 'CB/ALC', '新設', '工事着手の2週間前', 'START-14d', '監督官', NULL, '5年', FALSE, 33),
(3, '施工計画', '施工計画書', '防水工事施工計画書', '防水', '新設', '工事着手の2週間前', 'START-14d', '監督官', NULL, '5年', FALSE, 34),
(3, '施工計画', '施工計画書', '石工事施工計画書', '石', '新設', '工事着手の2週間前', 'START-14d', '監督官', NULL, '5年', FALSE, 35),
(3, '施工計画', '施工計画書', 'タイル工事施工計画書', 'タイル', '新設', '工事着手の2週間前', 'START-14d', '監督官', NULL, '5年', FALSE, 36),
(3, '施工計画', '施工計画書', '木工事施工計画書', '木', '新設', '工事着手の2週間前', 'START-14d', '監督官', NULL, '5年', FALSE, 37),
(3, '施工計画', '施工計画書', '屋根及び樋工事施工計画書', '屋根樋', '新設', '工事着手の2週間前', 'START-14d', '監督官', NULL, '5年', FALSE, 38),
(3, '施工計画', '施工計画書', '金属工事施工計画書', '金属', '新設', '工事着手の2週間前', 'START-14d', '監督官', NULL, '5年', FALSE, 39),
(3, '施工計画', '施工計画書', '左官工事施工計画書', '左官', '新設', '工事着手の2週間前', 'START-14d', '監督官', NULL, '5年', FALSE, 40),
(3, '施工計画', '施工計画書', '吹付塗材仕上工事施工計画書', '左官', '新設', '工事着手の2週間前', 'START-14d', '監督官', NULL, '5年', FALSE, 41),
(3, '施工計画', '施工計画書', '建具施工計画書', '建具', '新設', '工場製作の2週間前', 'FACTORY-14d', '監督官', NULL, '5年', FALSE, 42),
(3, '施工計画', '施工計画書', '塗装工事施工計画書', '塗装', '新設', '工事着手の2週間前', 'START-14d', '監督官', NULL, '5年', FALSE, 43),
(3, '施工計画', '施工計画書', '内装工事施工計画書', '内装', '新設', '工事着手の2週間前', 'START-14d', '監督官', NULL, '5年', FALSE, 44),
(3, '施工計画', '施工計画書', '木製家具施工計画書', '木', '新設', '工場製作の2週間前', 'FACTORY-14d', '監督官', NULL, '5年', FALSE, 45),
(3, '施工計画', '施工計画書', '解体工事施工計画書', '解体', '新設', '工事着手の2週間前', 'START-14d', '監督官', NULL, '5年', FALSE, 46),
(3, '施工計画', '施工計画書', 'アスベスト撤去工事施工計画書', '解体', '新設', '工事着手の2週間前', 'START-14d', '監督官', NULL, '5年', FALSE, 47),
(3, '施工計画', '施工体制', '工事施工体制台帳・体系図', '共通', '共通', '毎月ごと報告', 'MONTHLY-25', '監督官', '10', '5年', FALSE, 48),
(3, '施工計画', '施工体制', '下請負者設定通知書', '共通', '共通', '随時(1次下請のみ)', 'ANYTIME', '監督官', '47', '5年', FALSE, 49),
(4, '施工管理', '打合せ', '工事打合せ簿', '共通', '共通', '随時', 'ANYTIME', '監督官', '27', '5年', FALSE, 50),
(4, '施工管理', '打合せ', '定例会議議事録', '共通', '共通', '随時', 'ANYTIME', '-', NULL, '5年', FALSE, 51),
(4, '施工管理', '施工図', '施工図(杭伏せ/根切り/躯体/鉄筋配筋/鉄骨/建具承認図等)', '共通', '共通', '工事着手の2週間前', 'START-14d', '監督官', NULL, '5年', FALSE, 52),
(4, '施工管理', '材料', '資材承認願書', '共通', '共通', 'その都度', 'ON_EVENT', '監督官', '11', '5年', FALSE, 53),
(4, '施工管理', '材料', '資材搬入報告書', '共通', '共通', '杭・鉄筋・コンクリート・鉄骨の搬入後速やかに', 'AFTER_ASAP', '監督官', '13', '5年', FALSE, 54),
(4, '施工管理', '材料', '出荷証明書(各種)', '共通', '共通', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 55),
(4, '施工管理', '材料', '数量対比表(設計数量・搬入数量)', '共通', '共通', '随時', 'ANYTIME', '監督官', NULL, '5年', FALSE, 56),
(4, '施工管理', '運営', '現場休止届', '共通', '共通', '休止1週間前(GW/夏季/年末年始)', 'ON_EVENT', '課長', NULL, '5年', FALSE, 57),
(4, '施工管理', '運営', '工事進行状況報告書', '共通', '共通', '毎月25日までに', 'MONTHLY-25', '監督官', '22', '5年', FALSE, 58),
(4, '施工管理', '運営', '色彩計画書', '塗装', '共通', '随時(部隊へ提出)', 'ANYTIME', '監督官', NULL, '5年', FALSE, 59),
(4, '施工管理', 'コンクリート', 'コンクリート打設計画書', 'コンクリート', '新設', '工事着手の2週間前', 'START-14d', '監督官', NULL, '5年', FALSE, 60),
(4, '施工管理', 'コンクリート', 'コンクリート配合報告書', 'コンクリート', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 61),
(5, '品質・出来形', '試験・検査報告', '地質調査報告書等', '地業', '新設', '施工後速やかに', 'AFTER_ASAP', '監督官', NULL, '30年', FALSE, 62),
(5, '品質・出来形', '試験・検査報告', '杭材料確認書', '地業', '新設', '工場製作の2週間前', 'FACTORY-14d', '監督官', NULL, '5年', FALSE, 63),
(5, '品質・出来形', '試験・検査報告', '杭試験成績表', '地業', '新設', '工場製作の2週間前', 'FACTORY-14d', '監督官', NULL, '5年', FALSE, 64),
(5, '品質・出来形', '試験・検査報告', '杭打設結果報告書', '地業', '新設', '施工後速やかに', 'AFTER_ASAP', '監督官', NULL, '5年', FALSE, 65),
(5, '品質・出来形', '試験・検査報告', '圧縮強度試験報告書(根固め液等)', '地業', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 66),
(5, '品質・出来形', '試験・検査報告', '杭芯ずれ結果報告書', '地業', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 67),
(5, '品質・出来形', '試験・検査報告', '配筋検査報告書', '鉄筋', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 68),
(5, '品質・出来形', '試験・検査報告', '鉄筋ミルシート(原本)', '鉄筋', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 69),
(5, '品質・出来形', '試験・検査報告', '鉄筋ガス圧接検査報告書(全数)', '鉄筋', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 70),
(5, '品質・出来形', '試験・検査報告', '鉄筋圧接超音波探傷検査報告書', '鉄筋', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 71),
(5, '品質・出来形', '試験・検査報告', 'コンクリート試験練り報告書', 'コンクリート', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 72),
(5, '品質・出来形', '試験・検査報告', 'コンクリート圧縮試験成績表', 'コンクリート', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 73),
(5, '品質・出来形', '試験・検査報告', 'モルタル配合報告書', 'コンクリート', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 74),
(5, '品質・出来形', '試験・検査報告', '塩化物試験報告書', 'コンクリート', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 75),
(5, '品質・出来形', '試験・検査報告', 'コンクリート打設結果報告書', 'コンクリート', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 76),
(5, '品質・出来形', '試験・検査報告', 'コンクリート出来形実測図', 'コンクリート', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 77),
(5, '品質・出来形', '試験・検査報告', '仕上げ出来形実測図', '共通', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 78),
(5, '品質・出来形', '試験・検査報告', '鉄骨ミルシート(原本)', '鉄骨', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 79),
(5, '品質・出来形', '試験・検査報告', '鉄骨原寸検査報告書', '鉄骨', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 80),
(5, '品質・出来形', '試験・検査報告', '鉄骨超音波探傷検査報告書', '鉄骨', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 81),
(5, '品質・出来形', '試験・検査報告', '鉄骨製品検査報告書', '鉄骨', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 82),
(5, '品質・出来形', '試験・検査報告', '高力ボルト締付軸力試験報告書', '鉄骨', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 83),
(5, '品質・出来形', '試験・検査報告', '鉄骨建て方検査結果報告書', '鉄骨', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 84),
(5, '品質・出来形', '試験・検査報告', '亜鉛メッキ試験成績表', '金属', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 85),
(5, '品質・出来形', '試験・検査報告', '金属製建具製品検査報告書', '建具', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 86),
(5, '品質・出来形', '試験・検査報告', 'シャッター等製品検査報告書', '建具', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 87),
(5, '品質・出来形', '試験・検査報告', '木製建具製品検査報告書', '建具', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 88),
(5, '品質・出来形', '試験・検査報告', '流し台等製品検査報告書', 'ユニット', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 89),
(5, '品質・出来形', '試験・検査報告', 'ユニット家具等製品検査報告書', 'ユニット', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 90),
(5, '品質・出来形', '試験・検査報告', '各性能評定書・強度確認書等', '建具', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 91),
(5, '品質・出来形', '試験・検査報告', '各試験成績表', '共通', '新設', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 92),
(6, '安全・環境', '安全記録', '店社パトロール実施記録簿(月1回以上)', '共通', '共通', '完成検査時', 'ON_COMPLETION_INSP', '監督官', NULL, '5年', FALSE, 93),
(6, '安全・環境', '安全記録', '安全教育・訓練実施記録簿(月4h以上)', '共通', '共通', '完成検査時', 'ON_COMPLETION_INSP', '監督官', NULL, '5年', FALSE, 94),
(6, '安全・環境', '安全記録', '安全巡視・TBM・KY実施記録簿', '共通', '共通', '完成検査時', 'ON_COMPLETION_INSP', '監督官', NULL, '5年', FALSE, 95),
(6, '安全・環境', '安全記録', '新規入場者教育実施記録簿', '共通', '共通', '完成検査時', 'ON_COMPLETION_INSP', '監督官', NULL, '5年', FALSE, 96),
(6, '安全・環境', '安全記録', '山留め・仮締切・足場・支保工等点検記録簿', '共通', '共通', '完成検査時', 'ON_COMPLETION_INSP', '監督官', NULL, '5年', FALSE, 97),
(6, '安全・環境', '安全記録', '保安施設等の整備・設置・管理記録簿', '共通', '共通', '完成検査時', 'ON_COMPLETION_INSP', '監督官', NULL, '5年', FALSE, 98),
(6, '安全・環境', '環境', '発生材調書', '共通', '共通', '解体完了後随時(1部は部隊)', 'ON_EVENT', '課長', '17', '5年', FALSE, 99),
(6, '安全・環境', '環境', '建設廃棄物マニフェスト', '解体', '共通', '完成検査時(E票コピー)', 'ON_COMPLETION_INSP', '監督官', '38', '5年', FALSE, 100),
(6, '安全・環境', '環境', 'アスベスト・エアーサンプル検査結果報告書', '解体', '共通', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 101),
(6, '安全・環境', '環境', 'ホルムアルデヒド濃度測定報告書', '内装', '共通', '速やかに', 'ASAP', '監督官', NULL, '5年', FALSE, 102),
(6, '安全・環境', '台風', '台風対策報告書/被害速報書', '共通', '共通', '台風前/通過後直ちに', 'ON_EVENT', '監督官', '15', '5年', FALSE, 103),
(7, '工事写真', '写真', '現場工事写真(工程)', '共通', '共通', '完成検査時', 'ON_COMPLETION_INSP', '監督官', NULL, '5年', FALSE, 104),
(7, '工事写真', '写真', '品質管理写真(各種)', '共通', '共通', '完成検査時', 'ON_COMPLETION_INSP', '監督官', NULL, '5年', FALSE, 105),
(7, '工事写真', '写真', '現場・工場立会検査写真', '共通', '共通', '完成検査時', 'ON_COMPLETION_INSP', '監督官', NULL, '5年', FALSE, 106),
(7, '工事写真', '写真', '工場製作状況写真', '共通', '共通', '完成検査時', 'ON_COMPLETION_INSP', '監督官', NULL, '5年', FALSE, 107),
(7, '工事写真', '写真', '完成写真(外観四ツ切2面/各室キャビネ)', '共通', '共通', '完成検査時', 'ON_COMPLETION_INSP', '監督官', NULL, '5年', FALSE, 108),
(8, '検査', '検査願', '工事監督官検査願書', '共通', '共通', '随時(施工の1週間前程度)', 'START-7d', '監督官', NULL, '5年', FALSE, 109),
(8, '検査', '検査願', '場外検査願書', '共通', '共通', '随時', 'ANYTIME', '監督官', NULL, '5年', FALSE, 110),
(8, '検査', '検査願', '既済部分検査願書', '共通', '共通', '検査2週間前', 'INSP-14d', '支担官', '41', '5年', FALSE, 111),
(8, '検査', '検査願', '指定部分完成通知書', '共通', '共通', '検査2週間前', 'INSP-14d', '支担官', '39', '5年', FALSE, 112),
(8, '検査', '完成検査', '完成通知書', '共通', '共通', '完成後ただちに/検査2週間前', 'INSP-14d', '支担官', '34', '5年', FALSE, 113),
(8, '検査', '是正', '手直し調書・現場整理調書', '共通', '共通', '完成検査時(1部は部隊)', 'ON_COMPLETION_INSP', '監督官', '26', '5年', FALSE, 114),
(9, '完成・引渡', '引渡', '引渡書', '共通', '共通', '検査2週間前(引渡日要調整)', 'INSP-14d', '支担官', '35', '5年', FALSE, 115),
(9, '完成・引渡', '引渡', '指定部分引渡書', '共通', '共通', '検査2週間前', 'INSP-14d', '支担官', '40', '5年', FALSE, 116),
(9, '完成・引渡', '完成図', '完成図(原図・CADデータ)', '共通', '共通', '完成検査時', 'ON_COMPLETION_INSP', '監督官', NULL, '5年', FALSE, 117),
(9, '完成・引渡', '完成図', '国有財産図(ケミカル和紙1部/青焼3部)', '共通', '共通', '完成検査時', 'ON_COMPLETION_INSP', '監督官', NULL, '5年', FALSE, 118),
(9, '完成・引渡', '保全', '保全に関する資料', '共通', '共通', '完成検査時(1部は部隊)', 'ON_COMPLETION_INSP', '監督官', NULL, '10年', FALSE, 119),
(9, '完成・引渡', '保全', '予備品等引渡書(鍵一覧表添付)', '共通', '共通', '完成検査時', 'ON_COMPLETION_INSP', '監督官', '36', '10年', FALSE, 120),
(9, '完成・引渡', '保全', '保証書(各種)', '共通', '共通', '完成検査時', 'ON_COMPLETION_INSP', '監督官', NULL, '10年', FALSE, 121),
(9, '完成・引渡', 'CORINS', 'CORINS登録(竣工時)', '共通', '共通', '完成後10日以内(土日除)', 'CORINS+10biz', '監督官', NULL, '5年', FALSE, 122),
(9, '完成・引渡', '電子納品', '電子納品(全書類 CD-R/DVD-R)', '共通', '共通', '完成検査後速やかに', 'AFTER_COMPLETION', '監督官', NULL, '5年', FALSE, 123);
