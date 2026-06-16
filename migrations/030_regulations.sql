-- ============================================================
-- 030: 法令集（e-Gov法令データベース）
-- 実行先: Supabase SQL Editor
-- 目的:
--   建設・不動産・林業・労務・会社経営に関係する法令（本法・施行令・
--   施行規則）を e-Gov法令API v2 から取得し、ポータルで条文単位に
--   閲覧・全文検索できるようにする。
--   - 原本XML・別表PDF は Google Drive（社内システム/法令集/）に保存し、
--     ここには検索・表示用の構造化データのみを格納する（二層構成）。
--   - regulations_law       : 法令メタ（本法⇔施行令⇔施行規則を parent_law_id で連結）
--   - regulations_article   : 条文（編章節款＋条見出し＋本文。条単位で1行）
--   - regulations_reference : 法令間・条文間の参照リンク
--   - regulations_revision  : 改正履歴（沿革・施行日・現行/未施行）
--   - regulations_bookmark  : 利用者ごとのブックマーク・メモ
--   RLS は他テーブルと同様にオフ（アプリ側の requireAuth + requireRegulationsAccess で制御）。
--
-- 前提:
--   日本語の条文を高速に部分一致検索するため pg_trgm 拡張を使用する。
--   （Supabase では Database → Extensions で pg_trgm を有効化、または下記の
--    CREATE EXTENSION で有効化される）。
--
-- 出典表示義務:
--   e-Gov法令データは政府標準利用規約準拠。画面に出典
--   「出典：e-Gov法令検索（https://laws.e-gov.go.jp/）」を明示すること。
-- ============================================================

-- ── 拡張（日本語部分一致検索の高速化） ─────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── 再実行を安全にするための初期化 ─────────────────────────────
DROP TABLE IF EXISTS regulations_bookmark  CASCADE;
DROP TABLE IF EXISTS regulations_reference CASCADE;
DROP TABLE IF EXISTS regulations_revision  CASCADE;
DROP TABLE IF EXISTS regulations_article   CASCADE;
DROP TABLE IF EXISTS regulations_law       CASCADE;

