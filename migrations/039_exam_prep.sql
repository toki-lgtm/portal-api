-- ============================================================
-- 039: 資格学習（問題演習）アプリ
-- 実行先: Supabase SQL Editor
-- 目的:
--   市販の資格試験問題集（まずは「ソムリエ／ワインエキスパート 2026」1300問）を
--   データ化し、ポータル内で4択演習できるようにする。複数の資格（日本酒・ビール・
--   ウイスキー・お茶 等）を後から追加できる汎用プラットフォームとして設計する。
--
--   権限は2層:
--     第1層 = アプリへのアクセス権 … 既存 staff_app_permissions['exam-prep'] に乗せる
--             （/api/apps の権限フィルタと共通。行が無い社員にはアプリ自体を出さない）
--     第2層 = 資格ごとのアクセス権 … 本migrationの exam_subject_access で社員×科目を制御
--             （「ワインは見れるが日本酒は見れない」を実現）
--
--   テーブル:
--     exam_subjects        : 科目＝資格（商品）。例「ソムリエ／ワインエキスパート 2026」
--     exam_chapters        : 章。例「①ワイン概論」「⑦イタリア」
--     exam_questions       : 設問。問題文・選択肢(JSONB)・正解・解説・補足(後から追記可)
--     exam_subject_access  : 第2層権限。社員×科目（行があればその資格を学習可）
--     exam_progress        : 学習記録（集計）。社員×設問の最新状態。成績・復習・再開・弱点抽出に使用
--     exam_answer_log      : 全回答の履歴（追記専用）。1回答=1行。弱点分析・将来の分析用に消さず蓄積
--
--   RLS は他テーブルと同様にオフ。アプリ側 requireAuth + 権限チェックで制御する。
-- ============================================================

-- ── 再実行を安全にするための初期化（新設テーブルのみ。本番データは無い）──────────
DROP TABLE IF EXISTS exam_answer_log     CASCADE;
DROP TABLE IF EXISTS exam_progress       CASCADE;
DROP TABLE IF EXISTS exam_subject_access CASCADE;
DROP TABLE IF EXISTS exam_questions      CASCADE;
DROP TABLE IF EXISTS exam_chapters       CASCADE;
DROP TABLE IF EXISTS exam_subjects       CASCADE;

-- ── 1) 科目（資格） ───────────────────────────────────────────
CREATE TABLE exam_subjects (
  id          TEXT PRIMARY KEY,                 -- 例: 'wine-expert-2026'
  name        TEXT NOT NULL,                    -- 表示名: 'ソムリエ／ワインエキスパート'
  exam_org    TEXT,                             -- 主催: 'J.S.A.' など
  year        INTEGER,                          -- 年度版: 2026
  source      TEXT,                             -- 出典書名（問題集名）
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);

-- ── 2) 章 ─────────────────────────────────────────────────────
CREATE TABLE exam_chapters (
  id          BIGSERIAL PRIMARY KEY,
  subject_id  TEXT NOT NULL REFERENCES exam_subjects(id) ON DELETE CASCADE,
  chapter_no  INTEGER NOT NULL,                 -- 章番号（本の並び順）
  title       TEXT NOT NULL,                    -- 章タイトル: 'ワイン概論'
  sort_order  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (subject_id, chapter_no)
);
CREATE INDEX idx_exam_chapters_subject ON exam_chapters(subject_id);

-- ── 3) 設問 ───────────────────────────────────────────────────
--   q_type : 'choice'=4択（通常）/ 'written'=記述（カタカナ等で答えを書く。地図問題など）
--   choices: 4択の選択肢テキスト配列（JSONB, 原順）。記述は空配列 []。
--            画面表示時はフロントで毎回シャッフルする（丸暗記防止）。
--   answer_no: choices の中で正解の位置（1始まり。本の原番号と一致）。記述は NULL。
--             採点は「選んだ選択肢の中身」で判定するためシャッフルしても正しく当たる。
--   answer_text: 正解の本文。4択=choices[answer_no-1]。記述=正解そのもの（自動照合の基準）。
--   answer_alts : 記述の別表記（表記揺れ吸収用の許容解。JSON配列。任意）。
--   image_path  : 問題に必要な図版（地図・写真）の保存キー。Supabase Storage の
--                 'exam-images' バケット内パス。不要な設問は NULL。
--                 同じ地図を複数設問で共有する場合は各設問に同じパスを入れる。
--   explanation     : 本の原文解説（不変。書き換えない）。
--   explanation_note: 後から自分で足す補足解説（任意。原文を壊さず知識を積める欄）。
CREATE TABLE exam_questions (
  id               BIGSERIAL PRIMARY KEY,
  subject_id       TEXT NOT NULL REFERENCES exam_subjects(id) ON DELETE CASCADE,
  chapter_id       BIGINT NOT NULL REFERENCES exam_chapters(id) ON DELETE CASCADE,
  q_no             INTEGER NOT NULL,            -- 章内の設問番号（本の連番）
  q_type           TEXT NOT NULL DEFAULT 'choice' CHECK (q_type IN ('choice','written')),
  is_hard          BOOLEAN NOT NULL DEFAULT FALSE, -- 「難」バッジ付きの難問
  stem             TEXT NOT NULL,               -- 問題文
  choices          JSONB NOT NULL DEFAULT '[]'::jsonb, -- 選択肢配列（原順）。記述は []
  answer_no        INTEGER,                     -- 正解の位置（1始まり, choices内）。記述は NULL
  answer_text      TEXT,                        -- 正解の本文
  answer_alts      JSONB NOT NULL DEFAULT '[]'::jsonb, -- 記述の許容別表記
  image_path       TEXT,                        -- 図版（地図/写真）の保存キー。不要なら NULL
  explanation      TEXT,                        -- 本の原文解説
  explanation_note TEXT,                        -- 補足解説（後から追記）
  src_page         INTEGER,                     -- 出典PDFページ（突合用）
  created_at       TIMESTAMP DEFAULT NOW(),
  updated_at       TIMESTAMP DEFAULT NOW(),
  UNIQUE (chapter_id, q_no)
);
CREATE INDEX idx_exam_questions_subject ON exam_questions(subject_id);
CREATE INDEX idx_exam_questions_chapter ON exam_questions(chapter_id);

