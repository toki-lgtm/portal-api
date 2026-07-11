# migrations 適用台帳

このフォルダは、ポータル API（portal-api）の Supabase スキーマ変更（migration）を番号順に管理する。

## 運用方法

- **適用先**: 本番 Supabase（1環境のみ）。各 SQL は **Supabase SQL Editor に手動で貼り付けて実行**する。
- **記録**: 流したら必ず ①下の「適用状態一覧」を `✅ 適用済` にし、②SQL 末尾で `schema_migrations` に1行 INSERT する（下記）。記憶で管理しない。
- **DB側の台帳**: `schema_migrations` テーブル（migration 051 で新設）に適用済み版が全件記録されている。新しい SQL には必ず末尾に次を足す:
  ```sql
  INSERT INTO schema_migrations (version, applied_at, note)
  VALUES ('052_xxx', now(), '') ON CONFLICT (version) DO NOTHING;
  ```
- **冪等性**: 各 SQL は原則 `IF NOT EXISTS` / `ON CONFLICT` 等で**再実行しても壊れない**ように書く。
- **リネーム禁止**: 一度流した SQL ファイルは「実行済みの歴史」。過去ファイルの番号振り直しはしない（記録との対応が崩れるため）。

## 採番ルール（今後）

- **次の番号は `051` から**。
- **1 機能 = 1 番号**。複数機能を並行開発するときも、番号がぶつからないよう**着手時にこの台帳で最新番号を確認**してから採番する。
- 欠番（`043` `044` は未使用）は埋め戻さない。連番の見た目より、番号の一意性を優先する。

## 既知の採番の乱れ（歴史的経緯・DBは正常）

過去の並行開発で採番が衝突した。**DB 上はすべて正しく適用済みで無害**。記録のためだけに残す。

- `040` が 2 つ: `040_doboku_exam` / `040_inspection_checklist`
- `041` が 3 つ: `041_doboku_pq_review_flag` / `041_inspection_auto_sweep` / `041_workscope_monitoring`
- `043` `044`: 欠番（存在しない）
- `026` と `027`: `027` が `026` を作り直した（同じ `construction_boq` 系テーブル。実体は `027` が有効）

---

## 適用状態一覧

> 最終照合日: **2026-07-02**（本番 Supabase へ実データ問い合わせで全件確認）。全 51 ファイル・全機能が適用済み。