-- ── 1) 法令メタ ───────────────────────────────────────────────
CREATE TABLE regulations_law (
  id                 BIGSERIAL PRIMARY KEY,

  -- e-Gov 識別子
  law_id             TEXT NOT NULL UNIQUE,                 -- e-Gov法令ID（例: 324AC0000000100）
  law_num            TEXT,                                 -- 法令番号（例: 昭和二十四年法律第百号）

  -- 名称
  title              TEXT NOT NULL,                        -- 法令名（例: 建設業法）
  title_kana         TEXT,                                 -- 読み（あれば）
  abbrev             TEXT,                                 -- 略称（あれば）

  -- 種別・分類
  law_type           TEXT,                                 -- e-Gov種別（Constitution/Act/CabinetOrder/ImperialOrder/MinisterialOrdinance/Rule）
  law_type_label     TEXT,                                 -- 日本語種別（憲法/法律/政令/勅令/省令/規則）
  category_cd        TEXT[] NOT NULL DEFAULT '{}',         -- 事項別分類コード（複数。例: {47,22}）
  category_labels    TEXT[] NOT NULL DEFAULT '{}',         -- 日本語分野名（例: {建築・住宅,土地}）

  -- 本法⇔施行令⇔施行規則のリレーション
  parent_law_id      BIGINT REFERENCES regulations_law(id) ON DELETE SET NULL,  -- 本法（本法自身は NULL）
  relation_type      TEXT NOT NULL DEFAULT 'self'
                     CHECK (relation_type IN (
                       'self',                  -- 本法そのもの
                       'enforcement_order',     -- 施行令（政令）
                       'enforcement_regulation',-- 施行規則（省令）
                       'related'                -- その他関連
                     )),

  -- 日付・版
  promulgation_date  DATE,                                 -- 公布日
  enforcement_date   DATE,                                 -- 現行版の施行日
  current_revision_id TEXT,                                -- 現行リビジョンID（{法令ID}_{施行日}_{改正法令ID}）
  repeal_status      TEXT,                                 -- 廃止状態（None/Repeal 等。NULL=現行）
  is_current         BOOLEAN NOT NULL DEFAULT TRUE,        -- 現行として表示するか
  is_core            BOOLEAN NOT NULL DEFAULT FALSE,       -- コア必須リスト由来か（優先表示・優先同期）

  -- 保存・出典
  xml_file_ref       TEXT,                                 -- 原本XMLの参照（'drive:<fileId>' 等）
  source_url         TEXT,                                 -- e-Gov法令検索の該当ページURL
  article_count      INT NOT NULL DEFAULT 0,               -- 取込済み条文数

  -- 管理
  fetched_at         TIMESTAMPTZ,                          -- 最終取得日時
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reg_law_type      ON regulations_law(law_type);
CREATE INDEX idx_reg_law_parent    ON regulations_law(parent_law_id);
CREATE INDEX idx_reg_law_current   ON regulations_law(is_current);
CREATE INDEX idx_reg_law_core      ON regulations_law(is_core);
CREATE INDEX idx_reg_law_category  ON regulations_law USING gin (category_cd);
-- 法令名のあいまい検索（部分一致高速化）
CREATE INDEX idx_reg_law_title_trgm ON regulations_law USING gin (title gin_trgm_ops);

-- ── 2) 条文（条単位で 1 行。項・号は本文に内包） ───────────────
CREATE TABLE regulations_article (
  id              BIGSERIAL PRIMARY KEY,
  law_id          BIGINT NOT NULL REFERENCES regulations_law(id) ON DELETE CASCADE,

  -- 区分（本則/附則/別表）
  division        TEXT NOT NULL DEFAULT 'main'
                  CHECK (division IN ('main', 'suppl', 'appendix')),
  suppl_label     TEXT,                                    -- 附則の場合の見出し（どの改正附則か）

  -- 階層（パンくず表示用）
  part_num        TEXT,  part_title       TEXT,            -- 編
  chapter_num     TEXT,  chapter_title    TEXT,            -- 章
  section_num     TEXT,  section_title    TEXT,            -- 節
  subsection_num  TEXT,  subsection_title TEXT,            -- 款

  -- 条
  article_num     TEXT,                                    -- 条番号（枝番は "21_2" のように保持）
  article_caption TEXT,                                    -- 条見出し（例: （許可の基準））
  content         TEXT NOT NULL,                           -- 条文本文（項・号を整形して内包）

  sort_order      INT NOT NULL,                            -- 法令内の表示順
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reg_art_law   ON regulations_article(law_id);
CREATE INDEX idx_reg_art_order ON regulations_article(law_id, sort_order);
-- 条文本文・見出しの全文（部分一致）検索
CREATE INDEX idx_reg_art_content_trgm ON regulations_article USING gin (content gin_trgm_ops);
CREATE INDEX idx_reg_art_caption_trgm ON regulations_article USING gin (article_caption gin_trgm_ops);

-- ── 3) 参照リンク（法令間・条文間） ───────────────────────────
CREATE TABLE regulations_reference (
  id              BIGSERIAL PRIMARY KEY,
  from_law_id     BIGINT NOT NULL REFERENCES regulations_law(id) ON DELETE CASCADE,
  from_article_id BIGINT REFERENCES regulations_article(id) ON DELETE CASCADE,  -- 条単位（NULL=法令単位）
  to_law_id       BIGINT REFERENCES regulations_law(id) ON DELETE SET NULL,     -- 解決済み参照先（未取込ならNULL）
  to_law_title    TEXT,                                    -- 参照先法令名（原文表記）
  to_article_num  TEXT,                                    -- 参照先条番号
  ref_text        TEXT,                                    -- 原文中の参照表現（例: 建設業法第三条）
  ref_type        TEXT NOT NULL DEFAULT 'citation'
                  CHECK (ref_type IN (
                    'citation',     -- 条文中の引用
                    'enforcement',  -- 本法⇔施行令・施行規則の体系リンク
                    'related'       -- その他関連
                  )),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reg_ref_from     ON regulations_reference(from_law_id);
CREATE INDEX idx_reg_ref_from_art ON regulations_reference(from_article_id);
CREATE INDEX idx_reg_ref_to       ON regulations_reference(to_law_id);

-- ── 4) 改正履歴（沿革） ───────────────────────────────────────
CREATE TABLE regulations_revision (
  id                  BIGSERIAL PRIMARY KEY,
  law_id              BIGINT NOT NULL REFERENCES regulations_law(id) ON DELETE CASCADE,
  revision_id         TEXT NOT NULL,                       -- リビジョンID
  enforcement_date    DATE,                                -- 施行日
  amendment_law_num   TEXT,                                -- 改正法令番号
  amendment_law_title TEXT,                                -- 改正法令名
  revision_status     TEXT
                      CHECK (revision_status IS NULL OR revision_status IN (
                        'current',  -- 現行
                        'future',   -- 未施行
                        'expired'   -- 失効
                      )),
  summary             TEXT,                                -- 改正概要（あれば）
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (law_id, revision_id)
);

CREATE INDEX idx_reg_rev_law  ON regulations_revision(law_id);
CREATE INDEX idx_reg_rev_date ON regulations_revision(enforcement_date);

-- ── 5) ブックマーク・メモ（利用者ごと） ───────────────────────
CREATE TABLE regulations_bookmark (
  id          BIGSERIAL PRIMARY KEY,
  staff_id    TEXT REFERENCES staff_master(id),            -- 社員（staff_master 参照）
  user_email  TEXT NOT NULL,                               -- 利用者メール（権限・絞り込みの主キー）
  law_id      BIGINT NOT NULL REFERENCES regulations_law(id) ON DELETE CASCADE,
  article_id  BIGINT REFERENCES regulations_article(id) ON DELETE CASCADE,  -- 条単位（NULL=法令単位ブックマーク）
  memo        TEXT,                                        -- 本人メモ
  color       TEXT,                                        -- ラベル色（任意）
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_email, law_id, article_id)
);

CREATE INDEX idx_reg_bm_user ON regulations_bookmark(user_email);
CREATE INDEX idx_reg_bm_law  ON regulations_bookmark(law_id);
