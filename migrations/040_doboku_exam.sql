-- ============================================================
-- 040: 1級土木施工管理技士 第二次検定 学習アプリ
-- 実行先: Supabase SQL Editor
-- 目的:
--   既存「資格学習」アプリ（exam-prep, view=exam）の枠組みに相乗りしつつ、
--   第二次検定は記述式（経験記述＋短文記述）のため、採点・データ構造を
--   専用テーブル（doboku_*）で別建てにする。
--
--   入口（メニュー）= 既存 exam_subjects に1行登録して科目カードとして並べる。
--   システム（本文・過去問・経験記述・AI添削）= 本migrationの doboku_* で構築。
--
--   権限は exam-prep と同じ2層を流用:
--     第1層 = staff_app_permissions['exam-prep']（アプリ自体の利用可否）
--     第2層 = exam_subject_access（科目 'doboku-1-2ji' のアクセス権）
--
--   ⚠ exam_subjects / exam_subject_access には本番データ（ソムリエ）があるため
--     DROP しない。ALTER（列追加）と INSERT（科目1行）のみ＝additive。
--     新設の doboku_* だけ再実行安全に DROP→CREATE する。
-- ============================================================

-- ── 0) 既存 exam_subjects に科目の種別フラグを追加（additive）──────────────
--   kind: 'choice'=4択演習（従来）/ 'doboku-2ji'=第二次検定（記述・別UIへ分岐）
--   フロント(ExamPage)は kind を見て、'doboku-2ji' なら専用画面(DobokuExamPage)を開く。
ALTER TABLE exam_subjects ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'choice';

-- 第二次検定の科目を1行登録（メニューに科目カードとして出すため）。再実行は無害。
INSERT INTO exam_subjects (id, name, exam_org, year, source, description, sort_order, is_active, kind)
VALUES (
  'doboku-1-2ji',
  '1級土木施工管理技士 第二次検定',
  '全国建設研修センター',
  2026,
  'CiC出版『1級土木施工管理技士 第二次検定 テキスト＆過去問題集 2026年度版』',
  '施工経験記述のAI添削・短文記述の過去問演習・図入りテキスト通読・模範解答例の参照',
  10,
  TRUE,
  'doboku-2ji'
)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      kind = EXCLUDED.kind,
      source = EXCLUDED.source,
      description = EXCLUDED.description;

-- ── 再実行を安全にするための初期化（新設テーブルのみ）─────────────────────
DROP TABLE IF EXISTS doboku_pq_progress  CASCADE;
DROP TABLE IF EXISTS doboku_ai_reviews   CASCADE;
DROP TABLE IF EXISTS doboku_user_records CASCADE;
DROP TABLE IF EXISTS doboku_model_records CASCADE;
DROP TABLE IF EXISTS doboku_pq_answers   CASCADE;
DROP TABLE IF EXISTS doboku_past_questions CASCADE;
DROP TABLE IF EXISTS doboku_figures      CASCADE;
DROP TABLE IF EXISTS doboku_sections     CASCADE;

-- ── 1) 通読テキスト（編・章ツリー）────────────────────────────────────
--   第2〜7編（土工/コンクリート/施工計画/品質管理/安全管理/環境保全）等の
--   「基礎解説」本文を、編→章の単位で格納。本文は Markdown のまま保持。
CREATE TABLE doboku_sections (
  id            BIGSERIAL PRIMARY KEY,
  subject_id    TEXT NOT NULL DEFAULT 'doboku-1-2ji' REFERENCES exam_subjects(id) ON DELETE CASCADE,
  part_no       INTEGER NOT NULL,            -- 編番号（第2編=2 …）
  part_name     TEXT NOT NULL,               -- 編名（'コンクリート工' 等）
  chapter_no    INTEGER,                     -- 章/節番号（無ければ NULL）
  chapter_title TEXT,                        -- 章/節タイトル
  body_md       TEXT NOT NULL DEFAULT '',    -- 本文（Markdown。表・図参照を含む）
  sort_order    INTEGER NOT NULL DEFAULT 0,  -- 表示順（本の並び）
  src_page      INTEGER,                     -- 出典PDFページ（突合用）
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_doboku_sections_part ON doboku_sections(subject_id, part_no, sort_order);

-- ── 2) 図版（通読本文に紐づく図・グラフ・断面図）──────────────────────
--   画像は Supabase Storage の公開バケット 'doboku-images' に置き、その相対パスを保持。
CREATE TABLE doboku_figures (
  id          BIGSERIAL PRIMARY KEY,
  section_id  BIGINT REFERENCES doboku_sections(id) ON DELETE CASCADE,
  image_path  TEXT NOT NULL,                 -- 'doboku-images' バケット内パス（例 'figures/p123_1.jpg'）
  caption     TEXT,                          -- 図の説明（> 【図】 …）
  sort_order  INTEGER NOT NULL DEFAULT 0,
  src_page    INTEGER
);
CREATE INDEX idx_doboku_figures_section ON doboku_figures(section_id);

