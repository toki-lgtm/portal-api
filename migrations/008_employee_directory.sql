-- ============================================================
-- 008: 社員一覧（社員台帳の拡張 / アプリ別権限 / 資格管理）
-- 実行先: Supabase SQL Editor
-- 目的:
--   1) 既存 staff_master を「社員一覧」の台帳として拡張（職種・部署・生年月日など）
--   2) アプリ別アクセス権テーブル staff_app_permissions を新設（社員 × アプリ × ロール）
--   3) 資格マスタ qualification_master と 社員⇔資格 staff_qualifications を新設
--      （有効期限つき。建設業の更新管理に対応）
-- 既存の安全パトロール権限（staff_master.app_role / ADMIN_EMAILS）は維持し、
-- staff_app_permissions を「より細かいアプリ別制御」として上乗せする。
-- ============================================================

-- ── 0) 再実行を安全にするための初期化 ───────────────────────
-- 今回新設する3テーブルは migration 008 で初めて作るもので本番データは無い。
-- 過去の途中失敗で中途半端な状態が残っていても確実に作り直せるよう、先に削除する。
-- ※ 既存の app_permissions(001) や staff_master には触れない。
DROP TABLE IF EXISTS staff_qualifications   CASCADE;
DROP TABLE IF EXISTS staff_app_permissions  CASCADE;
DROP TABLE IF EXISTS qualification_master    CASCADE;

-- ── 1) staff_master の台帳カラム拡張 ──────────────────────────
ALTER TABLE staff_master
  ADD COLUMN IF NOT EXISTS furigana   TEXT,           -- ふりがな
  ADD COLUMN IF NOT EXISTS skill_id   TEXT,           -- 技能者ID（CCUS等）
  ADD COLUMN IF NOT EXISTS job_type   TEXT,           -- 職種
  ADD COLUMN IF NOT EXISTS department TEXT,           -- 部署
  ADD COLUMN IF NOT EXISTS birth_date DATE,           -- 生年月日
  ADD COLUMN IF NOT EXISTS gender     TEXT,           -- 性別
  ADD COLUMN IF NOT EXISTS phone      TEXT,           -- 電話番号
  ADD COLUMN IF NOT EXISTS hire_date  DATE,           -- 雇入年月日
  ADD COLUMN IF NOT EXISTS is_active  BOOLEAN NOT NULL DEFAULT TRUE; -- 在籍中

-- ── 2) アプリ別アクセス権 ────────────────────────────────────
-- app_key: 'safety-patrol' | 'employee-list' | 'mailer' | 'file-manager' | 'evaluation' | 'dormitory' ...
-- access_level: 'member'（利用可）| 'admin'（アプリ内管理者）。行が無い = アクセス不可。
-- 注: migration 001 で別用途の public.app_permissions（user_id ベース・未使用）が
--     既に存在するため、衝突を避けて staff_app_permissions という名前で新設する。
CREATE TABLE IF NOT EXISTS staff_app_permissions (
  id           SERIAL PRIMARY KEY,
  staff_id     TEXT NOT NULL REFERENCES staff_master(id) ON DELETE CASCADE,
  app_key      TEXT NOT NULL,
  access_level TEXT NOT NULL DEFAULT 'member' CHECK (access_level IN ('member', 'admin')),
  created_at   TIMESTAMP DEFAULT NOW(),
  updated_at   TIMESTAMP DEFAULT NOW(),
  UNIQUE (staff_id, app_key)
);
CREATE INDEX IF NOT EXISTS idx_staff_app_permissions_staff ON staff_app_permissions(staff_id);

-- ── 3) 資格マスタ ────────────────────────────────────────────
-- category: '特別教育' | '技能講習' | '免許' | 'その他'（作業員名簿の区分に準拠）
-- has_expiry: 有効期限の概念がある資格か（true の場合 staff_qualifications.expiry_date を期限管理対象とする）
CREATE TABLE IF NOT EXISTS qualification_master (
  id         TEXT PRIMARY KEY,            -- 例: Q001
  name       TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'その他'
             CHECK (category IN ('特別教育', '技能講習', '免許', 'その他')),
  has_expiry BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_qualification_master_name ON qualification_master(name);

-- ── 4) 社員 ⇔ 資格 ──────────────────────────────────────────
-- 同一社員が同じ資格を更新で複数回持つケースは想定せず、(staff_id, qualification_id) を一意とする。
CREATE TABLE IF NOT EXISTS staff_qualifications (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id         TEXT NOT NULL REFERENCES staff_master(id) ON DELETE CASCADE,
  qualification_id TEXT NOT NULL REFERENCES qualification_master(id) ON DELETE CASCADE,
  acquired_date    DATE,          -- 取得（修了）年月日
  expiry_date      DATE,          -- 有効期限（has_expiry の資格のみ）
  cert_number      TEXT,          -- 免許番号・修了証番号
  note             TEXT,
  created_at       TIMESTAMP DEFAULT NOW(),
  updated_at       TIMESTAMP DEFAULT NOW(),
  UNIQUE (staff_id, qualification_id)
);
CREATE INDEX IF NOT EXISTS idx_staff_qualifications_staff ON staff_qualifications(staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_qualifications_expiry ON staff_qualifications(expiry_date);

-- ── 5) 既存スタッフへ初期アクセス権をシード（現行挙動の維持）──
-- 安全パトロール: 既存 app_role をそのままアプリ別権限へ反映
INSERT INTO staff_app_permissions (staff_id, app_key, access_level)
  SELECT id, 'safety-patrol', CASE WHEN app_role = 'admin' THEN 'admin' ELSE 'member' END
  FROM staff_master
ON CONFLICT (staff_id, app_key) DO NOTHING;

-- 社員一覧: 管理者は admin、それ以外は閲覧用に member を付与（全社員が一覧を見られる運用）
INSERT INTO staff_app_permissions (staff_id, app_key, access_level)
  SELECT id, 'employee-list', CASE WHEN app_role = 'admin' THEN 'admin' ELSE 'member' END
  FROM staff_master
ON CONFLICT (staff_id, app_key) DO NOTHING;

-- ── 6) 資格マスタの初期データ（建設業で頻出のもの。運用しながら追加可）──
INSERT INTO qualification_master (id, name, category, has_expiry, sort_order) VALUES
  ('Q001', '職長・安全衛生責任者教育', '特別教育', FALSE, 10),
  ('Q002', '足場の組立て等作業従事者特別教育', '特別教育', FALSE, 20),
  ('Q003', 'フルハーネス型墜落制止用器具特別教育', '特別教育', FALSE, 30),
  ('Q004', '玉掛け技能講習', '技能講習', FALSE, 40),
  ('Q005', '車両系建設機械（整地・運搬・積込み用及び掘削用）運転技能講習', '技能講習', FALSE, 50),
  ('Q006', '小型移動式クレーン運転技能講習', '技能講習', FALSE, 60),
  ('Q007', 'フォークリフト運転技能講習', '技能講習', FALSE, 70),
  ('Q008', '高所作業車運転技能講習', '技能講習', FALSE, 80),
  ('Q009', 'ガス溶接技能講習', '技能講習', FALSE, 90),
  ('Q010', '第一種衛生管理者', '免許', FALSE, 100),
  ('Q011', '移動式クレーン運転士免許', '免許', FALSE, 110),
  ('Q012', '普通自動車運転免許', '免許', TRUE, 120),
  ('Q013', '中型自動車運転免許', '免許', TRUE, 130),
  ('Q014', '大型自動車運転免許', '免許', TRUE, 140)
ON CONFLICT (id) DO NOTHING;
