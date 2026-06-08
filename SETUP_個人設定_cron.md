# 個人設定 & メール日次ダイジェスト セットアップ手順

**作成日**: 2026-06-08
**対象**: 社内ポータル API（portal-api / Render）

ユーザーごとに「アプリ表示設定」「通知設定」を保存する **個人設定API** と、
指定した時間帯にポータルの未処理タスクをメールでお知らせする
**日次ダイジェスト cron** を追加しました。

---

## あなたの作業（3ステップ）

### ① Supabase に user_settings テーブルを作成（SQL実行）

Supabase 管理画面 → **SQL Editor** で、以下を実行してください。
（ファイル: `migrations/007_user_settings.sql` と同内容）

```sql
CREATE TABLE IF NOT EXISTS user_settings (
  user_email text PRIMARY KEY,
  settings   jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

**確認方法**: Table Editor に `user_settings` が表示されれば OK です。

---

### ② Render（portal-api）のメール環境変数を確認

日次ダイジェスト cron は既存のメール設定をそのまま使います。
まだ設定していない場合は、Render のダッシュボード → **portal-api** サービス →
**Environment** に以下を追加してください。

| キー | 値 |
|---|---|
| `SUPABASE_URL` | Supabase プロジェクトの URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase の service_role キー |
| `SMTP_HOST` | `nakahara131.co.jp` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | `system_noreply@nakahara131.co.jp` |
| `SMTP_PASS` | system_noreply アカウントのパスワード |
| `MAIL_FROM` | `system_noreply@nakahara131.co.jp` |
| `MAIL_FROM_NAME` | `中原建設社内システム` |

> SMTP 関連はすでにメール送信機能でセットアップ済みであれば、追加作業は不要です。

---

### ③ Render に Cron Job を追加

Render のダッシュボード → **New +** → **Cron Job** を選択して以下を設定します。

| 項目 | 値 |
|---|---|
| **Name** | portal-email-digest（任意の名前） |
| **Repository** | portal-api と同じリポジトリを選択 |
| **Branch** | main |
| **Build Command** | `npm install` |
| **Command** | `node cron/emailDigest.js` |
| **Schedule** | `0 * * * *`（毎時0分に実行） |
| **Region** | portal-api と同じリージョン |

**Environment Variables** タブで、上記 ② と同じ環境変数を設定してください。
（Render の Cron Job は Web サービスとは別の実行環境のため、個別に設定が必要です）

> スケジュールの `0 * * * *` は「毎時0分」という意味です。
> 例: `0 8 * * *` にすると「毎日8時0分」になります。
> ただし **Render の時刻は UTC** のため、JST の何時に実行するかは
> スクリプト内部でユーザー設定（email_hour）と照合します。
> 「毎時0分」のスケジュールで動かし、スクリプト内でメール送信対象を絞る設計になっています。

---

## 動作確認

1. Supabase SQL Editor でマイグレーションを実行する（上記①）
2. Render に Cron Job を追加してデプロイする（上記③）
3. portal-api の再デプロイ後、フロントエンドから以下の API を試す

```
GET /api/user/settings
Authorization: Bearer <JWTトークン>
→ デフォルト設定が返ってくれば OK
```

```
PUT /api/user/settings
Authorization: Bearer <JWTトークン>
Content-Type: application/json

{
  "notifications": {
    "email_enabled": true,
    "email_hour": 8,
    "email_weekdays": [1, 2, 3, 4, 5]
  }
}
→ 保存された設定が返ってくれば OK
```

---

## API 仕様まとめ

### GET /api/user/settings

| 項目 | 内容 |
|---|---|
| 認証 | Bearer トークン必須 |
| 返り値 | 個人設定オブジェクト（後述の構造） |
| 未設定時 | デフォルト値をそのまま返す |

### PUT /api/user/settings

| 項目 | 内容 |
|---|---|
| 認証 | Bearer トークン必須 |
| リクエスト body | 設定オブジェクト（部分更新可） |
| 返り値 | 保存後のマージ済み設定オブジェクト |

**設定オブジェクトの構造**:

```json
{
  "apps": {
    "pinned": [],
    "favorites": [],
    "order": [],
    "show_kpi": true
  },
  "notifications": {
    "in_app_enabled": true,
    "email_enabled": false,
    "email_weekdays": [1, 2, 3, 4, 5],
    "email_hour": 8
  }
}
```

- `email_weekdays`: 0=日、1=月、2=火、3=水、4=木、5=金、6=土
- `email_hour`: メール送信する時刻（6〜20 の整数。範囲外は無視されます）

---

## cron の動作ロジック

1. 実行時刻を JST に変換して曜日・時刻を確認
2. `user_settings` テーブルから `email_enabled = true` のユーザーを取得
3. `email_weekdays` に今日の曜日が含まれ、かつ `email_hour` が現在の時刻と一致するユーザーを抽出
4. 承認待ち件数と是正対応中件数を集計
5. 両方0件の場合は送信をスキップ
6. 対象ユーザーへメールを1通送信

---

## トラブルシュート

| 症状 | 確認ポイント |
|---|---|
| メールが届かない | Cron Job の Environment Variables に SMTP 設定があるか確認。Render の Cron Job ログを確認。 |
| 「SMTP_HOST未設定」エラー | Cron Job の環境変数が Web サービスと別管理になっているため、Cron Job 側にも設定が必要です。 |
| テーブルが見つからないエラー | ① の SQL をまだ実行していない場合は実行してください。 |
| 設定が保存されない | portal-api が最新コードでデプロイされているか確認してください。 |

---

## 変更ファイル一覧

| ファイル | 種別 | 内容 |
|---|---|---|
| `migrations/007_user_settings.sql` | 新規 | user_settings テーブル作成 |
| `server.js` | 変更 | GET/PUT /api/user/settings 追加 |
| `cron/emailDigest.js` | 新規 | メール日次ダイジェスト送信スクリプト |
| `SETUP_個人設定_cron.md` | 新規 | このファイル |