-- ── 3) 短文記述 過去問（令和7〜平成28の10年分）──────────────────────
--   q_type: 'free' = 自由記述（「留意点を2つ記述」等。模範解答と照合/AI採点）
--           'blank'= 穴埋め（(イ)〜(ホ) に語句。空欄ごとに正解があり機械採点可）
CREATE TABLE doboku_past_questions (
  id          BIGSERIAL PRIMARY KEY,
  subject_id  TEXT NOT NULL DEFAULT 'doboku-1-2ji' REFERENCES exam_subjects(id) ON DELETE CASCADE,
  part_no     INTEGER NOT NULL,              -- 編番号（出題分野）
  part_name   TEXT NOT NULL,                 -- 編名
  q_no        INTEGER NOT NULL,              -- 問題集内の通し No（【No.N】）
  year_label  TEXT,                          -- 出題年度（'令和7年度' 等。表示・絞込用）
  exam_no     TEXT,                          -- 本試験での問題番号（'問題8' 等）
  q_type      TEXT NOT NULL DEFAULT 'free' CHECK (q_type IN ('free','blank')),
  stem        TEXT NOT NULL,                 -- 問題文（穴埋めは (イ)〜 を含む本文）
  note        TEXT,                          -- 補足解説（本の補足。任意）
  image_path  TEXT,                          -- 図版（任意）
  sort_order  INTEGER NOT NULL DEFAULT 0,
  src_page    INTEGER,
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW(),
  UNIQUE (subject_id, part_no, q_no)
);
CREATE INDEX idx_doboku_pq_part ON doboku_past_questions(subject_id, part_no, sort_order);
CREATE INDEX idx_doboku_pq_year ON doboku_past_questions(subject_id, year_label);

-- ── 4) 過去問の模範解答 ─────────────────────────────────────────────
--   free  : answer_text に模範解答（全文）。複数項目は1レコードに改行で保持してよい。
--   blank : blanks に空欄ごとの正解を JSON 配列で保持。
--           例 [{"mark":"イ","answer":"スランプ","alts":["スランプ値"]}, …]
--           機械採点は mark ごとに answer/alts と完全一致（NFKC正規化後）で判定。
CREATE TABLE doboku_pq_answers (
  id                BIGSERIAL PRIMARY KEY,
  past_question_id  BIGINT NOT NULL REFERENCES doboku_past_questions(id) ON DELETE CASCADE,
  answer_text       TEXT,                     -- free の模範解答（全文）
  blanks            JSONB NOT NULL DEFAULT '[]'::jsonb, -- blank の空欄別正解
  explanation       TEXT,                     -- 解答に付随する補足解説（任意）
  UNIQUE (past_question_id)
);

