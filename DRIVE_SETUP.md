# 資格者証ファイルを Google 共有ドライブに保存する設定手順

社内ポータルの**標準ストレージ方針**＝「重いファイル（資格者証など）は Google Workspace の共有ドライブ、構造化データは Supabase 無料枠」を実現するための設定です。

コードは実装済みで、**環境変数 `CERT_STORAGE=drive` を立てるまで従来どおり Supabase に保存されます**（本番は無影響）。下記を完了して切り替えてください。

---

## あなたが Google 側でやること

### ① Google Cloud プロジェクトと Drive API（5分）
1. https://console.cloud.google.com を toki@nakahara131.co.jp で開く
2. 上部のプロジェクト選択 →「新しいプロジェクト」（名前は `portal-drive` など。既存があれば流用可）
3. 検索窓で「Google Drive API」→ 開いて **「有効にする」**

### ② サービスアカウントと鍵JSON（5分）
1. 左メニュー「IAMと管理」→「サービスアカウント」→「サービスアカウントを作成」
2. 名前 `portal-api`（役割の付与は不要、スキップでOK）→ 作成
3. 作成したサービスアカウントを開く →「鍵」タブ →「鍵を追加」→「新しい鍵」→ **JSON** → ダウンロード
4. このサービスアカウントの**メールアドレス**（`portal-api@xxxx.iam.gserviceaccount.com` の形）をコピーしておく

### ③ 共有ドライブにサービスアカウントを招待（3分）
1. ブラウザの Google ドライブで **共有ドライブ「社内システム」** を開く
2. 右上「メンバーを管理」→ ②でコピーしたサービスアカウントのメールを追加 → 権限は **「投稿者（コンテンツ管理者）」**
   - ※「社内システム」は共有ドライブそのものなので、メンバー追加でフォルダ全体に権限が付きます
3. 保存先フォルダ **`社内システム\02.資格者証`** はこちらで作成済み。ブラウザで開いて使う。
4. その `02.資格者証` フォルダをブラウザで開き、URL の `…/folders/ここがID` の **ID 部分をコピー**（これが `DRIVE_FOLDER_ID`。必ず `02.資格者証` を指すこと）

> **フォルダ構成は自動**: `02.資格者証\会社名\社員名\` のサブフォルダは、資格者証を登録したときにシステムが自動作成します（社員台帳の会社・氏名と一致）。手動で作る必要はありません。

---

## Render（portal-api）の環境変数を設定して切替

Render ダッシュボード → portal-api → Environment に追加:

| キー | 値 |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | ②でダウンロードした JSON ファイルの**中身をそのまま全部**貼り付け |
| `DRIVE_FOLDER_ID` | ③でコピーしたフォルダID |
| `CERT_STORAGE` | `drive` |
| `PUBLIC_API_URL` | `https://portal-api-hhlx.onrender.com`（任意。未設定でも既定でこの値） |

保存すると Render が自動で再起動し、切替完了です。

---

## 切替後の挙動
- **新規の資格者証** → 共有ドライブ `02.資格者証\会社名\社員名\` に自動振り分け保存。DBには `drive:<fileID>` を記録。
- **表示** → API が署名付きの一時URL（`/api/cert-file?t=…`、既定1時間有効）を発行し、画面に表示。Google ログイン不要。
- **既存の Supabase 保存分** → そのまま表示できる（`drive:` が付かない参照は従来の Supabase 署名URLで配信）。
- **元に戻す** → `CERT_STORAGE` を消す（または `supabase`）だけで従来動作へ戻る。

## 既存ファイルの移行（`migrate_certs_to_drive.mjs`）
すでに Supabase バケット `qualification-certs` にある資格者証を共有ドライブへ移します。
DBの `cert_image_path` を `drive:<fileID>` に書き換えるだけで、Supabase の元ファイルは消さずに残します（バックアップ）。

**前提**: 上の①〜③（サービスアカウント・フォルダID）が済んでいること。

**実行手順**（このPCの portal-api フォルダで）:
1. `.env` に4つの値が入っているか確認（無ければ追記）:
   ```
   SUPABASE_URL=...
   SUPABASE_SERVICE_ROLE_KEY=...
   GOOGLE_SERVICE_ACCOUNT_JSON={...鍵JSONの中身全部...}
   DRIVE_FOLDER_ID=...
   ```
2. まず件数確認（何も変更しない）:
   ```
   node migrate_certs_to_drive.mjs --dry-run
   ```
3. 問題なければ本実行:
   ```
   node migrate_certs_to_drive.mjs
   ```
- 冪等なので途中で止めても再実行で続きから。`drive:` 済みは自動スキップ。
- 移行後、ポータルの社員一覧で資格者証が表示されることを確認したら、Supabase の元ファイルは不要なら手動削除でOK。

急がなければ移行せず併存のままでも問題ありません（新規はDrive・既存はSupabaseで両方表示できる）。