| # | ファイル | 内容 | 状態 |
|---|---|---|---|
| 001 | `001_init_schema` | 初期スキーマ（users / app_permissions / departments 等） | ✅ 適用済 |
| 002 | `002_seed_initial_data` | 初期データ投入 | ✅ 適用済 |
| 003 | `003_inspection_flow` | 安全パトロール 点検フロー（inspection_details） | ✅ 適用済 |
| 004 | `004_multi_photos` | 点検 複数写真対応（issue_image_urls 等） | ✅ 適用済 |
| 005 | `005_issue_templates` | 指摘テンプレート | ✅ 適用済 |
| 006 | `006_staff_roles` | staff_master.app_role（権限） | ✅ 適用済 |
| 007 | `007_user_settings` | 個人設定 | ✅ 適用済 |
| 008 | `008_employee_directory` | 社員一覧・権限・資格マスタ | ✅ 適用済 |
| 009 | `009_staff_company` | staff_master.company | ✅ 適用済 |
| 010 | `010_staff_address` | staff_master 住所（postal_code/address） | ✅ 適用済 |
| 011 | `011_qualification_cert_image` | 資格 証明書画像パス | ✅ 適用済 |
| 012 | `012_email_password` | staff_master.email_password | ✅ 適用済 |
| 013 | `013_shared_mailboxes` | 共有メールボックス | ✅ 適用済 |
| 014 | `014_announcements` | お知らせ・掲示板・回覧 | ✅ 適用済 |
| 015 | `015_bid_projects` | 入札案件管理 | ✅ 適用済 |
| 016 | `016_qualification_cert_meta` | 資格 発行元・本籍等メタ | ✅ 適用済 |
| 017 | `017_bid_period_remarks` | 入札 期間・備考 | ✅ 適用済 |
| 018 | `018_bid_amount` | 入札 金額 | ✅ 適用済 |
| 019 | `019_feedback` | バグ報告・改善要望 | ✅ 適用済 |
| 020 | `020_circular_documents` | 文書回覧 | ✅ 適用済 |
| 021 | `021_workscope_distribution` | WorkScope 配布・導入ログ | ✅ 適用済 |
| 022 | `022_workscope_consents` | WorkScope 同意 | ✅ 適用済 |
| 023 | `023_construction_management` | 工事管理（提出書類・検査） | ✅ 適用済 |
| 024 | `024_submission_files` | 提出ファイル | ✅ 適用済 |
| 025 | `025_submission_file_ai_meta` | 提出ファイル AI 分類メタ | ✅ 適用済 |
| 026 | `026_construction_boq` | 数量書（旧・027で作り直し） | ✅ 適用済 |
| 027 | `027_construction_boq_hierarchy` | 数量書 4階層化（有効版） | ✅ 適用済 |
| 028 | `028_construction_boq_ratios` | 数量書 構成比率（ratio_*） | ✅ 適用済 |
| 029 | `029_construction_design_changes` | 設計変更管理 | ✅ 適用済 |
| 030 | `030_regulations` | 法令集（凍結中） | ✅ 適用済 |
| 031 | `031_construction_boq_mode` | 設計変更 BOQモード | ✅ 適用済 |
| 032 | `032_app_usage` | アプリ使用頻度 | ✅ 適用済 |
| 033 | `033_business_cards` | 名刺管理 | ✅ 適用済 |
| 034 | `034_card_categories` | 名刺 カテゴリ | ✅ 適用済 |
| 035 | `035_card_personal_labels` | 名刺 個人ラベル | ✅ 適用済 |
| 036 | `036_estimate_comparison` | 見積比較 | ✅ 適用済 |
| 037 | `037_construction_photos` | 工事写真管理 | ✅ 適用済 |
| 038 | `038_photo_spec_master_seed` | 写真 撮影対象マスタ seed（639行） | ✅ 適用済 |
| 039 | `039_exam_prep` | 資格学習アプリ（1337問） | ✅ 適用済 |
| 040a | `040_doboku_exam` | 土木第二次検定アプリ | ✅ 適用済 |
| 040b | `040_inspection_checklist` | 検査書類チェックリスト（衝突: 040） | ✅ 適用済 |
| 041a | `041_doboku_pq_review_flag` | 土木 要復習フラグ（衝突: 041） | ✅ 適用済 |
| 041b | `041_inspection_auto_sweep` | 検査 自動棚卸し（衝突: 041） | ✅ 適用済 |
| 041c | `041_workscope_monitoring` | WorkScope 監視・遠隔操作（衝突: 041） | ✅ 適用済 |
| 042 | `042_inspection_swept_flag` | 検査 棚卸し済フラグ | ✅ 適用済 |
| — | (043 欠番) | — | — |
| — | (044 欠番) | — | — |
| 045 | `045_doc_classification_realign` | 書類分類 再編（folder_no 等） | ✅ 適用済 |
| 046 | `046_bid_docs_realign` | 入札書類 フォルダ補正（データ再編・冪等） | ✅ 適用済 |
| 047 | `047_construction_inspection_tests` | 受検・試験リスト | ✅ 適用済 |
| 048 | `048_photo_nodes_from_inspection_tests` | 写真ノード 試験連携 | ✅ 適用済 |
| 049 | `049_company_calendar` | 会社カレンダー（公休・計画有給） | ✅ 適用済 |
| 050 | `050_inspection_checklist_reseed` | 検査チェックリスト 再seed（データ・冪等） | ✅ 適用済 |
| 051 | `051_schema_migrations_ledger` | schema_migrations 記録テーブル新設＋既存遡及記録 | ✅ 適用済 |
| … | (052〜105 は schema_migrations テーブルが正。この表は 051 以降未追記) | — | — |
| 106 | `106_post_office_case_files` | 郵便局 案件添付ファイル＋提出書類チェックリスト | ⬜ 未適用（SQL Editorで実行） |