-- ── 4) 資格ごとのアクセス権（第2層） ──────────────────────────
--   行が存在する (staff_id, subject_id) の組のみ、その資格を学習できる。
--   付与は社員一覧画面から（または管理API）。グローバル管理者は全資格アクセス可とする。
CREATE TABLE exam_subject_access (
  id          BIGSERIAL PRIMARY KEY,
  staff_id    TEXT NOT NULL REFERENCES staff_master(id) ON DELETE CASCADE,
  subject_id  TEXT NOT NULL REFERENCES exam_subjects(id) ON DELETE CASCADE,
  created_at  TIMESTAMP DEFAULT NOW(),
  UNIQUE (staff_id, subject_id)
);
CREATE INDEX idx_exam_subject_access_staff ON exam_subject_access(staff_id);

-- ── 5) 学習記録（個人 × 設問） ────────────────────────────────
--   1設問につき1行（最新状態）。即採点のたびに upsert する。
--   - last_correct  : 直近の正誤
--   - attempts      : 挑戦回数 / correct_count: 正解回数
--   - last_answered : 最終回答日時（章の続きから再開・復習の判定に使用）
--   成績(章別/全体の正答率)・間違い復習・前回の続き・弱点抽出は、この表から導出する。
--   誤答率 = (attempts - correct_count) / attempts。「間違いやすい問題」モードで重み付けに使う。
CREATE TABLE exam_progress (
  id             BIGSERIAL PRIMARY KEY,
  staff_id       TEXT NOT NULL REFERENCES staff_master(id) ON DELETE CASCADE,
  question_id    BIGINT NOT NULL REFERENCES exam_questions(id) ON DELETE CASCADE,
  subject_id     TEXT NOT NULL REFERENCES exam_subjects(id) ON DELETE CASCADE,
  chapter_id     BIGINT NOT NULL REFERENCES exam_chapters(id) ON DELETE CASCADE,
  last_correct   BOOLEAN,
  attempts       INTEGER NOT NULL DEFAULT 0,
  correct_count  INTEGER NOT NULL DEFAULT 0,
  last_answered  TIMESTAMP,
  created_at     TIMESTAMP DEFAULT NOW(),
  updated_at     TIMESTAMP DEFAULT NOW(),
  UNIQUE (staff_id, question_id)
);
CREATE INDEX idx_exam_progress_staff_subject ON exam_progress(staff_id, subject_id);
CREATE INDEX idx_exam_progress_staff_chapter ON exam_progress(staff_id, chapter_id);

-- ── 6) 全回答の履歴（追記専用） ───────────────────────────────
--   1回答=1行で消さずに蓄積。exam_progress はこの集計（高速表示用）。
--   履歴を残すことで「直近の傾向」「誤答の偏り」など将来の分析に使える。
CREATE TABLE exam_answer_log (
  id           BIGSERIAL PRIMARY KEY,
  staff_id     TEXT NOT NULL REFERENCES staff_master(id) ON DELETE CASCADE,
  question_id  BIGINT NOT NULL REFERENCES exam_questions(id) ON DELETE CASCADE,
  subject_id   TEXT NOT NULL REFERENCES exam_subjects(id) ON DELETE CASCADE,
  chapter_id   BIGINT NOT NULL REFERENCES exam_chapters(id) ON DELETE CASCADE,
  is_correct   BOOLEAN NOT NULL,
  chosen_no    INTEGER,                          -- 選んだ選択肢の位置（原順 choices 内, 1始まり）
  answered_at  TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_exam_answer_log_staff_q ON exam_answer_log(staff_id, question_id);
CREATE INDEX idx_exam_answer_log_staff_subject ON exam_answer_log(staff_id, subject_id);