-- ── 5) 施工経験記述の模範例（書籍由来。全員参照可の資料庫）──────────────
--   工事種別(trade) × 課題種別(theme) ごとの記述例。
--   theme: '品質管理'/'安全管理'/'工程管理'/'施工計画'/'環境対策'
--   overview: 〔工事概要〕を JSON で保持
--     {"工事名":...,"立場":...,"発注者":...,"工事場所":...,"工期":...,"主な工種":...,"施工量":...}
CREATE TABLE doboku_model_records (
  id          BIGSERIAL PRIMARY KEY,
  subject_id  TEXT NOT NULL DEFAULT 'doboku-1-2ji' REFERENCES exam_subjects(id) ON DELETE CASCADE,
  trade       TEXT NOT NULL,                 -- 工事種別（'舗装工事' 等）
  theme       TEXT NOT NULL,                 -- 課題種別
  overview    JSONB NOT NULL DEFAULT '{}'::jsonb, -- 工事概要
  answer1     TEXT,                          -- 設問1：現場状況・技術的課題・検討項目
  answer2     TEXT,                          -- 設問2：対応処置とその評価
  sort_order  INTEGER NOT NULL DEFAULT 0,
  src_page    INTEGER,
  created_at  TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_doboku_model_trade ON doboku_model_records(subject_id, trade);
CREATE INDEX idx_doboku_model_theme ON doboku_model_records(subject_id, theme);

-- ── 6) 個人の経験記述ドラフト（本人作成。draftは本人のみ／doneは匿名で社内共有）──
--   工事概要は1人で複数（工事種別違い）持てる。各課題(theme)ごとに記述を作る。
--   status: 'draft'（作成中＝本人のみ閲覧）/ 'done'（仕上げ済＝社内共有の対象）
--   共有方針（2026-06-29 トキ確定）:
--     ・status='done' になった記述は、他の受験者に「社内事例」として匿名表示する。
--     ・共有ビューは完全匿名（投稿者名・AI点数は出さない。本文＝overview/answer1/answer2のみ）。
--     ・is_shared = 安全弁。既定 TRUE（done で自動共有）。機微な工事は本人が FALSE にして共有から外せる。
--   ⇒ 社内共有ライブラリの取得条件 = (status='done' AND is_shared=TRUE)。
--   ⚠ 匿名でも工事概要（発注者名・工事場所等）から書き手が推測され得る点は周知の上で運用。
CREATE TABLE doboku_user_records (
  id          BIGSERIAL PRIMARY KEY,
  staff_id    TEXT NOT NULL REFERENCES staff_master(id) ON DELETE CASCADE,
  subject_id  TEXT NOT NULL DEFAULT 'doboku-1-2ji' REFERENCES exam_subjects(id) ON DELETE CASCADE,
  title       TEXT,                          -- 自分用ラベル（'A工事 品質' 等）
  overview    JSONB NOT NULL DEFAULT '{}'::jsonb, -- 工事概要（模範例と同形）
  theme       TEXT,                          -- 課題種別
  answer1     TEXT,                          -- 設問1の記述
  answer2     TEXT,                          -- 設問2の記述
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','done')),
  is_shared   BOOLEAN NOT NULL DEFAULT TRUE, -- 社内共有の安全弁（done時に有効。FALSEで共有除外）
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_doboku_user_records_staff  ON doboku_user_records(staff_id, updated_at DESC);
-- 社内共有ライブラリ用（done かつ共有ONを、課題種別で絞って一覧）
CREATE INDEX idx_doboku_user_records_shared ON doboku_user_records(subject_id, theme, updated_at DESC)
  WHERE status = 'done' AND is_shared = TRUE;

-- ── 7) AI添削ログ（ドラフトに対する Gemini 採点・講評。履歴として蓄積）──
--   1回の添削=1行。最新だけでなく履歴を残し、推敲の変遷を追えるようにする。
--   good_points / improvements は文字列配列の JSON。
CREATE TABLE doboku_ai_reviews (
  id              BIGSERIAL PRIMARY KEY,
  record_id       BIGINT NOT NULL REFERENCES doboku_user_records(id) ON DELETE CASCADE,
  staff_id        TEXT NOT NULL REFERENCES staff_master(id) ON DELETE CASCADE,
  score           INTEGER,                   -- 100点満点の目安
  summary         TEXT,                      -- 総評
  good_points     JSONB NOT NULL DEFAULT '[]'::jsonb, -- 良い点（配列）
  improvements    JSONB NOT NULL DEFAULT '[]'::jsonb, -- 改善点（配列）
  revised_example TEXT,                      -- 添削後の例文
  model           TEXT,                      -- 使用モデル（'gemini-2.5-flash' 等）
  created_at      TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_doboku_ai_reviews_record ON doboku_ai_reviews(record_id, created_at DESC);

-- ── 8) 過去問の学習記録（個人 × 過去問。exam_progress と同型）──────────
--   self_rating : 自由記述の自己採点（'○'/'△'/'×' 等）
--   ai_score    : 自由記述の AI 採点（任意, 100点満点）
--   last_correct: 穴埋めの直近正誤
CREATE TABLE doboku_pq_progress (
  id                BIGSERIAL PRIMARY KEY,
  staff_id          TEXT NOT NULL REFERENCES staff_master(id) ON DELETE CASCADE,
  past_question_id  BIGINT NOT NULL REFERENCES doboku_past_questions(id) ON DELETE CASCADE,
  subject_id        TEXT NOT NULL DEFAULT 'doboku-1-2ji',
  attempts          INTEGER NOT NULL DEFAULT 0,
  correct_count     INTEGER NOT NULL DEFAULT 0,
  last_correct      BOOLEAN,
  self_rating       TEXT,
  ai_score          INTEGER,
  last_answered     TIMESTAMP,
  created_at        TIMESTAMP DEFAULT NOW(),
  updated_at        TIMESTAMP DEFAULT NOW(),
  UNIQUE (staff_id, past_question_id)
);
CREATE INDEX idx_doboku_pq_progress_staff ON doboku_pq_progress(staff_id, subject_id);
