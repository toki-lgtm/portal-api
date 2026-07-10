-- ============================================================
-- 103: 郵便局 年間指名 管理（post_office）Phase 1
-- 実行先: Supabase SQL Editor
-- 目的:
--   日本郵便の年間事前指名（長崎県対馬エリア・小規模修繕）を管理する。
--   様式1-6「見積書・工事受注一覧表」の1行＝1レコード（post_office_cases）。
--   毎月10日提出の様式1-6は、このテーブルから生成する（生成ログ＝monthly_submissions）。
--   営業日数・提出期限は company_holidays（migration 049/092）を使いアプリ側で算出。
--   重いファイル（見積PDF・写真）は共有ドライブのまま、Phase 2 で file 参照テーブルを追加。
--   RLS は他テーブルと同様にオフ（アプリ側 requireAuth + requirePostOfficeAccess で制御）。
-- 関連: 権限は staff_app_permissions の app_key='post-office'（member/admin）。
--       server.js の allApps に key='post-office' を登録すること。
-- ============================================================

-- ── 再実行を安全にするための初期化 ─────────────────────────────
DROP TABLE IF EXISTS post_office_monthly_submissions CASCADE;
DROP TABLE IF EXISTS post_office_cases              CASCADE;

-- ── 1) 案件本体（＝様式1-6の1行）──────────────────────────────
CREATE TABLE post_office_cases (
  id                 BIGSERIAL PRIMARY KEY,

  -- 年度・整理番号（年度＝2025 は 2025.10.1〜2026.9.30 期）
  fiscal_year        INT  NOT NULL,
  seq_no             INT,
  area               TEXT NOT NULL DEFAULT '長崎県対馬エリア',
  company            TEXT NOT NULL DEFAULT '㈱中原建設',

  -- 依頼状況（進捗）。フロントで桃→緑→黄→青の色分け。
  status             TEXT NOT NULL DEFAULT 'estimate_drafting'
                     CHECK (status IN (
                       'estimate_drafting',  -- 見積作成中（桃）
                       'surveyed',           -- 調査完了
                       'done_no_estimate',   -- 工事完成（見積未提出）
                       'estimate_submitted', -- 見積書提出（緑）
                       'contracted',         -- 工事契約（黄）
                       'completed',          -- 工事完成（青）
                       'canceled',           -- 依頼取消
                       'on_hold',            -- 保留
                       'stopped',            -- 中止
                       'closed'              -- 終了
                     )),

  -- 番号・区分
  eizen_recv_no      TEXT,                                  -- 営繕サポート受付番号（7桁）
  estimate_no        TEXT,                                  -- 識別番号／見積発行番号（例 25-0001）
  response_type      TEXT DEFAULT '一般'                    -- 対応の種別
                     CHECK (response_type IN ('一般','緊急')),
  category           TEXT                                   -- 区分
                     CHECK (category IN ('旧郵便事業','旧郵便局','社宅') OR category IS NULL),

  -- 対象・依頼者
  facility_name      TEXT,                                  -- 施設名称（局名／社宅名）
  requester_org      TEXT,                                  -- 依頼者 所属・役職
  requester_name     TEXT,                                  -- 依頼者 氏名
  is_pre_movein      BOOLEAN NOT NULL DEFAULT FALSE,        -- 社宅入居前修繕か
  is_policy_work     BOOLEAN NOT NULL DEFAULT FALSE,        -- 施策工事か
  work_content       TEXT,                                  -- 工事内容

  -- 見積フェーズ
  request_recv_date       DATE,   -- 見積依頼連絡 受付日
  first_contact_date      DATE,   -- 郵便局等 連絡日（初回）
  survey_designated_date  DATE,   -- 指定を受けた最終調査日
  survey_done_date        DATE,   -- 最終調査 実施完了日
  estimate_submit_date    DATE,   -- 見積書 提出日

  -- 契約フェーズ
  contract_date        DATE,      -- 工事契約日
  contract_amount      BIGINT,    -- 契約金額（税込・円）
  contract_contact_date DATE,     -- 契約後 郵便局等連絡日

  -- 施工・完成
  work_start_date      DATE,      -- 現地工事作業 開始日
  work_done_date       DATE,      -- 現地工事作業 完了日
  completion_docs_date DATE,      -- 完成書類 提出日

  -- 請求・入金
  invoice_date         DATE,      -- 請求書 提出日
  payment_date         DATE,      -- 入金 確認日

  -- 工期確認（BPO）
  contract_number      TEXT,      -- 契約番号（BPO発番）
  eizen_mgmt_no        TEXT,      -- 営繕管理番号
  office_number        TEXT,      -- 局番号
  assessed_amount      BIGINT,    -- 施設センター査定額（税抜）
  completion_deadline  DATE,      -- 完成期限（既定＝契約日＋4ヶ月後の20日、上書き可）

  -- 遅延事情（支社評価の根拠欄）
  estimate_delay_reason   TEXT,
  classification_code     INT CHECK (classification_code BETWEEN 0 AND 4 OR classification_code IS NULL),
  completion_delay_reason TEXT,

  -- 管理
  drive_folder_url   TEXT,                                  -- 案件フォルダ（共有ドライブ）
  assignee_id        TEXT REFERENCES staff_master(id),      -- 担当
  remarks            TEXT,

  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_by         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_case_year     ON post_office_cases(fiscal_year);
CREATE INDEX IF NOT EXISTS idx_po_case_status   ON post_office_cases(status);
CREATE INDEX IF NOT EXISTS idx_po_case_active   ON post_office_cases(is_active);
CREATE INDEX IF NOT EXISTS idx_po_case_assignee ON post_office_cases(assignee_id);

-- ── 2) 月次提出ログ（様式1-6の生成・提出履歴）────────────────
CREATE TABLE post_office_monthly_submissions (
  id                 BIGSERIAL PRIMARY KEY,
  fiscal_year        INT NOT NULL,
  target_month       TEXT,                                  -- 対象月（例 '2026-06'）
  generated_file_ref TEXT,                                  -- 生成した様式1-6ファイル参照
  case_count         INT,
  submitted_at       DATE,
  submitted_to       TEXT,                                  -- 提出先（例 齊藤立都さん）
  note               TEXT,
  created_by         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_sub_year ON post_office_monthly_submissions(fiscal_year);
