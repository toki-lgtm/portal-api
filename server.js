import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { randomUUID as uuidv4 } from 'crypto';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import nodemailer from 'nodemailer';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import sharp from 'sharp';
import { parseEstimateFromXlsx } from './bidEstimate.js';
import { parseBoqFromXlsx, CANONICAL_TRADES } from './boqParser.js';
import { driveUpload, driveDownload, driveThumbnail, driveTrash, driveConfigured, ensureFolderPath, driveListChildren } from './googleDrive.js';
import { classifyQuote, classNoOf } from './classifyQuote.js';

dotenv.config();

// ✅ multer: 写真アップロード用（メモリストレージ）
const upload = multer({ storage: multer.memoryStorage() });

// 共有ドライブ「社内システム」のルート（＝各機能の保存先の基点）。
//   資格者証(DRIVE_FOLDER_ID=02.資格者証)以外の機能は、このルート直下に
//   「<機能名>\…」で格納する（root\見積比較 / root\工事管理 / root\入札案件 / root\名刺 …）。
//   こうすることで全機能が 02.資格者証 配下に潜らず 社内システム 直下に整列する。
//   既定値は共有ドライブのルートID（文書回覧の CIRCULAR_DRIVE_FOLDER_ID と同一）。
const SHARED_DRIVE_ROOT_ID = process.env.SHARED_DRIVE_ROOT_ID || '0AK5TgtO_Sr4RUk9PVA';

// multer/busboy は日本語ファイル名を latin1 として解釈し文字化けする。
// 元の UTF-8 へ復元する（既に日本語が含まれる場合は変換不要としてそのまま返す）。
function decodeUploadName(name) {
  if (!name) return name;
  if (/[぀-ゟ゠-ヿ一-鿿]/.test(name)) return name; // 既に正しくデコード済み
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch {
    return name;
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// 認証設定
const JWT_SECRET = process.env.JWT_SECRET;
const ALLOWED_EMAIL_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN || 'nakahara131.co.jp';
const JWT_EXPIRES_IN = '12h';

// ✅ 安全パトロール権限: 環境変数で常に管理者扱いにするメール（カンマ区切り）。DB未登録でも管理者化できる安全網。
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'toki@nakahara131.co.jp')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

if (!JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET が未設定です。ログイン（JWT発行/検証）は失敗します。Render の環境変数に JWT_SECRET を設定してください。');
}

// CORS: ALLOWED_ORIGINS（カンマ区切り）が設定されていれば限定、未設定なら全許可（現状維持・後で締める）
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

if (allowedOrigins.length === 0) {
  console.warn('⚠️  ALLOWED_ORIGINS が未設定のため全オリジンを許可しています。本番では Vercel のURL等を設定してください。');
}

app.use(
  cors(
    allowedOrigins.length === 0
      ? {}
      : {
          origin: (origin, callback) => {
            // サーバー間呼び出し等 origin 無しは許可
            if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
            callback(new Error(`CORS: origin not allowed (${origin})`));
          },
        }
  )
);
app.use(express.json());

// ✅ 認可ミドルウェア: Authorization: Bearer <JWT> を検証し req.user に格納
function requireAuth(req, res, next) {
  if (!JWT_SECRET) {
    return res.status(500).json({ error: 'Server auth not configured (JWT_SECRET missing)' });
  }
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Authorization required' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // ドメイン再チェック（多層防御）
    if (ALLOWED_EMAIL_DOMAIN && !String(payload.email || '').toLowerCase().endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)) {
      return res.status(403).json({ error: 'Forbidden domain' });
    }
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Supabase クライアント（サービスロールキーを使用）
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
  { global: { headers: { 'x-client-info': 'portal-api' } }, realtime: { transport: ws } }
);

// ✅ メール送信（SMTP）設定。環境変数から遅延初期化し、未設定ならサーバー起動は妨げず送信時にエラーを返す。
//    自社メール（bizmw / nakahara131.co.jp, port587, 暗号化なし, SMTP認証あり）を想定。
const MAIL_FROM = process.env.MAIL_FROM || 'system_noreply@nakahara131.co.jp';
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || '中原建設社内システム';
let mailTransporter = null;
function getMailTransporter() {
  if (mailTransporter) return mailTransporter;
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    throw new Error('メール送信が未設定です（環境変数 SMTP_HOST / SMTP_USER / SMTP_PASS を設定してください）');
  }
  mailTransporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // 465は暗黙SSL。587はSTARTTLS（対応時のみ日和見的に使用）
    auth: { user, pass },
    requireTLS: false,                 // サーバー設定が「暗号化なし」のためTLSを必須にしない
    tls: { rejectUnauthorized: false } // 暗号化なし／自己署名環境でも送信を通す
  });
  return mailTransporter;
}

// ✅ マスタIDを既存の連番に従って自動採番（例: P001 → P010, S008, M049）
async function nextMasterId(table, prefix) {
  const { data, error } = await supabase.from(table).select('id');
  if (error) throw error;
  let max = 0;
  for (const row of (data || [])) {
    const m = String(row.id || '').match(new RegExp('^' + prefix + '(\\d+)$'));
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return prefix + String(max + 1).padStart(3, '0');
}

// ✅ ログインユーザーの権限と検査官IDを解決
//    - role: 'admin'（管理者：全機能） / 'member'（メンバー：閲覧・新規点検）
//    - staffId: staff_master を email で突合した本人のスタッフID（未登録なら null）
//    判定: 環境変数 ADMIN_EMAILS に含まれる、または staff_master.app_role='admin' なら管理者。
async function resolvePermissions(email) {
  const lower = String(email || '').toLowerCase();
  let staffId = null;
  let dbRole = null;
  try {
    const { data } = await supabase
      .from('staff_master')
      .select('id, app_role')
      .ilike('email', lower)
      .maybeSingle();
    if (data) {
      staffId = data.id;
      dbRole = data.app_role;
    }
  } catch (e) {
    console.error('resolvePermissions 失敗:', e.message);
  }
  const role = ADMIN_EMAILS.includes(lower) || dbRole === 'admin' ? 'admin' : 'member';
  return { role, staffId };
}

// ✅ 管理者のみ許可するミドルウェア（要 requireAuth 後段）
async function requireAdmin(req, res, next) {
  try {
    const perms = await resolvePermissions(req.user?.email);
    if (perms.role !== 'admin') {
      return res.status(403).json({ error: 'この操作は管理者のみ可能です' });
    }
    req.perms = perms;
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ✅ 安全パトロールのアプリ内ロール（admin / member / none）
//    権限は staff_app_permissions['safety-patrol'] に一本化（ポータル社員一覧と共通の付与先）。
//    - グローバル管理者（ADMIN_EMAILS / staff_master.app_role='admin'）は常に admin
//    - それ以外は staff_app_permissions['safety-patrol'] の access_level を見る
//      （admin / member）。行が無ければ none（＝アプリ利用権限なし）。
async function resolveSafetyPatrolRole(email) {
  const perms = await resolvePermissions(email); // { role, staffId } グローバル
  if (perms.role === 'admin') return { role: 'admin', staffId: perms.staffId };
  let level = null;
  if (perms.staffId) {
    const { data } = await supabase
      .from('staff_app_permissions')
      .select('access_level')
      .eq('staff_id', perms.staffId)
      .eq('app_key', 'safety-patrol')
      .maybeSingle();
    level = data?.access_level || null;
  }
  const role = level === 'admin' ? 'admin' : level ? 'member' : 'none';
  return { role, staffId: perms.staffId };
}

// ✅ 安全パトロールの管理者のみ許可するミドルウェア（要 requireAuth 後段）
async function requireSafetyPatrolAdmin(req, res, next) {
  try {
    const r = await resolveSafetyPatrolRole(req.user?.email);
    if (r.role !== 'admin') {
      return res.status(403).json({ error: 'この操作は安全パトロールの管理者のみ可能です' });
    }
    req.spRole = r;
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ✅ 指摘内容テンプレートの蓄積
//    点検保存時に「指摘あり」かつ指摘内容ありの明細を項目単位でストックする。
//    既存（同一 item_id × 同一 content）があれば use_count を加算、無ければ新規登録。
//    テンプレ保存に失敗しても点検保存自体は妨げないよう、エラーは握りつぶす。
async function recordIssueTemplates(details) {
  if (!Array.isArray(details)) return;
  // 同一保存内の重複を除外（item_id|content をキーに）
  const seen = new Map();
  for (const d of details) {
    if (!d || d.result !== '指摘あり') continue;
    const content = (d.issue_content || '').trim();
    if (!content || !d.item_id) continue;
    seen.set(`${d.item_id}|${content}`, { item_id: d.item_id, content });
  }
  for (const { item_id, content } of seen.values()) {
    try {
      const { data: existing } = await supabase
        .from('issue_templates')
        .select('id, use_count')
        .eq('item_id', item_id)
        .eq('content', content)
        .maybeSingle();

      if (existing) {
        await supabase
          .from('issue_templates')
          .update({ use_count: (existing.use_count || 0) + 1, updated_at: new Date().toISOString() })
          .eq('id', existing.id);
      } else {
        await supabase
          .from('issue_templates')
          .insert([{ id: uuidv4(), item_id, content }]);
      }
    } catch (e) {
      console.error('issue_templates 記録に失敗（無視）:', e.message);
    }
  }
}

// ✅ ヘルスチェック
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// ✅ ユーザー情報取得（要認証）
app.get('/api/user', requireAuth, (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    name: req.user.name,
    avatar: req.user.avatar
  });
});

// ✅ 安全パトロール - ログインユーザーの権限（フロントのボタン表示制御に使用）
app.get('/api/my-permissions', requireAuth, async (req, res) => {
  try {
    const perms = await resolvePermissions(req.user.email);
    const appPerms = await resolveAppPermissions(perms.staffId);
    const spRole = await resolveSafetyPatrolRole(req.user.email);
    res.json({
      role: perms.role,        // 'admin' | 'member'（グローバルロール。ポータル全体の管理者判定に使用）
      safety_patrol_role: spRole.role, // 安全パトロールのアプリ内ロール（admin|member|none）
      staff_id: perms.staffId, // 本人のスタッフID（未登録なら null）
      email: req.user.email,
      name: req.user.name,
      apps: appPerms,          // { app_key: 'member'|'admin' } アプリ別権限マップ
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ Google OAuth コールバック
app.post('/api/auth/google', async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'Token required' });
  }

  try {
    // Google トークンからユーザー情報を取得
    const googleRes = await fetch('https://www.googleapis.com/oauth2/v1/userinfo', {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!googleRes.ok) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const userInfo = await googleRes.json();

    // ✅ 会社ドメイン制限: 許可ドメイン以外のアカウントは拒否
    const email = String(userInfo.email || '').toLowerCase();
    if (ALLOWED_EMAIL_DOMAIN && !email.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)) {
      return res.status(403).json({ error: `このポータルは ${ALLOWED_EMAIL_DOMAIN} のアカウントのみ利用できます` });
    }

    if (!JWT_SECRET) {
      return res.status(500).json({ error: 'Server auth not configured (JWT_SECRET missing)' });
    }

    const user = {
      id: userInfo.id,
      email: userInfo.email,
      name: userInfo.name,
      avatar: userInfo.picture
    };

    // ✅ サーバー側で自前のJWTを発行（以降のAPIはこれで認可）
    const appToken = jwt.sign(user, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    res.json({ ...user, token: appToken });
  } catch (error) {
    console.error('Auth error:', error.message, error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ ダッシュボード用：アプリ一覧（要認証）
app.get('/api/apps', requireAuth, async (req, res) => {
  try {
    const isDev = process.env.NODE_ENV !== 'production';
    const baseUrl = isDev
      ? 'http://localhost:5174'
      : 'https://safety-patrol-nine.vercel.app';

    // 認証済みユーザー情報を安全パトロールへ受け渡し
    // user パラメータは表示用。認可は署名付きJWT(token)で行う（改ざん不可）
    const appToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const userJson = encodeURIComponent(JSON.stringify({
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      avatar: req.user.avatar
    }));
    const safetyPatrolUrl = `${baseUrl}?user=${userJson}&token=${encodeURIComponent(appToken)}`;

    // アプリ定義（key を持つものは app_permissions による権限フィルタ対象）
    // internal:true は外部URLではなくポータル内ビュー（フロントが view 切替で表示）
    const allApps = [
      { id: 1, key: 'safety-patrol', name: '安全パトロール', url: safetyPatrolUrl, icon: '✅' },
      { id: 2, key: 'employee-list', name: '社員一覧', icon: '👤', internal: true, view: 'employees' },
      { id: 7, key: 'announcements', name: 'お知らせ', icon: '📣', internal: true, view: 'announcements' },
      { id: 8, key: 'bids', name: '入札案件管理', icon: '📋', internal: true, view: 'bids', description: '入札案件の進捗・期限・金額・資料を管理' },
      { id: 9, key: 'feedback', name: 'バグ報告・改善 一覧', icon: '🐞', internal: true, view: 'feedback', description: '寄せられた不具合・改善要望の確認とトリアージ' },
      { id: 10, key: 'documents', name: '文書回覧', icon: '🗂️', internal: true, view: 'documents', description: '回覧書類の電子化・既読/対応管理' },
      { id: 11, key: 'workscope', name: 'WorkScope 導入', icon: '🖥️', internal: true, view: 'workscope', description: '業務記録ツールの導入（インストーラーのダウンロード）' },
      { id: 12, key: 'construction', name: '工事管理', icon: '🏗️', internal: true, view: 'construction', description: '工事の提出書類・検査書類の進捗を管理（九州防衛局 建築工事）' },
      { id: 14, key: 'cards', name: '名刺管理', icon: '📇', internal: true, view: 'cards', description: '受け取った名刺をOCRで登録・全社で検索' },
      { id: 15, key: 'manual', name: '操作マニュアル', icon: '📖', internal: true, view: 'manual', description: 'ポータルと各アプリの使い方ガイド' },
      { id: 16, key: 'quote_compare', name: '見積比較', icon: '💰', internal: true, view: 'quote-compare', description: '相見積の単価を横並び比較し最安見積を作成（築城方式）' },
      // 【凍結 2026-06-17】法令集はメニューから除外（機能・API・データは残置、復活時はこの行を戻す）
      // { id: 13, key: 'regulations', name: '法令集', icon: '📚', internal: true, view: 'regulations', description: '建設・不動産・林業・労務・会社経営の法令を条文単位で検索・閲覧' },
    ];

    // 権限フィルタ: グローバル管理者は全件。それ以外は app_permissions に行があるアプリのみ。
    // coming_soon（プレースホルダ）は誰にでも表示する。
    const perms = await resolvePermissions(req.user.email);
    const appPerms = await resolveAppPermissions(perms.staffId);
    const fbRole = await resolveFeedbackRole(req.user.email);
    const apps = allApps.filter((a) => {
      if (a.status === 'coming_soon') return true;
      // バグ報告・改善の「一覧」はフィードバック管理者のみに表示する。
      // 投稿自体は全社員が画面右下の常駐ボタンからいつでも可能（このカードとは別導線）。
      if (a.key === 'feedback') return fbRole.role === 'admin';
      // WorkScope 導入は全社員に配布したいので常に表示する（管理用UIは画面内で admin のみ表示）。
      if (a.key === 'workscope') return true;
      // 操作マニュアルは全社員に常に表示する（読み取り専用の使い方ガイド）。
      if (a.key === 'manual') return true;
      if (perms.role === 'admin') return true;
      return !!appPerms[a.key];
    });

    // このアカウントの使用頻度を各アプリに付与（フロントが頻度順の並び替えに使用）。
    // app_usage 未作成（migration 032 未適用）でも例外で落とさず、使用回数 0 として返す。
    const email = String(req.user.email || '').toLowerCase();
    const usage = {};
    try {
      const { data: usageRows } = await supabase
        .from('app_usage')
        .select('app_key, use_count, last_used_at')
        .eq('user_email', email);
      for (const r of usageRows || []) {
        usage[r.app_key] = { use_count: r.use_count || 0, last_used_at: r.last_used_at || null };
      }
    } catch (e) {
      console.error('Warning (app_usage fetch):', e.message);
    }
    const appsWithUsage = apps.map((a) => ({
      ...a,
      use_count: usage[a.key]?.use_count || 0,
      last_used_at: usage[a.key]?.last_used_at || null,
    }));
    res.json(appsWithUsage);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ アプリを開いたことを記録（使用頻度カウント）。要認証。
//    body: { key } … /api/apps が返す app_key。
//    (user_email, app_key) で upsert し use_count を加算、last_used_at を更新する。
//    並び替えの補助情報なので、失敗しても致命的ではない（フロントは結果を待たず発火する）。
app.post('/api/apps/usage', requireAuth, async (req, res) => {
  try {
    const email = String(req.user.email || '').toLowerCase();
    const key = String(req.body?.key || '').trim();
    if (!key) return res.status(400).json({ error: 'key is required' });

    // 既存行があれば use_count を +1、なければ 1 で新規。
    const { data: existing, error: selErr } = await supabase
      .from('app_usage')
      .select('use_count')
      .eq('user_email', email)
      .eq('app_key', key)
      .maybeSingle();
    if (selErr) throw selErr;

    const nextCount = (existing?.use_count || 0) + 1;
    const { error: upErr } = await supabase
      .from('app_usage')
      .upsert(
        { user_email: email, app_key: key, use_count: nextCount, last_used_at: new Date().toISOString() },
        { onConflict: 'user_email,app_key' }
      );
    if (upErr) throw upErr;

    res.json({ ok: true, key, use_count: nextCount });
  } catch (error) {
    console.error('Error (app usage POST):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ ポータルTOP用：安全パトロールの状況サマリ（KPIカード＋最近の活動）
//    既存の inspections / inspection_details / projects を集計して返す。読み取り専用・要認証。
//    KPI: 今月の点検数 / 完了率(承認済の指摘÷全指摘) / 是正対応中(未承認の指摘) / 承認待ち(submitted)
app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
  try {
    // 現在の年月（JST基準。Render は UTC のため +9h して算出）
    const jstNow = new Date(Date.now() + 9 * 3600 * 1000);
    const ym = jstNow.toISOString().slice(0, 7); // 'YYYY-MM'

    // 点検（最近の活動用に作成日時降順で取得）
    const { data: inspRows, error: inspErr } = await supabase
      .from('inspections')
      .select('id, inspection_id, project_id, inspection_date, status, created_at')
      .order('created_at', { ascending: false });
    if (inspErr) throw inspErr;
    const inspections = inspRows || [];

    // 指摘明細（是正状態の集計用）
    const { data: detRows, error: detErr } = await supabase
      .from('inspection_details')
      .select('inspection_id, correction_status')
      .eq('result', '指摘あり');
    if (detErr) throw detErr;
    const details = detRows || [];

    // 現場名マップ
    const { data: projRows } = await supabase.from('projects').select('id, name');
    const projectName = {};
    for (const p of projRows || []) projectName[p.id] = p.name;

    // 今月の点検数
    const inspectionsThisMonth = inspections.filter(
      (i) => String(i.inspection_date || '').slice(0, 7) === ym
    ).length;

    // 是正状態の集計
    let issuesTotal = 0;
    let approved = 0;
    let submitted = 0; // 承認待ち
    const openByInsp = {}; // 点検ごとの未承認指摘数（最近の活動用）
    for (const d of details) {
      issuesTotal++;
      const cs = d.correction_status || 'pending';
      if (cs === 'approved') approved++;
      else {
        if (cs === 'submitted') submitted++;
        openByInsp[d.inspection_id] = (openByInsp[d.inspection_id] || 0) + 1;
      }
    }
    const issuesByInsp = {};
    for (const d of details) {
      issuesByInsp[d.inspection_id] = (issuesByInsp[d.inspection_id] || 0) + 1;
    }
    const issuesOpen = issuesTotal - approved; // 是正対応中（未承認）
    const completionRate = issuesTotal > 0 ? Math.round((approved / issuesTotal) * 1000) / 10 : null;

    // 最近の活動（直近5件の点検）
    const recent = inspections.slice(0, 5).map((i) => ({
      id: i.id,
      inspection_id: i.inspection_id,
      project_name: projectName[i.project_id] || i.project_id || '現場',
      inspection_date: i.inspection_date,
      status: i.status || 'pending',
      issues: issuesByInsp[i.id] || 0,
      open_issues: openByInsp[i.id] || 0,
      created_at: i.created_at,
    }));

    res.json({
      month: ym,
      inspections_this_month: inspectionsThisMonth,
      inspections_total: inspections.length,
      issues_total: issuesTotal,
      issues_open: issuesOpen,
      awaiting_approval: submitted,
      completion_rate: completionRate, // 全指摘に対する承認済割合(%)。指摘0件なら null
      recent,
    });
  } catch (error) {
    console.error('Error (dashboard stats):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 以降の共有データAPIは全て認証必須（安全パトロールもBearerトークンを送る）
app.use('/api/inspections', requireAuth);
app.use('/api/masters', requireAuth);

// ✅ マスター管理は閲覧(GET)は全員可、登録/編集/削除は安全パトロールの管理者のみ
app.use('/api/masters', async (req, res, next) => {
  if (req.method === 'GET') return next();
  return requireSafetyPatrolAdmin(req, res, next);
});

// ✅ 安全パトロール - 点検一覧（各点検に指摘是正サマリ correction を付与）
app.get('/api/inspections', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('inspections')
      .select('*')
      .order('inspection_date', { ascending: false });

    if (error) throw error;
    const inspections = data || [];

    // 指摘あり項目の是正状態を点検ごとに集計（一覧のステータス表示に使用）
    const summaryByInsp = {};
    if (inspections.length) {
      const ids = inspections.map((i) => i.id);
      const { data: dets, error: detErr } = await supabase
        .from('inspection_details')
        .select('inspection_id, correction_status')
        .in('inspection_id', ids)
        .eq('result', '指摘あり');
      if (detErr) throw detErr;
      for (const d of dets || []) {
        const s =
          summaryByInsp[d.inspection_id] ||
          (summaryByInsp[d.inspection_id] = { issues: 0, pending: 0, submitted: 0, approved: 0, rejected: 0 });
        s.issues++;
        const cs = d.correction_status || 'pending';
        if (s[cs] === undefined) s[cs] = 0;
        s[cs]++;
      }
    }

    const withSummary = inspections.map((i) => ({
      ...i,
      correction: summaryByInsp[i.id] || { issues: 0, pending: 0, submitted: 0, approved: 0, rejected: 0 }
    }));
    res.json(withSummary);
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 安全パトロール - 自分に関係する是正項目の横断一覧（固定パスのため :id ルートより前に定義）
//    admin=全件 / それ以外=自分が作業所長 or 検査官の点検の指摘項目のみ。
app.get('/api/inspections/corrections', async (req, res) => {
  try {
    const perms = await resolvePermissions(req.user.email);
    const { data, error } = await supabase
      .from('inspection_details')
      .select('*, inspections!inner(id, inspection_id, inspection_date, project_id, inspector_id, manager_id, status)')
      .eq('result', '指摘あり')
      .order('created_at', { ascending: false });
    if (error) throw error;
    let rows = data || [];
    if (perms.role !== 'admin') {
      const me = perms.staffId;
      rows = rows.filter(
        (r) => r.inspections && (r.inspections.manager_id === me || r.inspections.inspector_id === me)
      );
    }
    res.json(rows);
  } catch (error) {
    console.error('Error (corrections):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 安全パトロール - 点検作成（details 一括 insert 対応）
app.post('/api/inspections', async (req, res) => {
  try {
    const {
      inspection_id,
      project_id,
      inspector_id,
      manager_id,
      inspection_date,
      categories,
      status,
      comments,
      report_url,
      site_photo_urls,
      details
    } = req.body;

    // inspection_id 省略時は 'INS-YYYYMMDD-XXXX' 形式で自動生成
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const suffix = Math.random().toString(36).toUpperCase().slice(2, 6);
    const resolvedInspectionId = inspection_id || `INS-${dateStr}-${suffix}`;

    const newId = uuidv4();

    // ✅ メンバーは検査官を自分に固定（自分が検査した案件のみ後で編集/PDF発行できるようにするため）。
    //    管理者は指定どおり。staff未登録のメンバーは送信値を尊重（管理者がstaff整備する想定）。
    const perms = await resolvePermissions(req.user.email);
    const resolvedInspectorId =
      perms.role !== 'admin' && perms.staffId ? perms.staffId : inspector_id;

    const { data: inspectionData, error: inspectionError } = await supabase
      .from('inspections')
      .insert([{
        id: newId,
        inspection_id: resolvedInspectionId,
        project_id,
        inspector_id: resolvedInspectorId,
        manager_id,
        inspection_date,
        categories: categories || [],
        status: status || 'pending',
        comments,
        report_url,
        site_photo_urls: site_photo_urls || []
      }])
      .select();

    if (inspectionError) throw inspectionError;

    const inspection = inspectionData[0];

    // ✅ details がある場合は inspection_details に一括 insert
    if (details && details.length > 0) {
      const detailRows = details.map((d) => ({
        id: uuidv4(),
        inspection_id: newId,
        item_id: d.item_id,
        category: d.category,
        description: d.description,
        result: d.result,
        issue_content: d.issue_content || null,
        issue_image_url: d.issue_image_url || null,
        issue_image_urls: d.issue_image_urls || [],
        due_date: d.due_date || null,
        correction_status: d.result === '指摘あり' ? 'pending' : null
      }));

      const { data: detailData, error: detailError } = await supabase
        .from('inspection_details')
        .insert(detailRows)
        .select();

      if (detailError) {
        // ✅ details insert 失敗時はロールバック相当：作成した inspection を削除して 500 を返す
        console.error('details insert error（rollback）:', detailError.message);
        await supabase.from('inspections').delete().eq('id', newId);
        return res.status(500).json({ error: `inspection_details の保存に失敗しました: ${detailError.message}` });
      }

      // ✅ 指摘内容をテンプレートとして蓄積（失敗しても点検保存は成功扱い）
      await recordIssueTemplates(details);

      return res.json({ ...inspection, inspection_details: detailData || [] });
    }

    res.json({ ...inspection, inspection_details: [] });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 安全パトロール - 写真アップロード（Supabase Storage: inspection-photos バケット）
// ※ このルートは固定パスのため :id より前に定義する
app.post('/api/inspections/upload-photo', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'photo フィールドが必要です' });
    }

    const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase();
    const path = `${Date.now()}-${uuidv4()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('inspection-photos')
      .upload(path, req.file.buffer, { contentType: req.file.mimetype });

    if (uploadError) throw uploadError;

    const { data: urlData } = supabase.storage
      .from('inspection-photos')
      .getPublicUrl(path);

    res.json({ url: urlData.publicUrl });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 安全パトロール - 点検詳細取得（inspection_details を結合）
app.get('/api/inspections/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('inspections')
      .select('*, inspection_details(*)')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: '点検が見つかりません' });
      }
      throw error;
    }

    res.json(data);
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 安全パトロール - 点検更新（details がある場合は全削除→再 insert で置き換え）
app.put('/api/inspections/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, comments, report_url, categories, site_photo_urls, details } = req.body;

    // ✅ PDF生成済みの点検は編集不可（ロック）。report_url が立っていれば生成済みとみなす。
    const { data: existing, error: existingError } = await supabase
      .from('inspections')
      .select('report_url, inspector_id')
      .eq('id', id)
      .single();
    if (existingError) throw existingError;

    // ✅ 編集権限: 管理者は全件、メンバーは自分が検査官の案件のみ
    const perms = await resolvePermissions(req.user.email);
    if (perms.role !== 'admin' && existing.inspector_id !== perms.staffId) {
      return res.status(403).json({ error: '自分が検査した案件のみ編集できます' });
    }

    if (existing && existing.report_url) {
      return res.status(409).json({ error: 'この点検はPDF生成済みのため編集できません' });
    }

    const { data: inspectionData, error: inspectionError } = await supabase
      .from('inspections')
      .update({
        status,
        comments,
        report_url,
        categories,
        site_photo_urls,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select();

    if (inspectionError) throw inspectionError;

    const inspection = inspectionData[0];

    // ✅ details がある場合は既存の inspection_details を全削除→再 insert
    if (details && details.length > 0) {
      const { error: deleteError } = await supabase
        .from('inspection_details')
        .delete()
        .eq('inspection_id', id);

      if (deleteError) throw deleteError;

      const detailRows = details.map((d) => ({
        id: uuidv4(),
        inspection_id: id,
        item_id: d.item_id,
        category: d.category,
        description: d.description,
        result: d.result,
        issue_content: d.issue_content || null,
        issue_image_url: d.issue_image_url || null,
        issue_image_urls: d.issue_image_urls || [],
        due_date: d.due_date || null,
        correction_status: d.result === '指摘あり' ? 'pending' : null
      }));

      const { data: detailData, error: detailError } = await supabase
        .from('inspection_details')
        .insert(detailRows)
        .select();

      if (detailError) throw detailError;

      // ✅ 指摘内容をテンプレートとして蓄積（失敗しても点検保存は成功扱い）
      await recordIssueTemplates(details);

      return res.json({ ...inspection, inspection_details: detailData || [] });
    }

    res.json(inspection);
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 非公開バケット inspection-reports を必要時に作成（アプリ越しのみ参照可能にする）
const REPORTS_BUCKET = 'inspection-reports';
let reportsBucketEnsured = false;
async function ensureReportsBucket() {
  if (reportsBucketEnsured) return;
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw error;
  if (!buckets?.some((b) => b.name === REPORTS_BUCKET)) {
    const { error: createError } = await supabase.storage.createBucket(REPORTS_BUCKET, { public: false });
    // 競合（既に存在）以外は致命的
    if (createError && !/already exists/i.test(createError.message || '')) throw createError;
  }
  reportsBucketEnsured = true;
}

// 安全なファイル名片を作る
const safeSeg = (s) => String(s || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'unknown';

// report_url が実ファイルパスを指しているか（旧マーカーや空と区別）
const isStoredPdf = (url) => typeof url === 'string' && url.startsWith('reports/');

// ✅ 安全パトロール - 生成済みPDFを非公開バケットに保存（report_url にパスを記録、以後は編集ロック）
app.post('/api/inspections/:id/report', upload.single('report'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'report フィールド（PDF）が必要です' });

    const { data: insp, error: inspError } = await supabase
      .from('inspections')
      .select('inspection_id, project_id, report_url, inspector_id')
      .eq('id', id)
      .single();
    if (inspError) throw inspError;

    // ✅ PDF発行権限: 管理者は全件、メンバーは自分が検査官の案件のみ
    const perms = await resolvePermissions(req.user.email);
    if (perms.role !== 'admin' && insp.inspector_id !== perms.staffId) {
      return res.status(403).json({ error: 'PDFの発行は担当検査官または管理者のみ可能です' });
    }

    // 既に実ファイルが保存済みなら再生成は不可（生成は一度きり）
    if (insp && isStoredPdf(insp.report_url)) {
      return res.status(409).json({ error: 'この点検は既にPDF生成済みです' });
    }
    // アーカイブ済み（ドライブへ移動済み）は再生成不可
    if (insp && typeof insp.report_url === 'string' && insp.report_url.startsWith('archived:')) {
      return res.status(409).json({ error: 'この点検はアーカイブ済みのため操作できません' });
    }

    await ensureReportsBucket();

    const dateSeg = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const path = `reports/${safeSeg(insp?.project_id)}/${dateSeg}_${safeSeg(insp?.inspection_id || id)}.pdf`;

    const { error: uploadError } = await supabase.storage
      .from(REPORTS_BUCKET)
      .upload(path, req.file.buffer, { contentType: 'application/pdf', upsert: true });
    if (uploadError) throw uploadError;

    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from('inspections')
      .update({ report_url: path, updated_at: now })
      .eq('id', id)
      .select();
    if (error) throw error;

    res.json(data[0]);
  } catch (error) {
    console.error('Error (report upload):', error.message);
    const msg = /service_role|not authorized|permission|row-level|Unauthorized|Invalid API key/i.test(error.message || '')
      ? 'PDFの保存に失敗しました（Renderの環境変数 SUPABASE_SERVICE_ROLE_KEY が必要な可能性があります）'
      : `PDFの保存に失敗しました: ${error.message}`;
    res.status(500).json({ error: msg });
  }
});

// ✅ 安全パトロール - 保存済みPDFの署名付きURLを発行（要認証＝アプリ越しのみ閲覧可能）
app.get('/api/inspections/:id/report-url', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: insp, error: inspError } = await supabase
      .from('inspections')
      .select('report_url')
      .eq('id', id)
      .single();
    if (inspError) throw inspError;

    if (!insp || !isStoredPdf(insp.report_url)) {
      return res.status(404).json({ error: 'PDFがまだ生成・保存されていません' });
    }

    const { data, error } = await supabase.storage
      .from(REPORTS_BUCKET)
      .createSignedUrl(insp.report_url, 120); // 120秒間有効
    if (error) throw error;

    res.json({ url: data.signedUrl });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 安全パトロール - 生成済みPDFを作業所長へメール送信（CCは report_cc=true の社員）
//    宛先(To)＝点検の作業所長(manager_id)のメール、CC＝レポートCC対象の社員。
//    送信権限はPDF発行と同条件（管理者 or 担当検査官）。
app.post('/api/inspections/:id/send-report', async (req, res) => {
  try {
    const { id } = req.params;

    // 点検＋明細（指摘件数算出用）を取得
    const { data: insp, error: inspErr } = await supabase
      .from('inspections')
      .select('*, inspection_details(result)')
      .eq('id', id)
      .single();
    if (inspErr) {
      if (inspErr.code === 'PGRST116') return res.status(404).json({ error: '点検が見つかりません' });
      throw inspErr;
    }

    // 権限: 管理者 or 担当検査官
    const perms = await resolvePermissions(req.user.email);
    if (perms.role !== 'admin' && insp.inspector_id !== perms.staffId) {
      return res.status(403).json({ error: 'メール送信は担当検査官または管理者のみ可能です' });
    }

    // 保存済みPDFが前提
    if (!isStoredPdf(insp.report_url)) {
      return res.status(409).json({ error: '先にPDFを生成・保存してください' });
    }

    // 宛先(To): 作業所長
    if (!insp.manager_id) {
      return res.status(400).json({ error: 'この点検に作業所長が設定されていません' });
    }
    const { data: mgrRows } = await supabase
      .from('staff_master')
      .select('name, email')
      .eq('id', insp.manager_id);
    const manager = mgrRows && mgrRows[0];
    const toEmail = (manager?.email || '').trim();
    if (!toEmail) {
      return res.status(400).json({ error: '作業所長のメールアドレスが未登録です。社員管理で登録してください。' });
    }

    // CC: report_cc=true の社員（Toと重複・空は除外）
    const { data: ccRows } = await supabase
      .from('staff_master')
      .select('email')
      .eq('report_cc', true);
    const ccEmails = [...new Set(
      (ccRows || [])
        .map((r) => (r.email || '').trim())
        .filter(Boolean)
        .filter((e) => e.toLowerCase() !== toEmail.toLowerCase())
    )];

    // 現場名
    const { data: projRows } = await supabase
      .from('projects')
      .select('name')
      .eq('id', insp.project_id);
    const projectName = projRows?.[0]?.name || insp.project_id || '現場';

    // 指摘件数
    const details = insp.inspection_details || [];
    const issueCount = details.filter((d) => d.result === '指摘あり').length;

    // Storage から PDF を取得して添付
    const { data: fileBlob, error: dlErr } = await supabase.storage
      .from(REPORTS_BUCKET)
      .download(insp.report_url);
    if (dlErr) throw dlErr;
    const pdfBuffer = Buffer.from(await fileBlob.arrayBuffer());

    const dateStr = insp.inspection_date
      ? new Date(insp.inspection_date).toLocaleDateString('ja-JP')
      : '';
    const subject = `【安全パトロール点検報告】${projectName} ${dateStr}`.trim();
    const attachName = `点検報告_${String(projectName).replace(/[\\/:*?"<>|]/g, '')}_${dateStr.replace(/\//g, '')}.pdf`;
    const body = [
      `${manager?.name || ''} 様`.trim(),
      '',
      'お疲れ様です。中原建設社内システムです。',
      `${projectName} の安全パトロール点検報告書をお送りします。`,
      '',
      `　点検日　： ${dateStr}`,
      `　現場　　： ${projectName}`,
      `　指摘件数： ${issueCount} 件`,
      '',
      '詳細は添付のPDFをご確認ください。',
      '',
      '────────────────────',
      '※本メールは送信専用アドレスから自動送信されています。',
      '※ご返信いただいてもご対応できない場合があります。',
    ].join('\n');

    const transporter = getMailTransporter();
    await transporter.sendMail({
      from: { name: MAIL_FROM_NAME, address: MAIL_FROM },
      to: toEmail,
      cc: ccEmails.length ? ccEmails : undefined,
      subject,
      text: body,
      attachments: [{ filename: attachName, content: pdfBuffer, contentType: 'application/pdf' }]
    });

    const sentAt = new Date().toISOString();
    await supabase.from('inspections').update({ report_sent_at: sentAt }).eq('id', id);

    res.json({ success: true, to: toEmail, cc: ccEmails, sent_at: sentAt });
  } catch (error) {
    console.error('Error (send-report):', error.message);
    res.status(500).json({ error: `メール送信に失敗しました: ${error.message}` });
  }
});

// ===== 指摘是正フロー =====
// detail と所属 inspection を取得し、所属チェックも行う共通ヘルパー
async function loadDetailWithInspection(inspectionId, detailId) {
  const { data: detail, error } = await supabase
    .from('inspection_details')
    .select('*')
    .eq('id', detailId)
    .single();
  if (error) return { error };
  if (!detail || detail.inspection_id !== inspectionId) return { notFound: true };
  const { data: insp, error: inspErr } = await supabase
    .from('inspections')
    .select('id, inspector_id, manager_id')
    .eq('id', inspectionId)
    .single();
  if (inspErr) return { error: inspErr };
  return { detail, insp };
}

// 是正写真が提出されたら担当検査官へメール通知する（CC: report_cc=true の社員）。
// ベストエフォート: ここでの失敗は呼び出し側で握りつぶし、是正提出自体は成功扱いにする。
async function notifyCorrectionSubmitted({ inspectionId, detail, submitterStaffId }) {
  // 検査官・現場・点検日を取得（loadDetailWithInspection は project/date を持たないため再取得）
  const { data: insp, error: inspErr } = await supabase
    .from('inspections')
    .select('inspector_id, project_id, inspection_date')
    .eq('id', inspectionId)
    .single();
  if (inspErr || !insp) throw new Error('点検情報の取得に失敗しました');
  if (!insp.inspector_id) throw new Error('担当検査官が未設定のため通知できません');

  // To: 担当検査官
  const { data: inspectorRows } = await supabase
    .from('staff_master')
    .select('name, email')
    .eq('id', insp.inspector_id);
  const inspector = inspectorRows && inspectorRows[0];
  const toEmail = (inspector?.email || '').trim();
  if (!toEmail) throw new Error('担当検査官のメールアドレスが未登録です');

  // CC: report_cc=true の社員（既存のPDF報告メールと同じ登録者リスト。To と重複・空は除外）
  const { data: ccRows } = await supabase
    .from('staff_master')
    .select('email')
    .eq('report_cc', true);
  const ccEmails = [...new Set(
    (ccRows || [])
      .map((r) => (r.email || '').trim())
      .filter(Boolean)
      .filter((e) => e.toLowerCase() !== toEmail.toLowerCase())
  )];

  // 現場名・提出者名
  const { data: projRows } = await supabase.from('projects').select('name').eq('id', insp.project_id);
  const projectName = projRows?.[0]?.name || insp.project_id || '現場';
  let submitterName = '';
  if (submitterStaffId) {
    const { data: subRows } = await supabase.from('staff_master').select('name').eq('id', submitterStaffId);
    submitterName = subRows?.[0]?.name || '';
  }

  const dateStr = insp.inspection_date
    ? new Date(insp.inspection_date).toLocaleDateString('ja-JP')
    : '';
  const photoCount = Array.isArray(detail.correction_image_urls) ? detail.correction_image_urls.length : 0;
  const appUrl = (process.env.SAFETY_PATROL_URL || '').trim();

  const subject = `【安全パトロール】是正写真が提出されました（${projectName} ${dateStr}）`.trim();
  const lines = [
    `${inspector?.name || ''} 様`.trim(),
    '',
    'お疲れ様です。中原建設社内システムです。',
    '下記の指摘について是正写真が提出されました。内容をご確認のうえ、承認または差し戻しをお願いします。',
    '',
    `　現場　　： ${projectName}`,
    `　点検日　： ${dateStr}`,
    `　区分　　： ${detail.category || ''}`,
    `　指摘内容： ${detail.issue_content || detail.description || ''}`,
    `　是正写真： ${photoCount} 枚`,
    submitterName ? `　提出者　： ${submitterName}` : null,
    detail.correction_comment ? `　是正コメント： ${detail.correction_comment}` : null,
    '',
    'アプリの「是正対応」画面から確認・承認できます。',
    appUrl ? `　${appUrl}` : null,
    '',
    '────────────────────',
    '※本メールは送信専用アドレスから自動送信されています。',
    '※ご返信いただいてもご対応できない場合があります。',
  ].filter((line) => line !== null);

  const transporter = getMailTransporter();
  await transporter.sendMail({
    from: { name: MAIL_FROM_NAME, address: MAIL_FROM },
    to: toEmail,
    cc: ccEmails.length ? ccEmails : undefined,
    subject,
    text: lines.join('\n'),
  });
  return { to: toEmail, cc: ccEmails };
}

// ✅ 是正写真の提出（作業所長 or 管理者）。pending/rejected → submitted。
app.post('/api/inspections/:id/details/:detailId/correction', async (req, res) => {
  try {
    const { id, detailId } = req.params;
    const { image_urls, comment } = req.body;
    const { detail, insp, error, notFound } = await loadDetailWithInspection(id, detailId);
    if (error) throw error;
    if (notFound) return res.status(404).json({ error: '指摘項目が見つかりません' });
    if (detail.result !== '指摘あり') return res.status(400).json({ error: '指摘ありの項目のみ是正できます' });

    const perms = await resolvePermissions(req.user.email);
    const canSubmit = perms.role === 'admin' || insp.manager_id === perms.staffId;
    if (!canSubmit) return res.status(403).json({ error: '是正写真の提出は作業所長または管理者のみ可能です' });

    const urls = Array.isArray(image_urls) ? image_urls.filter(Boolean) : [];
    if (urls.length === 0) return res.status(400).json({ error: '是正写真を1枚以上添付してください' });

    const { data, error: upErr } = await supabase
      .from('inspection_details')
      .update({
        correction_status: 'submitted',
        correction_image_urls: urls,
        correction_comment: comment || null,
        corrected_at: new Date().toISOString(),
        corrected_by: perms.staffId || null,
        reject_reason: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', detailId)
      .select();
    if (upErr) throw upErr;

    const updated = data[0];
    // 担当検査官へ是正提出を通知（CC: 登録者）。メール失敗は提出成否に影響させない。
    notifyCorrectionSubmitted({ inspectionId: id, detail: updated, submitterStaffId: perms.staffId })
      .then((info) => console.log(`是正提出メール送信: to=${info.to} cc=${info.cc.join(',') || 'なし'}`))
      .catch((mailErr) => console.warn('是正提出メール通知に失敗（提出は成功）:', mailErr.message));

    res.json(updated);
  } catch (error) {
    console.error('Error (correction submit):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 是正の承認（検査官 or 管理者）。submitted → approved。
app.post('/api/inspections/:id/details/:detailId/approve', async (req, res) => {
  try {
    const { id, detailId } = req.params;
    const { detail, insp, error, notFound } = await loadDetailWithInspection(id, detailId);
    if (error) throw error;
    if (notFound) return res.status(404).json({ error: '指摘項目が見つかりません' });

    const perms = await resolvePermissions(req.user.email);
    const canApprove = perms.role === 'admin' || insp.inspector_id === perms.staffId;
    if (!canApprove) return res.status(403).json({ error: '承認は担当検査官または管理者のみ可能です' });
    if (detail.correction_status !== 'submitted') {
      return res.status(409).json({ error: '承認待ち（是正写真提出済み）の項目のみ承認できます' });
    }

    const { data, error: upErr } = await supabase
      .from('inspection_details')
      .update({
        correction_status: 'approved',
        approved_at: new Date().toISOString(),
        approved_by: perms.staffId || null,
        reject_reason: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', detailId)
      .select();
    if (upErr) throw upErr;
    res.json(data[0]);
  } catch (error) {
    console.error('Error (correction approve):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 是正の差し戻し（検査官 or 管理者）。submitted → rejected（理由付き、再提出で submitted に戻る）。
app.post('/api/inspections/:id/details/:detailId/reject', async (req, res) => {
  try {
    const { id, detailId } = req.params;
    const { reason } = req.body;
    const { detail, insp, error, notFound } = await loadDetailWithInspection(id, detailId);
    if (error) throw error;
    if (notFound) return res.status(404).json({ error: '指摘項目が見つかりません' });

    const perms = await resolvePermissions(req.user.email);
    const canApprove = perms.role === 'admin' || insp.inspector_id === perms.staffId;
    if (!canApprove) return res.status(403).json({ error: '差し戻しは担当検査官または管理者のみ可能です' });
    if (detail.correction_status !== 'submitted') {
      return res.status(409).json({ error: '承認待ちの項目のみ差し戻しできます' });
    }

    const { data, error: upErr } = await supabase
      .from('inspection_details')
      .update({
        correction_status: 'rejected',
        reject_reason: reason || null,
        approved_at: null,
        approved_by: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', detailId)
      .select();
    if (upErr) throw upErr;
    res.json(data[0]);
  } catch (error) {
    console.error('Error (correction reject):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 安全パトロール - 点検削除（安全パトロールの管理者のみ）
app.delete('/api/inspections/:id', requireSafetyPatrolAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('inspections')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ マスター管理 - 現場一覧
app.get('/api/masters/projects', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .order('id', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ マスター管理 - 現場作成
app.post('/api/masters/projects', async (req, res) => {
  try {
    const { id, name, location, start_date, end_date, manager_id } = req.body;
    const newId = id || await nextMasterId('projects', 'P');
    const { data, error } = await supabase
      .from('projects')
      .insert([{ id: newId, name, location, start_date, end_date, manager_id }])
      .select();
    if (error) throw error;
    res.json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ マスター管理 - 現場更新
app.put('/api/masters/projects/:id', async (req, res) => {
  try {
    const { name, location, start_date, end_date, manager_id } = req.body;
    const { data, error } = await supabase
      .from('projects')
      .update({ name, location, start_date, end_date, manager_id })
      .eq('id', req.params.id)
      .select();
    if (error) throw error;
    res.json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ マスター管理 - 現場削除
app.delete('/api/masters/projects/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('projects').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ マスター管理 - スタッフ一覧
//    ?app=<アプリキー> 指定時は、そのアプリの利用権限(staff_app_permissions)を
//    持つ社員のみ返す（各アプリの選択リストを権限保有者だけに絞るため）。
//    未指定なら全件＝台帳の管理用（マスター管理タブはこちらを使う）。
app.get('/api/masters/staff', async (req, res) => {
  try {
    const appKey = req.query.app;
    let levelById = null;
    if (appKey) {
      const { data: perms, error: pErr } = await supabase
        .from('staff_app_permissions')
        .select('staff_id, access_level')
        .eq('app_key', appKey);
      if (pErr) throw pErr;
      levelById = {};
      for (const p of perms || []) levelById[p.staff_id] = p.access_level;
      if (Object.keys(levelById).length === 0) return res.json([]); // 権限保有者が居なければ空
    }
    let query = supabase
      .from('staff_master')
      .select('*')
      .order('id', { ascending: true });
    if (levelById) query = query.in('id', Object.keys(levelById));
    const { data, error } = await query;
    if (error) throw error;
    let rows = data || [];
    // ?app= 指定時は各社員の現在のアプリ権限（member/admin）を付与
    if (levelById) rows = rows.map((s) => ({ ...s, app_access_level: levelById[s.id] || null }));
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ マスター管理 - スタッフ作成
app.post('/api/masters/staff', async (req, res) => {
  try {
    const { id, name, email, role, app_role, report_cc } = req.body;
    const newId = id || await nextMasterId('staff_master', 'S');
    const { data, error } = await supabase
      .from('staff_master')
      .insert([{ id: newId, name, email, role, app_role: app_role || 'member', report_cc: !!report_cc }])
      .select();
    if (error) throw error;
    res.json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ マスター管理 - スタッフ更新
app.put('/api/masters/staff/:id', async (req, res) => {
  try {
    const { name, email, role, app_role, report_cc } = req.body;
    const { data, error } = await supabase
      .from('staff_master')
      .update({ name, email, role, app_role, report_cc: !!report_cc })
      .eq('id', req.params.id)
      .select();
    if (error) throw error;
    res.json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ マスター管理 - スタッフ削除
app.delete('/api/masters/staff/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('staff_master').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ マスター管理 - 安全パトロールのアプリ内権限（メンバー/管理者）を変更
//    staff_app_permissions['safety-patrol'] の access_level を upsert する。
//    社員の追加・削除はポータルの社員一覧で行い、ここでは権限の変更のみ。
//    （非GET の /api/masters は requireSafetyPatrolAdmin で保護済み）
app.put('/api/masters/staff/:id/app-permission', async (req, res) => {
  try {
    const staffId = req.params.id;
    const level = req.body?.access_level;
    if (!['member', 'admin'].includes(level)) {
      return res.status(400).json({ error: 'access_level は member か admin を指定してください' });
    }
    const { error } = await supabase.from('staff_app_permissions').upsert(
      { staff_id: staffId, app_key: 'safety-patrol', access_level: level, updated_at: new Date().toISOString() },
      { onConflict: 'staff_id,app_key' }
    );
    if (error) throw error;
    res.json({ success: true, staff_id: staffId, access_level: level });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ マスター管理 - 対象区分一覧
app.get('/api/masters/inspection-items', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('inspection_master')
      .select('*')
      .order('id', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ マスター管理 - 対象区分作成
app.post('/api/masters/inspection-items', async (req, res) => {
  try {
    const { id, category, description } = req.body;
    const newId = id || await nextMasterId('inspection_master', 'M');
    const { data, error } = await supabase
      .from('inspection_master')
      .insert([{ id: newId, category, description }])
      .select();
    if (error) throw error;
    res.json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ マスター管理 - 対象区分更新
app.put('/api/masters/inspection-items/:id', async (req, res) => {
  try {
    const { category, description } = req.body;
    const { data, error } = await supabase
      .from('inspection_master')
      .update({ category, description })
      .eq('id', req.params.id)
      .select();
    if (error) throw error;
    res.json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ マスター管理 - 対象区分削除
app.delete('/api/masters/inspection-items/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('inspection_master').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ 安全パトロール - 指摘内容テンプレート一覧
//    item_id クエリで項目を絞り込み可能。省略時は全件返す（フロントで item_id 別にグルーピング）。
//    利用頻度（use_count）の高い順 → 新しい順で返す。
app.get('/api/issue-templates', async (req, res) => {
  try {
    let query = supabase
      .from('issue_templates')
      .select('*')
      .order('use_count', { ascending: false })
      .order('updated_at', { ascending: false });

    if (req.query.item_id) {
      query = query.eq('item_id', req.query.item_id);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ✅ 個人設定 API（要認証）
//    ユーザーは req.user.email（小文字化）で識別。
//    設定は user_settings テーブルに JSONB で保存する。
// ============================================================

// デフォルト設定（後方互換のためキーが欠けていた場合はこれで補完する）
const DEFAULT_USER_SETTINGS = {
  apps: {
    pinned: [],
    favorites: [],
    order: [],
    show_kpi: true,
  },
  notifications: {
    in_app_enabled: true,
    email_enabled: false,
    // 曜日は JS の getDay() と同じ規約: 0=日,1=月,…,6=土。デフォルト月〜金。
    email_weekdays: [1, 2, 3, 4, 5],
    email_hour: 8,
  },
};

// ディープマージ: target に source を再帰的に上書きする。配列は source で置き換える。
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      typeof target[key] === 'object' &&
      target[key] !== null &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// ✅ 個人設定取得（GET /api/user/settings）
//    保存済みがあれば欠けたキーをデフォルトで補完して返す。未保存はデフォルトをそのまま返す。
app.get('/api/user/settings', requireAuth, async (req, res) => {
  try {
    const email = String(req.user.email || '').toLowerCase();
    const { data, error } = await supabase
      .from('user_settings')
      .select('settings')
      .eq('user_email', email)
      .maybeSingle();
    if (error) throw error;

    // デフォルトに保存済みをマージ（後方互換: 新しいキーがデフォルトから補完される）
    const merged = data ? deepMerge(DEFAULT_USER_SETTINGS, data.settings) : DEFAULT_USER_SETTINGS;
    res.json(merged);
  } catch (error) {
    console.error('Error (user settings GET):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 個人設定更新（PUT /api/user/settings）
//    body は設定オブジェクトの部分更新可。サーバー側でバリデーション・サニタイズを行い、
//    既存設定にディープマージした後 upsert する。返り値は最終的なマージ済み設定。
app.put('/api/user/settings', requireAuth, async (req, res) => {
  try {
    const email = String(req.user.email || '').toLowerCase();
    const body = req.body || {};

    // ── 現在の保存済み設定を取得（デフォルト補完ベースで作業する）──
    const { data: existing, error: fetchErr } = await supabase
      .from('user_settings')
      .select('settings')
      .eq('user_email', email)
      .maybeSingle();
    if (fetchErr) throw fetchErr;

    const base = existing ? deepMerge(DEFAULT_USER_SETTINGS, existing.settings) : { ...DEFAULT_USER_SETTINGS };

    // ── body を base にマージ（部分更新対応）──
    const merged = deepMerge(base, body);

    // ── サニタイズ ──
    // notifications.email_hour: 6〜20 の整数のみ許可。範囲外は無視してデフォルト/既存値を維持。
    const rawHour = merged.notifications?.email_hour;
    const parsedHour = Math.trunc(Number(rawHour));
    if (!Number.isFinite(parsedHour) || parsedHour < 6 || parsedHour > 20) {
      merged.notifications.email_hour = base.notifications.email_hour;
    } else {
      merged.notifications.email_hour = parsedHour;
    }

    // notifications.email_weekdays: 0〜6 の整数配列、重複除去
    const rawWeekdays = merged.notifications?.email_weekdays;
    if (Array.isArray(rawWeekdays)) {
      merged.notifications.email_weekdays = [
        ...new Set(
          rawWeekdays
            .map((d) => Math.trunc(Number(d)))
            .filter((d) => Number.isFinite(d) && d >= 0 && d <= 6)
        ),
      ].sort((a, b) => a - b);
    } else {
      merged.notifications.email_weekdays = base.notifications.email_weekdays;
    }

    // boolean フィールドを !! で正規化
    merged.notifications.in_app_enabled = !!merged.notifications.in_app_enabled;
    merged.notifications.email_enabled = !!merged.notifications.email_enabled;
    merged.apps.show_kpi = !!merged.apps.show_kpi;

    // apps の配列フィールド: 文字列配列のみ許可（非文字列要素は除外）
    for (const key of ['pinned', 'favorites', 'order']) {
      const arr = merged.apps?.[key];
      merged.apps[key] = Array.isArray(arr) ? arr.filter((v) => typeof v === 'string') : [];
    }

    // ── upsert ──
    const { error: upsertErr } = await supabase
      .from('user_settings')
      .upsert(
        { user_email: email, settings: merged, updated_at: new Date().toISOString() },
        { onConflict: 'user_email' }
      );
    if (upsertErr) throw upsertErr;

    res.json(merged);
  } catch (error) {
    console.error('Error (user settings PUT):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ✅ 社員一覧（社員台帳 / アプリ別権限 / 資格管理）API
//    - 台帳本体は staff_master（安全パトロールと共用）。
//    - アプリ別権限は app_permissions（社員 × アプリ × member/admin）。
//    - 資格は qualification_master（マスタ）と staff_qualifications（社員ひも付け）。
//    既存の /api/masters/staff（安全パトロールのマスタ管理）はそのまま温存し、
//    社員一覧画面はこちらの /api/employees・/api/qualifications を使う。
// ============================================================

// 既知のアプリキー（/api/apps と権限UIで共有）
const APP_KEYS = ['safety-patrol', 'employee-list', 'announcements', 'bids', 'documents', 'feedback', 'workscope', 'construction', 'regulations', 'cards'];

// staffId のアプリ別権限を { app_key: 'member'|'admin' } のマップで返す
async function resolveAppPermissions(staffId) {
  if (!staffId) return {};
  const { data, error } = await supabase
    .from('staff_app_permissions')
    .select('app_key, access_level')
    .eq('staff_id', staffId);
  if (error) {
    console.error('resolveAppPermissions 失敗:', error.message);
    return {};
  }
  const map = {};
  for (const r of data || []) map[r.app_key] = r.access_level;
  return map;
}

// 社員一覧アプリにおける本人のロールを解決
//  - グローバル管理者（ADMIN_EMAILS / staff_master.app_role='admin'）は常に 'admin'
//  - それ以外は app_permissions の 'employee-list' を見る（admin / member / none）
async function resolveEmployeeRole(email) {
  const perms = await resolvePermissions(email); // { role, staffId }
  if (perms.role === 'admin') return { role: 'admin', staffId: perms.staffId, globalAdmin: true };
  let level = null;
  if (perms.staffId) {
    const { data } = await supabase
      .from('staff_app_permissions')
      .select('access_level')
      .eq('staff_id', perms.staffId)
      .eq('app_key', 'employee-list')
      .maybeSingle();
    level = data?.access_level || null;
  }
  const role = level === 'admin' ? 'admin' : level ? 'member' : 'none';
  return { role, staffId: perms.staffId, globalAdmin: false };
}

// 社員一覧の閲覧権限（member 以上）
async function requireEmployeeAccess(req, res, next) {
  try {
    const r = await resolveEmployeeRole(req.user.email);
    if (r.role === 'none') return res.status(403).json({ error: '社員一覧へのアクセス権がありません' });
    req.empRole = r;
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// 社員一覧の管理権限（admin のみ）
async function requireEmployeeAdmin(req, res, next) {
  try {
    const r = await resolveEmployeeRole(req.user.email);
    if (r.role !== 'admin') return res.status(403).json({ error: 'この操作は社員一覧の管理者のみ可能です' });
    req.empRole = r;
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ✅ 入札案件管理のアクセス権（入札担当のみ）
//    権限は staff_app_permissions['bids'] に付与（社員一覧画面のアプリ別権限から設定）。
//    - グローバル管理者（ADMIN_EMAILS / staff_master.app_role='admin'）は常に許可
//    - それ以外は staff_app_permissions['bids'] に行があれば許可（access_level は問わない）
//    入札担当のみが使う前提のため、閲覧/編集でロールを分けない（行があれば全操作可）。
async function resolveBidRole(email) {
  const perms = await resolvePermissions(email); // { role, staffId }
  if (perms.role === 'admin') return { role: 'admin', access: true, staffId: perms.staffId, globalAdmin: true };
  let level = null;
  if (perms.staffId) {
    const { data } = await supabase
      .from('staff_app_permissions')
      .select('access_level')
      .eq('staff_id', perms.staffId)
      .eq('app_key', 'bids')
      .maybeSingle();
    level = data?.access_level || null;
  }
  const role = level === 'admin' ? 'admin' : level ? 'member' : 'none';
  return { role, access: role !== 'none', staffId: perms.staffId, globalAdmin: false };
}

// 入札案件管理のアクセス権（行があれば許可）
async function requireBidAccess(req, res, next) {
  try {
    const r = await resolveBidRole(req.user.email);
    if (!r.access) return res.status(403).json({ error: '入札案件管理へのアクセス権がありません' });
    req.bidRole = r;
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// 入札案件管理の管理者のみ許可（既存案件の編集・削除）。要 requireAuth 後段。
async function requireBidAdmin(req, res, next) {
  try {
    const r = await resolveBidRole(req.user.email);
    if (r.role !== 'admin') return res.status(403).json({ error: 'この操作は入札案件管理の管理者のみ可能です' });
    req.bidRole = r;
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// 期限切れ間近の判定日数（既定90日）
const EXPIRY_SOON_DAYS = 90;

// ✅ 社員一覧 - 一覧取得（権限サマリ・資格件数・期限アラートを付与）
app.get('/api/employees', requireAuth, requireEmployeeAccess, async (req, res) => {
  try {
    const [{ data: staff, error: sErr }, { data: perms }, { data: quals }] = await Promise.all([
      supabase.from('staff_master').select('*').order('id', { ascending: true }),
      supabase.from('staff_app_permissions').select('staff_id, app_key, access_level'),
      supabase.from('staff_qualifications').select('staff_id, expiry_date'),
    ]);
    if (sErr) throw sErr;

    // 権限を staff_id ごとにまとめる
    const permByStaff = {};
    for (const p of perms || []) {
      (permByStaff[p.staff_id] ||= {})[p.app_key] = p.access_level;
    }

    // 資格件数・期限アラート件数を staff_id ごとに集計
    const today = new Date();
    const soon = new Date(today.getTime() + EXPIRY_SOON_DAYS * 86400000);
    const qStat = {};
    for (const q of quals || []) {
      const s = (qStat[q.staff_id] ||= { count: 0, expiring: 0, expired: 0 });
      s.count++;
      if (q.expiry_date) {
        const d = new Date(q.expiry_date);
        if (d < today) s.expired++;
        else if (d <= soon) s.expiring++;
      }
    }

    const rows = (staff || []).map((s) => ({
      ...s,
      permissions: permByStaff[s.id] || {},
      qualification_count: qStat[s.id]?.count || 0,
      qualification_expiring: qStat[s.id]?.expiring || 0,
      qualification_expired: qStat[s.id]?.expired || 0,
    }));
    // メールパスワードは機微情報。社員一覧の管理者のみに返し、それ以外（member）には伏せる。
    if (req.empRole?.role !== 'admin') {
      for (const r of rows) delete r.email_password;
    }
    res.json(rows);
  } catch (error) {
    console.error('Error (employees list):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 社員一覧 - 社員作成（管理者のみ）
app.post('/api/employees', requireAuth, requireEmployeeAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const newId = b.id || (await nextMasterId('staff_master', 'S'));
    const row = {
      id: newId,
      name: b.name,
      furigana: b.furigana || null,
      email: b.email || null,
      skill_id: b.skill_id || null,
      job_type: b.job_type || null,
      department: b.department || null,
      company: b.company || null,
      birth_date: b.birth_date || null,
      gender: b.gender || null,
      phone: b.phone || null,
      postal_code: b.postal_code || null,
      address: b.address || null,
      hire_date: b.hire_date || null,
      email_password: b.email_password || null,
      role: b.role || null,
      app_role: b.app_role || 'member',
      report_cc: !!b.report_cc,
      is_active: b.is_active === undefined ? true : !!b.is_active,
    };
    const { data, error } = await supabase.from('staff_master').insert([row]).select();
    if (error) throw error;
    res.json(data[0]);
  } catch (error) {
    console.error('Error (employee create):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 社員一覧 - 社員更新（管理者のみ）
app.put('/api/employees/:id', requireAuth, requireEmployeeAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    // 送られてきたフィールドのみ更新（部分更新）
    const allowed = ['name', 'furigana', 'email', 'email_password', 'skill_id', 'job_type', 'department', 'company',
      'birth_date', 'gender', 'phone', 'postal_code', 'address', 'hire_date', 'role', 'app_role', 'report_cc', 'is_active'];
    const patch = { updated_at: new Date().toISOString() };
    for (const k of allowed) {
      if (b[k] !== undefined) {
        patch[k] = (k === 'report_cc' || k === 'is_active') ? !!b[k] : (b[k] === '' ? null : b[k]);
      }
    }
    const { data, error } = await supabase
      .from('staff_master').update(patch).eq('id', req.params.id).select();
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: '社員が見つかりません' });
    res.json(data[0]);
  } catch (error) {
    console.error('Error (employee update):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 社員一覧 - 社員削除（管理者のみ）。app_permissions / staff_qualifications は FK の ON DELETE CASCADE で消える。
app.delete('/api/employees/:id', requireAuth, requireEmployeeAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('staff_master').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('Error (employee delete):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 社員一覧 - アプリ別権限の更新（管理者のみ）
//    body: { permissions: { 'safety-patrol': 'admin'|'member'|'none'|null, ... } }
//    'none' / null / 空文字 はアクセス権の削除。member/admin は upsert。
app.put('/api/employees/:id/permissions', requireAuth, requireEmployeeAdmin, async (req, res) => {
  try {
    const staffId = req.params.id;
    const incoming = (req.body && req.body.permissions) || {};

    // 対象社員の存在チェック
    const { data: staff } = await supabase.from('staff_master').select('id').eq('id', staffId).maybeSingle();
    if (!staff) return res.status(404).json({ error: '社員が見つかりません' });

    for (const [appKey, levelRaw] of Object.entries(incoming)) {
      if (!APP_KEYS.includes(appKey)) continue; // 未知アプリキーは無視
      const level = levelRaw === 'admin' ? 'admin' : levelRaw === 'member' ? 'member' : null;
      if (level === null) {
        await supabase.from('staff_app_permissions').delete().eq('staff_id', staffId).eq('app_key', appKey);
      } else {
        await supabase.from('staff_app_permissions').upsert(
          { staff_id: staffId, app_key: appKey, access_level: level, updated_at: new Date().toISOString() },
          { onConflict: 'staff_id,app_key' }
        );
      }
    }

    const map = await resolveAppPermissions(staffId);
    res.json({ staff_id: staffId, permissions: map });
  } catch (error) {
    console.error('Error (permissions update):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ===== 共有メールアドレス（個人に紐付かない共用メール）=====

// 一覧取得（閲覧は社員一覧アクセス権。email_password は admin のみに返す）
app.get('/api/shared-mailboxes', requireAuth, requireEmployeeAccess, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('shared_mailboxes')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true });
    if (error) throw error;
    const rows = data || [];
    if (req.empRole?.role !== 'admin') {
      for (const r of rows) delete r.email_password;
    }
    res.json(rows);
  } catch (error) {
    console.error('Error (shared-mailboxes list):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 追加（管理者のみ）
app.post('/api/shared-mailboxes', requireAuth, requireEmployeeAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.email?.trim()) return res.status(400).json({ error: 'メールアドレスは必須です' });
    const row = {
      email: b.email.trim(),
      label: b.label?.trim() || null,
      email_password: b.email_password || null,
      sort_order: Number.isFinite(b.sort_order) ? b.sort_order : 0,
    };
    const { data, error } = await supabase.from('shared_mailboxes').insert([row]).select();
    if (error) throw error;
    res.json(data[0]);
  } catch (error) {
    console.error('Error (shared-mailbox create):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 更新（管理者のみ・部分更新）
app.put('/api/shared-mailboxes/:id', requireAuth, requireEmployeeAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const allowed = ['email', 'label', 'email_password', 'sort_order'];
    const patch = { updated_at: new Date().toISOString() };
    for (const k of allowed) {
      if (b[k] !== undefined) patch[k] = (b[k] === '' ? null : b[k]);
    }
    const { data, error } = await supabase
      .from('shared_mailboxes').update(patch).eq('id', req.params.id).select();
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: '共有メールが見つかりません' });
    res.json(data[0]);
  } catch (error) {
    console.error('Error (shared-mailbox update):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 削除（管理者のみ）
app.delete('/api/shared-mailboxes/:id', requireAuth, requireEmployeeAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('shared_mailboxes').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('Error (shared-mailbox delete):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 注: 社員の一括インポート機能（旧 POST /api/employees/import）は廃止しました。
//     社員登録は画面からの個別追加、台帳の持ち出しは CSV エクスポートで行います。

// ===== 資格マスタ =====

// ✅ 資格マスタ一覧（認証必須・閲覧は社員一覧アクセス権で十分）
app.get('/api/qualifications', requireAuth, requireEmployeeAccess, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('qualification_master')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ 資格マスタ - 期限切れ間近/期限切れの社員資格一覧（:id ルートより前に定義）
app.get('/api/qualifications/expiring', requireAuth, requireEmployeeAccess, async (req, res) => {
  try {
    const days = Number(req.query.days) > 0 ? Number(req.query.days) : EXPIRY_SOON_DAYS;
    const limit = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const { data, error } = await supabase
      .from('staff_qualifications')
      .select('*, qualification_master(name, category), staff_master(name)')
      .not('expiry_date', 'is', null)
      .lte('expiry_date', limit)
      .order('expiry_date', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ 資格マスタ - 作成（管理者のみ）
app.post('/api/qualifications', requireAuth, requireEmployeeAdmin, async (req, res) => {
  try {
    const { id, name, category, has_expiry, sort_order } = req.body || {};
    if (!name) return res.status(400).json({ error: '資格名は必須です' });
    // 同名マスタが既にあれば再利用する（一括取込で同じ新規資格が複数行あっても重複登録で失敗させない）
    const { data: existing } = await supabase
      .from('qualification_master').select('*').eq('name', name).maybeSingle();
    if (existing) return res.json(existing);
    const newId = id || (await nextMasterId('qualification_master', 'Q'));
    const { data, error } = await supabase
      .from('qualification_master')
      .insert([{ id: newId, name, category: category || 'その他', has_expiry: !!has_expiry, sort_order: sort_order || 0 }])
      .select();
    if (error) {
      // 同時実行などで一意制約に当たった場合も既存行を返す（23505 = unique_violation）
      if (error.code === '23505') {
        const { data: row } = await supabase
          .from('qualification_master').select('*').eq('name', name).maybeSingle();
        if (row) return res.json(row);
      }
      throw error;
    }
    res.json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ 資格マスタ - 更新（管理者のみ）
app.put('/api/qualifications/:id', requireAuth, requireEmployeeAdmin, async (req, res) => {
  try {
    const { name, category, has_expiry, sort_order } = req.body || {};
    const patch = { updated_at: new Date().toISOString() };
    if (name !== undefined) patch.name = name;
    if (category !== undefined) patch.category = category;
    if (has_expiry !== undefined) patch.has_expiry = !!has_expiry;
    if (sort_order !== undefined) patch.sort_order = sort_order;
    const { data, error } = await supabase
      .from('qualification_master').update(patch).eq('id', req.params.id).select();
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: '資格が見つかりません' });
    res.json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ 資格マスタ - 削除（管理者のみ）。ひも付く staff_qualifications は CASCADE で消える。
app.delete('/api/qualifications/:id', requireAuth, requireEmployeeAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('qualification_master').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== 資格者証の AI 読み取り（Gemini）+ 原本画像保存 =====

// 資格者証の原本画像を入れる Supabase Storage バケット（非公開）。
// 個人情報（氏名・生年月日等）を含むため公開せず、閲覧時に署名付きURLを都度発行する。
const CERT_BUCKET = 'qualification-certs';
let certBucketEnsured = false;
async function ensureCertBucket() {
  if (certBucketEnsured) return;
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw error;
  if (!buckets?.some((b) => b.name === CERT_BUCKET)) {
    const { error: createError } = await supabase.storage.createBucket(CERT_BUCKET, { public: false });
    if (createError && !/exist/i.test(createError.message)) throw createError;
  }
  certBucketEnsured = true;
}

// 保存先の方針（標準ストレージ方針）: 'drive' で共有ドライブ(Google Drive)、それ以外は Supabase。
// 未設定なら 'supabase'＝従来動作。Drive 連携の環境変数が揃っていない場合も安全に Supabase へフォールバック。
const CERT_STORAGE = (process.env.CERT_STORAGE || 'supabase').toLowerCase();

// Drive のフォルダ名・Supabase未使用に安全な文字へ整える。
function sanitizeSeg(s) {
  const v = String(s == null ? '' : s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100);
  return v || '_未分類';
}

// 資格者証の保存先サブフォルダ階層 [会社, 社員名] を決める（Drive: 会社別→社員別）。
function certFolderSegments(staff) {
  const company = (staff && staff.company ? String(staff.company).trim() : '') || '会社未設定';
  const name = (staff && staff.name ? String(staff.name).trim() : '') || '_未分類';
  return [sanitizeSeg(company), sanitizeSeg(name)];
}

// 資格者証ファイルを方針に従って保存し、DBの cert_image_path に入れる「参照」を返す。
//   Supabase: バケット内のパス（従来どおり。例 "inbox/xxx.pdf"）
//   Drive   : "drive:<fileId>"（接頭辞で見分ける）。segments があれば 会社\社員名 サブフォルダへ自動格納。
// pathKey は Supabase ではパスキー、Drive では basename（末尾）をファイル名に使う。
async function storeCert(pathKey, buffer, mimeType, segments) {
  if (CERT_STORAGE === 'drive' && driveConfigured()) {
    const folderId = segments && segments.length ? await ensureFolderPath(segments) : undefined;
    const name = String(pathKey).split('/').pop();
    const fileId = await driveUpload({ name, buffer, mimeType, folderId });
    return `drive:${fileId}`;
  }
  await ensureCertBucket();
  const { error } = await supabase.storage.from(CERT_BUCKET).upload(pathKey, buffer, { contentType: mimeType });
  if (error) throw error;
  return pathKey;
}

// 資格者証を一時表示するためのURL（既定1時間）。
//   "drive:" 参照 → 署名トークン付きの API プロキシURL（/api/cert-file）。<img src> から認証ヘッダ無しで開ける。
//   それ以外     → Supabase の署名付きURL（既存の保存済みファイルもそのまま表示できる）。
async function certSignedUrl(ref, expiresIn = 3600) {
  if (!ref) return null;
  if (String(ref).startsWith('drive:')) {
    const fileId = String(ref).slice('drive:'.length);
    const token = jwt.sign({ fileId, kind: 'cert' }, JWT_SECRET, { expiresIn });
    const base = process.env.PUBLIC_API_URL || 'https://portal-api-hhlx.onrender.com';
    return `${base}/api/cert-file?t=${encodeURIComponent(token)}`;
  }
  const { data } = await supabase.storage.from(CERT_BUCKET).createSignedUrl(ref, expiresIn);
  return data?.signedUrl || null;
}

// 署名トークンで保護された資格者証プロキシ。Drive 上の非公開ファイルを API 経由で配信する。
// 認証は requireAuth ではなく certSignedUrl が発行する短命JWT（?t=）で行う（署名付きURL相当）。
app.get('/api/cert-file', async (req, res) => {
  try {
    const token = req.query.t;
    if (!token) return res.status(400).send('missing token');
    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).send('invalid or expired token');
    }
    if (payload.kind !== 'cert' || !payload.fileId) return res.status(400).send('bad token');
    const { buffer, contentType } = await driveDownload(payload.fileId);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.send(buffer);
  } catch (error) {
    console.error('Error (cert-file proxy):', error.message);
    res.status(error.status || 500).send(error.message);
  }
});

// 資格名の正規化（空白・括弧書きを除去して突合精度を上げる）
// 漢数字→算用数字（「二級建築士免許証」と「2級建築士」を突合できるようにする）
const KANJI_NUM = { '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9' };
function normalizeQualName(s) {
  return String(s || '')
    .replace(/[（(].*?[)）]/g, '')
    .replace(/[一二三四五六七八九]/g, (m) => KANJI_NUM[m])
    .replace(/[\s　]/g, '')
    .toLowerCase();
}

// 抽出した資格名を qualification_master に突合。完全一致→部分一致の順。見つからなければ null。
function matchQualificationId(name, masters) {
  const n = normalizeQualName(name);
  if (!n) return null;
  const exact = masters.find((m) => normalizeQualName(m.name) === n);
  if (exact) return exact.id;
  const part = masters.find((m) => {
    const mn = normalizeQualName(m.name);
    return mn && (mn.includes(n) || n.includes(mn));
  });
  return part ? part.id : null;
}

// YYYY-MM-DD 形式のみ許可。それ以外（和暦の取りこぼし等）は null にして手入力に委ねる。
function cleanIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? s : null;
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// 資格者証の画像/PDF を Gemini で解析し、資格名・区分・番号・取得日・有効期限を構造化して返す。
async function extractCertificate(buffer, mimeType) {
  if (!GEMINI_API_KEY) {
    const e = new Error('GEMINI_API_KEY が未設定です。Render の環境変数に設定してください。');
    e.status = 503;
    throw e;
  }
  const prompt = [
    'これは日本の労働安全衛生に関する「資格者証」（修了証・技能講習修了証・免許証・運転免許証など）の画像です。',
    '記載内容を読み取り、次の項目をJSONで返してください。',
    '- person_name: 資格を保有する本人の氏名（証書に記載の受講者・免許保有者名。姓名の間の空白は除いて返す。読めなければ空文字）',
    '- name: 資格・講習の正式名称（例: 玉掛け技能講習、フォークリフト運転技能講習、職長・安全衛生責任者教育）',
    '- category: 次のいずれか1つ「特別教育」「技能講習」「免許」「その他」',
    '- cert_number: 証明書番号・免許番号（無ければ空文字）',
    '- acquired_date: 取得日・修了日（YYYY-MM-DD。和暦は西暦へ変換。読めなければ空文字）',
    '- expiry_date: 有効期限（YYYY-MM-DD。期限の記載が無ければ空文字）',
    '読み取れない項目は空文字にし、推測で埋めないでください。',
  ].join('\n');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: mimeType || 'image/jpeg', data: buffer.toString('base64') } },
      ],
    }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          person_name: { type: 'STRING' },
          name: { type: 'STRING' },
          category: { type: 'STRING', enum: ['特別教育', '技能講習', '免許', 'その他'] },
          cert_number: { type: 'STRING' },
          acquired_date: { type: 'STRING' },
          expiry_date: { type: 'STRING' },
        },
        required: ['name', 'category'],
      },
    },
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text();
    const e = new Error(`Gemini API エラー (${resp.status}): ${t.slice(0, 300)}`);
    e.status = 502;
    throw e;
  }
  const json = await resp.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini から有効な応答が得られませんでした');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('Gemini 応答の解析に失敗しました'); }

  const CATS = ['特別教育', '技能講習', '免許', 'その他'];
  return {
    person_name: (parsed.person_name || '').trim(),
    name: (parsed.name || '').trim(),
    category: CATS.includes(parsed.category) ? parsed.category : 'その他',
    cert_number: (parsed.cert_number || '').trim(),
    acquired_date: cleanIsoDate(parsed.acquired_date),
    expiry_date: cleanIsoDate(parsed.expiry_date),
  };
}

// 異体字フォールド（台帳とのゆらぎ吸収。誤統合を避けるため保守的な範囲に限定）
const NAME_VARIANTS = [
  [/[斎齋齊]/g, '斉'], [/[邉邊]/g, '辺'], [/髙/g, '高'], [/[﨑嵜]/g, '崎'],
  [/德/g, '徳'], [/佑/g, '祐'], [/濵/g, '浜'], [/曺/g, '曹'], [/廸/g, '迪'],
];
function foldVariants(s) {
  let r = String(s || '');
  for (const [re, to] of NAME_VARIANTS) r = r.replace(re, to);
  return r;
}
// 抽出した氏名を staff_master へ突合（空白除去＋異体字フォールド後の完全一致）。
// 一致しなければ null を返してフロントで人に選ばせる。
function normalizePersonName(s) {
  return foldVariants(String(s || '').replace(/[\s　]/g, '')).toLowerCase();
}
function matchStaffId(name, staff) {
  const n = normalizePersonName(name);
  if (!n) return null;
  const hit = (staff || []).find((s) => normalizePersonName(s.name) === n);
  return hit ? hit.id : null;
}

// ===== 社員ごとの資格 =====

// ✅ 社員の保有資格一覧（資格マスタ名を結合。原本画像があれば署名付きURLを付与）
app.get('/api/employees/:id/qualifications', requireAuth, requireEmployeeAccess, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('staff_qualifications')
      .select('*, qualification_master(name, category, has_expiry)')
      .eq('staff_id', req.params.id)
      .order('acquired_date', { ascending: false });
    if (error) throw error;
    // 原本画像があれば表示用の署名付きURLを付与
    const rows = await Promise.all((data || []).map(async (r) => ({
      ...r,
      cert_image_url: r.cert_image_path ? await certSignedUrl(r.cert_image_path) : null,
    })));
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ 社員へ資格を追加（管理者のみ）。cert_image_path があれば原本画像も紐付ける。
//    issuer（発行者）・honseki（本籍地）は一括取込時に証書から抽出した値を受け取って保存する。
//    ★既に同じ社員×資格が登録済みの場合は「更新（資格証の更新）」とみなし、日付の新しい方を残す。
//      新しい証書の方が新しければ内容を更新、既存の方が新しければそのまま維持する。
//      応答に _action（'inserted' | 'updated' | 'kept'）を含める。
app.post('/api/employees/:id/qualifications', requireAuth, requireEmployeeAdmin, async (req, res) => {
  try {
    const { qualification_id, acquired_date, expiry_date, cert_number, note, cert_image_path, issuer, honseki } = req.body || {};
    if (!qualification_id) return res.status(400).json({ error: '資格を選択してください' });
    const staff_id = req.params.id;

    // 既存（同一社員×資格）を確認
    const { data: existRows, error: exErr } = await supabase
      .from('staff_qualifications')
      .select('*')
      .eq('staff_id', staff_id)
      .eq('qualification_id', qualification_id)
      .limit(1);
    if (exErr) throw exErr;
    const existing = existRows && existRows[0];

    // 「新しさ」は 取得（修了/合格）日 を優先し、無ければ有効期限で比較する
    const pickDate = (r) => (r && (r.acquired_date || r.expiry_date)) || null;

    if (existing) {
      const nd = acquired_date || expiry_date || null; // 今回アップ分
      const od = pickDate(existing);                    // 既存分
      // 既存の方が新しい（= 今回が古い）なら維持。日付比較は YYYY-MM-DD の文字列比較で可。
      const incomingIsNewer = nd
        ? (!od || nd > od)      // 今回に日付あり: 既存に日付が無いか、今回が新しければ更新
        : (!od);               // 今回に日付なし: 既存も日付無しなら最新アップで上書き、既存に日付あれば維持
      if (!incomingIsNewer) {
        existing.cert_image_url = existing.cert_image_path ? await certSignedUrl(existing.cert_image_path) : null;
        existing._action = 'kept';
        return res.json(existing);
      }
      // 今回が新しい→更新（欠損項目は既存値を温存してデータを失わない）
      const patch = {
        acquired_date: acquired_date || existing.acquired_date || null,
        expiry_date:   expiry_date   || existing.expiry_date   || null,
        cert_number:   cert_number   || existing.cert_number   || null,
        note:          note          || existing.note          || null,
        cert_image_path: cert_image_path || existing.cert_image_path || null,
        issuer:        issuer        || existing.issuer        || null,
        honseki:       honseki       || existing.honseki       || null,
        updated_at:    new Date().toISOString(),
      };
      const { data: upd, error: upErr } = await supabase
        .from('staff_qualifications')
        .update(patch)
        .eq('id', existing.id)
        .select('*, qualification_master(name, category, has_expiry)');
      if (upErr) throw upErr;
      const row = upd[0];
      row.cert_image_url = row.cert_image_path ? await certSignedUrl(row.cert_image_path) : null;
      row._action = 'updated';
      return res.json(row);
    }

    // 新規登録
    const { data, error } = await supabase
      .from('staff_qualifications')
      .insert([{
        staff_id,
        qualification_id,
        acquired_date: acquired_date || null,
        expiry_date: expiry_date || null,
        cert_number: cert_number || null,
        note: note || null,
        cert_image_path: cert_image_path || null,
        issuer: issuer || null,
        honseki: honseki || null,
      }])
      .select('*, qualification_master(name, category, has_expiry)');
    if (error) {
      // 競合で既に作られていた場合は更新側で拾えるよう 409 ではなく簡潔に返す
      if (error.code === '23505') return res.status(409).json({ error: 'この社員には既に同じ資格が登録されています（再実行してください）' });
      throw error;
    }
    const row = data[0];
    row.cert_image_url = row.cert_image_path ? await certSignedUrl(row.cert_image_path) : null;
    row._action = 'inserted';
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ 資格者証をアップロード→Geminiで読取→原本画像を保存し、抽出結果を返す（管理者のみ）
//    この時点ではDBに資格は登録しない。フロントで内容を確認・修正してから保存する。
//    返り値: { extracted, matched_qualification_id, cert_image_path, cert_image_url }
app.post('/api/employees/:id/qualifications/scan', requireAuth, requireEmployeeAdmin, upload.single('cert'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'cert（資格者証の画像/PDF）が必要です' });

    // 1) Gemini で内容を抽出
    const extracted = await extractCertificate(req.file.buffer, req.file.mimetype);

    // 2) 原本画像を保存（方針に従い Drive または Supabase。Drive は 会社\社員名 サブフォルダへ）
    const { data: staffRow } = await supabase
      .from('staff_master').select('name, company').eq('id', req.params.id).maybeSingle();
    const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase();
    const path = await storeCert(
      `${req.params.id}/${Date.now()}-${uuidv4()}.${ext}`,
      req.file.buffer,
      req.file.mimetype,
      certFolderSegments(staffRow),
    );

    // 3) 抽出した資格名を既存マスタへ突合
    const { data: masters } = await supabase.from('qualification_master').select('id, name');
    const matched_qualification_id = matchQualificationId(extracted.name, masters || []);

    res.json({
      extracted,
      matched_qualification_id,
      cert_image_path: path,
      cert_image_url: await certSignedUrl(path),
    });
  } catch (error) {
    console.error('Error (qualification scan):', error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ===== 束ねPDF一括取込: Gemini によるページ配列解析 =====

// 資格書類をまとめた PDF または画像を Gemini に1回渡し、全ページを配列で返す。
// 各要素は { page, type, qualification_name?, holders?, person_name?, cert_number?,
//             acquired_date?, expiry_date?, birth_date?, honseki?, issuer? }
async function extractCertificatePages(buffer, mimeType) {
  if (!GEMINI_API_KEY) {
    const e = new Error('GEMINI_API_KEY が未設定です。Render の環境変数に設定してください。');
    e.status = 503;
    throw e;
  }

  const prompt = [
    'これは日本の建設業における資格関連書類をまとめたPDF/画像です。',
    'ページを走査し、下記スキーマの配列をJSONで返してください。1つの要素は「1つの名簿」または「1つの証書」です。',
    '',
    '【最重要】1ページに複数の資格の名簿が並んでいる場合（例: 同じページに「1級建築士」と「2級建築士」の表が別々にある）は、',
    '資格ごとに別々の roster 要素として返してください。複数の見出しを1つにまとめたり、資格名を連結しないでください。',
    '',
    '【要素種別（type）】',
    '- index: 資格一覧表・索引（資格名の目次のみ）',
    '- roster: 資格名が見出しで、その下に保有者の氏名一覧がある名簿',
    '- certificate: 免許証・合格証明書・技能講習修了証・特別教育修了証等の証書',
    '- other: 上記以外',
    '',
    '【roster 要素のフィールド】',
    '- page: ページ番号(整数)',
    '- qualification_name: その名簿の見出しに実際に書かれている資格名（1つだけ。例: 1級建築士）。',
    '    見出しに無い「技士補」「補」「（）内の補足」などを推測で付け足さず、書かれている通りに返す。',
    '- holders: 氏名の配列（姓名間の空白は除く。手書きでも読めるだけ読む）',
    '',
    '【certificate 要素のフィールド】',
    '- page: ページ番号(整数)',
    '- person_name: 本人氏名（姓名間の空白は除く。読めなければ空文字）',
    '- qualification_name: その証書が証明している「資格そのものの名称」。',
    '    ★証書の表題ではなく本文を読んで判断する。表題が一般名のことがあるため。',
    '    例: 表題が「1級技術検定合格証明書」でも、本文の検定種目（建築施工管理 等）と級を読み、',
    '       「1級建築施工管理技士」とする（表題の「技術検定合格証明書」を資格名にしない）。',
    '    施工管理技士系の技術検定は「○級△△施工管理技士」の形に整える',
    '       （△△=建築/土木/電気工事/管工事/造園/建設機械/電気通信工事。級は本文の1級/2級）。',
    '    「○○技能講習修了証」なら講習名（例: 玉掛け技能講習）、「二級建築士免許証」なら「二級建築士」。',
    '    本文から種目が読み取れない場合のみ、表題をそのまま返してよい。',
    '- cert_number: 証明書番号・免許番号・登録番号（無ければ空文字）',
    '- acquired_date: 取得日・登録年月日・合格日（YYYY-MM-DD。和暦は西暦へ。読めなければ空文字）',
    '- expiry_date: 有効期限・有効期間満了日（YYYY-MM-DD。無ければ空文字）',
    '- birth_date: 本人の生年月日（YYYY-MM-DD。和暦は西暦へ。無ければ空文字）',
    '- honseki: 本籍地（例: 福岡県。無ければ空文字）',
    '- issuer: 発行者名（例: 建設大臣、長崎県知事、国土交通大臣。無ければ空文字）',
    '',
    '【注意】',
    '- 90度回転している証書も向きを補正して正しく読んでください。',
    '- 読み取れない項目は空文字にしてください。推測で埋めないでください。',
    '- 1ページに複数の証書が印刷されている場合は1要素として扱ってください。',
  ].join('\n');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: mimeType || 'application/pdf', data: buffer.toString('base64') } },
      ],
    }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      maxOutputTokens: 32768,
      responseSchema: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            page:               { type: 'INTEGER' },
            type:               { type: 'STRING', enum: ['index', 'roster', 'certificate', 'other'] },
            qualification_name: { type: 'STRING' },
            holders:            { type: 'ARRAY', items: { type: 'STRING' } },
            person_name:        { type: 'STRING' },
            cert_number:        { type: 'STRING' },
            acquired_date:      { type: 'STRING' },
            expiry_date:        { type: 'STRING' },
            birth_date:         { type: 'STRING' },
            honseki:            { type: 'STRING' },
            issuer:             { type: 'STRING' },
          },
          required: ['page', 'type'],
        },
      },
    },
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text();
    const e = new Error(`Gemini API エラー (${resp.status}): ${t.slice(0, 300)}`);
    e.status = 502;
    throw e;
  }
  const json = await resp.json();
  const cand = json?.candidates?.[0];
  if (cand?.finishReason === 'MAX_TOKENS') {
    const e = new Error('PDFの情報量が多く、AIが読み切れませんでした。資格ごと等にPDFを分割してアップロードしてください。');
    e.status = 413;
    throw e;
  }
  const text = cand?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini から有効な応答が得られませんでした');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('Gemini 応答の解析に失敗しました'); }
  if (!Array.isArray(parsed)) throw new Error('Gemini 応答がページ配列形式ではありません');

  // 日付フィールドを cleanIsoDate でサニタイズして返す
  return parsed.map((pg) => ({
    ...pg,
    acquired_date: cleanIsoDate(pg.acquired_date) || '',
    expiry_date:   cleanIsoDate(pg.expiry_date)   || '',
    birth_date:    cleanIsoDate(pg.birth_date)    || '',
  }));
}

// 同名が複数いる場合に生年月日で一意化するための氏名+生年月日突合ヘルパ。
// 返り値: { id, name, birth_date } | null。
// match_method: 'name_exact'（名前のみ一意）| 'name+birth'（同名複数を生年月日で絞込）| 'none'
function matchStaffWithBirth(personName, certBirthDate, staff) {
  const n = normalizePersonName(personName);
  if (!n) return { staffRecord: null, match_method: 'none', birth_mismatch: false };

  const hits = (staff || []).filter((s) => normalizePersonName(s.name) === n);
  if (hits.length === 0) return { staffRecord: null, match_method: 'none', birth_mismatch: false };

  if (hits.length === 1) {
    // 一意に特定。生年月日の不一致チェック（証書側に birth_date がある場合のみ）
    const s = hits[0];
    const mismatch = certBirthDate && s.birth_date ? (certBirthDate !== s.birth_date) : false;
    return { staffRecord: s, match_method: 'name_exact', birth_mismatch: mismatch };
  }

  // 同名が複数。certBirthDate があれば生年月日で絞り込む。
  if (certBirthDate) {
    const byBirth = hits.filter((s) => s.birth_date && s.birth_date === certBirthDate);
    if (byBirth.length === 1) {
      return { staffRecord: byBirth[0], match_method: 'name+birth', birth_mismatch: false };
    }
  }
  // 曖昧（同名複数かつ生年月日で一意化不可）→ null
  return { staffRecord: null, match_method: 'none', birth_mismatch: false };
}

// ページ配列から「証書（合格証明書・免許証・技能講習修了証・特別教育修了証など）」だけを
// 抽出してレコード化する純関数。
// 方針（2026-06-10 ユーザー指示）: 資格別一覧表（索引）や名簿(roster)は登録源にせず無視し、
//   証書1枚=1レコードとする。資格名は証書面の名称を採用し、氏名→社員 / 資格名→マスタ を突合する。
function reconcileCertPages(pages, staff, masters) {
  const sorted = [...pages].sort((a, b) => (a.page || 0) - (b.page || 0));
  const blank = () => ({
    cert_number: null, acquired_date: null, expiry_date: null, birth_date: null,
    honseki: null, issuer: null, birth_mismatch: false,
    cert_image_path: null, cert_image_url: null, cert_is_pdf: false, _page_index: null,
  });
  const applyStaff = (rec, name, birth) => {
    const m = matchStaffWithBirth(name, birth || null, staff);
    rec.matched_staff_id = m.staffRecord ? m.staffRecord.id : null;
    rec.matched_staff_name = m.staffRecord ? m.staffRecord.name : null;
    rec.match_method = m.match_method;
    rec.birth_mismatch = m.birth_mismatch;
  };
  const mkRec = (source, name, qualName) => ({
    source, person_name: (name || '').trim(),
    qualification_name: qualName,
    matched_qualification_id: matchQualificationId(qualName, masters),
    qualification_category: resolveQualCategory(qualName, masters),
    matched_staff_id: null, matched_staff_name: null, match_method: 'none', ...blank(),
  });

  const records = [];
  for (const pg of sorted) {
    if (pg.type !== 'certificate') continue; // index / roster / other は登録源にしない
    const qn = (pg.qualification_name || '').trim();
    const rec = mkRec('certificate', pg.person_name, qn);
    fillCertInfo(rec, pg, (pg.page || 1) - 1);
    applyStaff(rec, pg.person_name, pg.birth_date);
    records.push(rec);
  }
  return records;
}

// 証書情報をレコードに充填するヘルパ
function fillCertInfo(rec, pg, pageIndex) {
  rec.source = 'certificate';
  rec._page_index = pageIndex;
  if (pg.cert_number)    rec.cert_number    = pg.cert_number.trim();
  if (pg.acquired_date)  rec.acquired_date  = pg.acquired_date;
  if (pg.expiry_date)    rec.expiry_date    = pg.expiry_date;
  if (pg.birth_date)     rec.birth_date     = pg.birth_date;
  if (pg.honseki)        rec.honseki        = pg.honseki.trim();
  if (pg.issuer)         rec.issuer         = pg.issuer.trim();
  // qualification_name は証書面のものがあれば上書き（但し名簿見出し優先は roster 側で確定済み）
  if (!rec.qualification_name && pg.qualification_name) {
    rec.qualification_name = pg.qualification_name.trim();
  }
}

// 資格名からカテゴリを解決する（マスタ既存優先→既定'免許'）
function resolveQualCategory(qualName, masters) {
  const matched = masters.find((m) => matchQualificationId(qualName, [m]) === m.id);
  return matched ? matched.category : '免許';
}

// PDF の特定ページ（0始まりインデックス）を単一ページPDFとして抽出し Buffer で返す
async function extractPdfPage(pdfBuffer, pageIndex) {
  const src = await PDFDocument.load(pdfBuffer);
  const out = await PDFDocument.create();
  const [p] = await out.copyPages(src, [pageIndex]);
  out.addPage(p);
  const bytes = await out.save();
  return Buffer.from(bytes);
}

// ✅ 資格者証をアップロード→Geminiで読取→「氏名から社員」「資格名からマスタ」を自動突合して返す（管理者のみ）
//    社員を指定しない一括取込用（単体画像・束ねPDF どちらも受け付ける）。
//    DBには登録せず、フロントで担当社員・資格を確認してから保存する。
//    返り値: { records: [ { source, person_name, matched_staff_id, matched_staff_name, match_method,
//              qualification_name, matched_qualification_id, qualification_category,
//              cert_number, acquired_date, expiry_date, birth_date, honseki, issuer,
//              birth_mismatch, cert_image_path, cert_image_url, cert_is_pdf } ] }
app.post('/api/qualifications/scan', requireAuth, requireEmployeeAdmin, upload.single('cert'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'cert（資格者証の画像/PDF）が必要です' });

    // Gemini インライン上限対策: 概ね 20MB を超えるファイルは分割を求める
    const MAX_INLINE_BYTES = 20 * 1024 * 1024;
    if (req.file.size > MAX_INLINE_BYTES) {
      return res.status(413).json({ error: 'PDFのサイズが大きすぎます。20MB以下に分割してアップロードしてください。' });
    }

    const isPdf = req.file.mimetype === 'application/pdf';

    // 1) Gemini でページ配列を抽出
    const pages = await extractCertificatePages(req.file.buffer, req.file.mimetype);

    // 2) 社員マスタ・資格マスタを取得
    const [{ data: masters }, { data: staff }] = await Promise.all([
      supabase.from('qualification_master').select('id, name, category'),
      supabase.from('staff_master').select('id, name, birth_date, company'),
    ]);
    const staffById = new Map((staff || []).map((s) => [s.id, s]));

    // 3) ページ配列を再構成してレコード配列を得る。
    //    社員名簿に該当しない人（台帳未登録）は取り込まない方針のため、ここで除外する。
    const allRecords = reconcileCertPages(pages, staff || [], masters || []);
    const records = allRecords.filter((r) => r.matched_staff_id != null);

    // 4) 証書ページがある（_page_index が設定されている）レコードを保存（方針に従い Drive または Supabase）
    const ts = Date.now();

    await Promise.all(records.map(async (rec) => {
      if (rec._page_index == null) {
        // 名簿のみ（証書なし）→ アップロードしない
        return;
      }
      try {
        let uploadBuffer;
        let uploadMimeType;
        let certIsPdf;

        if (isPdf) {
          // PDF: 該当ページだけを単一ページPDFとして抽出
          uploadBuffer = await extractPdfPage(req.file.buffer, rec._page_index);
          uploadMimeType = 'application/pdf';
          certIsPdf = true;
        } else {
          // 画像: 元バッファをそのまま保存（1ページ扱い）
          uploadBuffer = req.file.buffer;
          uploadMimeType = req.file.mimetype;
          certIsPdf = false;
        }

        const ext = isPdf ? 'pdf' : (req.file.originalname.split('.').pop() || 'jpg').toLowerCase();
        const storagePath = await storeCert(
          `inbox/${ts}-${uuidv4()}.${ext}`,
          uploadBuffer,
          uploadMimeType,
          certFolderSegments(staffById.get(rec.matched_staff_id)),
        );

        rec.cert_image_path = storagePath;
        rec.cert_image_url  = await certSignedUrl(storagePath);
        rec.cert_is_pdf     = certIsPdf;
      } catch (upErr) {
        // アップロード失敗はレコード単位で無視（cert_image_path=null のまま続行）
        console.warn(`Warning: cert page upload failed (page ${rec._page_index + 1}):`, upErr.message);
      }
    }));

    // 内部管理用フィールド(_page_index)を除いて返す
    const responseRecords = records.map(({ _page_index, ...rest }) => rest);

    res.json({ records: responseRecords });
  } catch (error) {
    console.error('Error (qualification bundle scan):', error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ✅ 社員の資格を更新（管理者のみ）
app.put('/api/employees/:id/qualifications/:qid', requireAuth, requireEmployeeAdmin, async (req, res) => {
  try {
    const { acquired_date, expiry_date, cert_number, note } = req.body || {};
    const patch = { updated_at: new Date().toISOString() };
    if (acquired_date !== undefined) patch.acquired_date = acquired_date || null;
    if (expiry_date !== undefined) patch.expiry_date = expiry_date || null;
    if (cert_number !== undefined) patch.cert_number = cert_number || null;
    if (note !== undefined) patch.note = note || null;
    const { data, error } = await supabase
      .from('staff_qualifications')
      .update(patch)
      .eq('id', req.params.qid)
      .eq('staff_id', req.params.id)
      .select('*, qualification_master(name, category, has_expiry)');
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: '資格が見つかりません' });
    res.json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ 社員の資格を削除（管理者のみ）
app.delete('/api/employees/:id/qualifications/:qid', requireAuth, requireEmployeeAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from('staff_qualifications')
      .delete()
      .eq('id', req.params.qid)
      .eq('staff_id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ✅ 掲示板・お知らせ API（要認証）
//    - 閲覧: 宛先に一致する認証済みユーザー全員
//    - 既読/確認: 閲覧権限があれば可
//    - 管理（作成/編集/削除/到達率）: announcements の admin のみ
// ============================================================

// お知らせアプリにおける本人ロールを解決
//  - グローバル管理者（ADMIN_EMAILS / staff_master.app_role='admin'）は常に 'admin'
//  - それ以外は staff_app_permissions の 'announcements' を見る（admin / member / none）
async function resolveAnnouncementRole(email) {
  const perms = await resolvePermissions(email); // { role, staffId }
  if (perms.role === 'admin') return { role: 'admin', staffId: perms.staffId };
  let level = null;
  if (perms.staffId) {
    const { data } = await supabase
      .from('staff_app_permissions')
      .select('access_level')
      .eq('staff_id', perms.staffId)
      .eq('app_key', 'announcements')
      .maybeSingle();
    level = data?.access_level || null;
  }
  const role = level === 'admin' ? 'admin' : level ? 'member' : 'none';
  return { role, staffId: perms.staffId };
}

// お知らせ管理者のみ許可するミドルウェア（要 requireAuth 後段）
async function requireAnnouncementAdmin(req, res, next) {
  try {
    const r = await resolveAnnouncementRole(req.user?.email);
    if (r.role !== 'admin') {
      return res.status(403).json({ error: 'この操作はお知らせの管理者のみ可能です' });
    }
    req.annRole = r;
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// 現在ユーザーの staff_master から company / department を取得するヘルパー
async function resolveStaffProfile(email) {
  const lower = String(email || '').toLowerCase();
  const { data } = await supabase
    .from('staff_master')
    .select('id, company, department')
    .ilike('email', lower)
    .maybeSingle();
  return {
    staffId: data?.id || null,
    company: data?.company || null,
    department: data?.department || null,
  };
}

// お知らせの宛先一致チェック（target_type='all' は全員 / company / department は targets 配列で突合）
// targets: announcement_targets の配列 [{kind, value}]
function isAudienceMatch(ann, targets, profile) {
  if (ann.target_type === 'all') return true;
  return (targets || []).some((t) => {
    if (t.kind === 'company') return t.value === profile.company;
    if (t.kind === 'department') return t.value === profile.department;
    return false;
  });
}

// ── お知らせ添付ファイル（非公開バケット + 署名URL）───────────────
const ANNOUNCEMENT_BUCKET = 'announcement-files';
let announcementBucketEnsured = false;
async function ensureAnnouncementBucket() {
  if (announcementBucketEnsured) return;
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw error;
  if (!buckets?.some((b) => b.name === ANNOUNCEMENT_BUCKET)) {
    const { error: createError } = await supabase.storage.createBucket(ANNOUNCEMENT_BUCKET, { public: false });
    if (createError && !/exist/i.test(createError.message || '')) throw createError;
  }
  announcementBucketEnsured = true;
}

// ✅ お知らせ - 添付ファイルのアップロード（管理者のみ）
//    本体作成前にフロントから呼ばれ、返した {name, path, size} を attachments 配列に積んで作成/更新時に送る。
app.post('/api/announcements/upload-file', requireAuth, requireAnnouncementAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file フィールドが必要です' });
    await ensureAnnouncementBucket();

    const originalName = decodeUploadName(req.file.originalname); // 日本語ファイル名の文字化け補正
    const ext = (originalName.split('.').pop() || 'bin').toLowerCase();
    const path = `files/${Date.now()}-${uuidv4()}.${ext}`;

    const { error: upErr } = await supabase.storage
      .from(ANNOUNCEMENT_BUCKET)
      .upload(path, req.file.buffer, { contentType: req.file.mimetype });
    if (upErr) throw upErr;

    res.json({ name: originalName, path, size: req.file.size });
  } catch (error) {
    console.error('Error (announcement upload):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ お知らせ - 添付ファイルの署名付きダウンロードURL（閲覧権限者のみ・120秒有効）
//    ?path=... が当該お知らせの attachments に含まれるか検証してから署名する（任意パス署名を防止）。
app.get('/api/announcements/:id/attachment-url', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const path = req.query.path;
    if (!path) return res.status(400).json({ error: 'path が必要です' });

    const email = String(req.user.email || '').toLowerCase();
    const annRole = await resolveAnnouncementRole(email);

    const { data: ann, error } = await supabase
      .from('announcements')
      .select('id, target_type, attachments')
      .eq('id', id)
      .eq('is_active', true)
      .maybeSingle();
    if (error) throw error;
    if (!ann) return res.status(404).json({ error: 'お知らせが見つかりません' });

    // 閲覧権限チェック（admin はスキップ）
    if (annRole.role !== 'admin') {
      const { data: targets } = await supabase
        .from('announcement_targets')
        .select('kind, value')
        .eq('announcement_id', id);
      const profile = await resolveStaffProfile(email);
      if (!isAudienceMatch(ann, targets || [], profile)) {
        return res.status(403).json({ error: 'このお知らせへのアクセス権がありません' });
      }
    }

    // 指定パスが本当にこのお知らせの添付かを検証
    const att = (ann.attachments || []).find((a) => a && a.path === path);
    if (!att) return res.status(404).json({ error: '添付ファイルが見つかりません' });

    const { data, error: sErr } = await supabase.storage
      .from(ANNOUNCEMENT_BUCKET)
      .createSignedUrl(path, 120);
    if (sErr) throw sErr;

    res.json({ url: data.signedUrl, name: att.name });
  } catch (error) {
    console.error('Error (announcement attachment url):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── WorkScope 配布（インストーラー配布 + 利用ログ）──────────────────
//    ポータルを WorkScope（PC業務記録ツール）の配布入口にする。
//    インストーラーzipは非公開バケット 'app-downloads' に置き、署名URLで配布する。
//    現行版は workscope_release の最新行。ダウンロードは workscope_downloads に記録する。
const APP_DOWNLOADS_BUCKET = 'app-downloads';
let appDownloadsBucketEnsured = false;
async function ensureAppDownloadsBucket() {
  if (appDownloadsBucketEnsured) return;
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw error;
  if (!buckets?.some((b) => b.name === APP_DOWNLOADS_BUCKET)) {
    const { error: createError } = await supabase.storage.createBucket(APP_DOWNLOADS_BUCKET, { public: false });
    if (createError && !/exist/i.test(createError.message || '')) throw createError;
  }
  appDownloadsBucketEnsured = true;
}

// 現行（最新）の WorkScope リリースを1件返すヘルパー（無ければ null）
async function getLatestWorkscopeRelease() {
  const { data, error } = await supabase
    .from('workscope_release')
    .select('id, version, file_path, file_size, notes, uploaded_at')
    .order('uploaded_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// ✅ WorkScope - 現行インストーラーの情報（要認証・全社員）
//    フロントの導入ページが配布有無・版・サイズ・自分の前回DL日時を表示するために使う。
app.get('/api/downloads/workscope/info', requireAuth, async (req, res) => {
  try {
    const release = await getLatestWorkscopeRelease();
    let myLast = null;
    try {
      const { data } = await supabase
        .from('workscope_downloads')
        .select('created_at, version')
        .ilike('user_email', String(req.user.email || '').toLowerCase())
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      myLast = data || null;
    } catch (_) { /* ログ未取得でも情報表示は妨げない */ }

    res.json({
      available: !!release,
      version: release?.version || null,
      file_size: release?.file_size || null,
      uploaded_at: release?.uploaded_at || null,
      notes: release?.notes || null,
      my_last_download_at: myLast?.created_at || null,
    });
  } catch (error) {
    console.error('Error (workscope info):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ WorkScope - インストーラーのダウンロード（要認証・全社員）
//    署名URLを発行しつつ、誰が導入したかを workscope_downloads に記録する。
app.get('/api/downloads/workscope/file', requireAuth, async (req, res) => {
  try {
    const release = await getLatestWorkscopeRelease();
    if (!release) return res.status(404).json({ error: 'インストーラーがまだ登録されていません' });

    // ストレージから zip 本体を取得
    const { data: blob, error: dErr } = await supabase.storage
      .from(APP_DOWNLOADS_BUCKET)
      .download(release.file_path);
    if (dErr) throw dErr;
    const zipBuf = Buffer.from(await blob.arrayBuffer());

    // ログイン中の本人情報で identity を解決（社員一覧の氏名を優先、無ければGoogleアカウント名）
    const email = req.user.email;
    let name = req.user.name || '';
    let staffId = null;
    try {
      const { data: staff } = await supabase
        .from('staff_master')
        .select('id, name')
        .ilike('email', String(email).toLowerCase())
        .maybeSingle();
      if (staff) {
        staffId = staff.id;
        if (staff.name) name = staff.name;
      }
    } catch (_) { /* 社員一覧に無くてもGoogleアカウント名で続行 */ }

    // zip に src/identity.json を埋め込む（インストーラが氏名/メール入力を省略するため）。
    // 失敗しても元zipをそのまま配る（手入力フォームにフォールバックできる）。
    let outBuf = zipBuf;
    try {
      const zip = await JSZip.loadAsync(zipBuf);
      zip.file('src/identity.json', JSON.stringify({ employee_name: name, email }, null, 2));
      outBuf = await zip.generateAsync({ type: 'nodebuffer' });
    } catch (zErr) {
      console.error('Error (workscope identity inject):', zErr.message);
    }

    // 利用ログを記録（失敗してもダウンロード自体は妨げない）
    try {
      const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      await supabase.from('workscope_downloads').insert({
        user_email: email,
        user_name: name,
        staff_id: staffId,
        version: release.version,
        ip: fwd || req.ip || null,
        user_agent: req.headers['user-agent'] || null,
      });
    } catch (logErr) {
      console.error('Error (workscope download log):', logErr.message);
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="WorkScope_setup.zip"');
    res.send(outBuf);
  } catch (error) {
    console.error('Error (workscope download):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ WorkScope - 本人の導入状況（初回アクセス時の必須ポップアップ判定）
//    required=true の間、フロントは画面をふさぐ導入モーダルを表示する。
//    判定: インストーラ配布中 かつ 本人が未DL かつ 管理者でない → 必須。
app.get('/api/downloads/workscope/my-status', requireAuth, async (req, res) => {
  try {
    const release = await getLatestWorkscopeRelease();
    const email = String(req.user.email || '').toLowerCase();

    let downloaded = false;
    try {
      const { count } = await supabase
        .from('workscope_downloads')
        .select('id', { count: 'exact', head: true })
        .ilike('user_email', email);
      downloaded = (count || 0) > 0;
    } catch (_) { /* 取得失敗時は未DL扱いにしない（誤ブロック回避のため後段で安全側） */ }

    let isAdmin = false;
    try {
      const perms = await resolvePermissions(req.user.email);
      isAdmin = perms.role === 'admin';
    } catch (_) {}

    res.json({
      available: !!release,
      downloaded,
      is_admin: isAdmin,
      required: !!release && !downloaded && !isAdmin,
    });
  } catch (error) {
    console.error('Error (workscope my-status):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ WorkScope - 利用規約の同意を中央記録（ダウンロード前にフロントから呼ぶ）
//    社員PCの config.json だけでなく、誰がいつどの版に同意したかをサーバに残す。
app.post('/api/downloads/workscope/consent', requireAuth, async (req, res) => {
  try {
    const email = req.user.email;
    let name = req.user.name || '';
    let staffId = null;
    try {
      const { data: staff } = await supabase
        .from('staff_master')
        .select('id, name')
        .ilike('email', String(email).toLowerCase())
        .maybeSingle();
      if (staff) { staffId = staff.id; if (staff.name) name = staff.name; }
    } catch (_) { /* 社員一覧に無くても記録は残す */ }

    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const { error } = await supabase.from('workscope_consents').insert({
      user_email: email,
      user_name: name,
      staff_id: staffId,
      eula_version: String(req.body?.eula_version || '').slice(0, 40) || null,
      ip: fwd || req.ip || null,
      user_agent: req.headers['user-agent'] || null,
    });
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) {
    console.error('Error (workscope consent):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ WorkScope - 同意状況の一覧（管理者のみ）。社員ごとの最新同意＋未同意者を返す。
app.get('/api/admin/workscope/consents', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from('workscope_consents')
      .select('user_email, user_name, eula_version, agreed_at')
      .order('agreed_at', { ascending: false });
    if (error) throw error;

    const byEmail = new Map();
    for (const r of (rows || [])) {
      const k = String(r.user_email || '').toLowerCase();
      if (!k || byEmail.has(k)) continue;
      byEmail.set(k, { email: r.user_email, name: r.user_name, eula_version: r.eula_version, agreed_at: r.agreed_at });
    }
    const consented = [...byEmail.values()];
    const consentedSet = new Set(byEmail.keys());

    let notConsented = [];
    try {
      const { data: staff } = await supabase
        .from('staff_master')
        .select('name, email, department, is_active');
      notConsented = (staff || [])
        .filter((s) => s.is_active !== false && s.email)
        .filter((s) => !consentedSet.has(String(s.email).toLowerCase()))
        .map((s) => ({ name: s.name, email: s.email, department: s.department }));
    } catch (_) { /* 名簿未整備でも返す */ }

    res.json({ total: consented.length, consented, not_consented: notConsented });
  } catch (error) {
    console.error('Error (workscope consents admin):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ WorkScope - インストーラーのアップロード/更新（管理者のみ）
//    zip をバケットに保存し、workscope_release に新しい現行版として1行追加する。
app.post('/api/admin/workscope/release', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file フィールド（インストーラーzip）が必要です' });
    const version = String(req.body.version || '').trim();
    if (!version) return res.status(400).json({ error: 'version（バージョン表記）が必要です' });
    await ensureAppDownloadsBucket();

    const path = `workscope/${Date.now()}-${uuidv4()}.zip`;
    const { error: upErr } = await supabase.storage
      .from(APP_DOWNLOADS_BUCKET)
      .upload(path, req.file.buffer, { contentType: req.file.mimetype || 'application/zip' });
    if (upErr) throw upErr;

    const { data, error: insErr } = await supabase
      .from('workscope_release')
      .insert({
        version,
        file_path: path,
        file_size: req.file.size,
        notes: req.body.notes || null,
        uploaded_by: req.user.email,
      })
      .select()
      .maybeSingle();
    if (insErr) throw insErr;

    res.json(data);
  } catch (error) {
    console.error('Error (workscope release upload):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ WorkScope - 導入状況の集計（管理者のみ）
//    「誰が導入済み / 未導入か」を staff_master（在籍者）と突合して返す。
app.get('/api/admin/workscope/downloads', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data: logs, error } = await supabase
      .from('workscope_downloads')
      .select('user_email, user_name, staff_id, version, created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;

    // メールごとに集計（最新DL日時・回数・最終版）
    const byEmail = new Map();
    for (const r of (logs || [])) {
      const key = String(r.user_email || '').toLowerCase();
      if (!key) continue;
      if (!byEmail.has(key)) {
        byEmail.set(key, {
          email: r.user_email,
          name: r.user_name,
          last_at: r.created_at,
          version: r.version,
          count: 1,
        });
      } else {
        byEmail.get(key).count += 1;
      }
    }
    const downloaded = [...byEmail.values()];
    const downloadedSet = new Set(byEmail.keys());

    // 在籍社員のうち未導入の人を抽出
    let notDownloaded = [];
    try {
      const { data: staff } = await supabase
        .from('staff_master')
        .select('name, email, department, is_active');
      notDownloaded = (staff || [])
        .filter((s) => s.is_active !== false && s.email)
        .filter((s) => !downloadedSet.has(String(s.email).toLowerCase()))
        .map((s) => ({ name: s.name, email: s.email, department: s.department }));
    } catch (_) { /* 名簿未整備でも集計は返す */ }

    res.json({
      total_downloads: (logs || []).length,
      unique_users: downloaded.length,
      not_downloaded_count: notDownloaded.length,
      downloaded,
      not_downloaded: notDownloaded,
    });
  } catch (error) {
    console.error('Error (workscope downloads admin):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ お知らせ一覧（GET /api/announcements）
//    ?category=xxx  カテゴリで絞り込み
//    ?unread_only=1 未読のみ
//    ?manage=1      管理者用: 未公開/期限切れ/宛先フィルタなし・全件
app.get('/api/announcements', requireAuth, async (req, res) => {
  try {
    const email = String(req.user.email || '').toLowerCase();
    const annRole = await resolveAnnouncementRole(email);
    const profile = await resolveStaffProfile(email);
    const isManage = req.query.manage === '1' && annRole.role === 'admin';
    const now = new Date().toISOString();

    // お知らせ本体を取得
    let query = supabase
      .from('announcements')
      .select('*')
      .eq('is_active', true)
      .order('is_pinned', { ascending: false })
      .order('publish_at', { ascending: false });

    if (!isManage) {
      query = query.lte('publish_at', now);
      // expire_at フィルタはJS側で処理（NULL OR > now）
    }
    if (req.query.category) {
      query = query.eq('category', req.query.category);
    }

    const { data: rows, error } = await query;
    if (error) throw error;
    const announcements = rows || [];

    // 宛先一覧を一括取得（対象アナウンスIDのみ）
    const annIds = announcements.map((a) => a.id);
    let targetsMap = {};
    if (annIds.length > 0) {
      const { data: tRows, error: tErr } = await supabase
        .from('announcement_targets')
        .select('announcement_id, kind, value')
        .in('announcement_id', annIds);
      if (tErr) throw tErr;
      for (const t of tRows || []) {
        (targetsMap[t.announcement_id] ||= []).push(t);
      }
    }

    // 既読状況を一括取得
    let readsMap = {};
    if (annIds.length > 0) {
      const { data: rRows, error: rErr } = await supabase
        .from('announcement_reads')
        .select('announcement_id, read_at, acknowledged_at')
        .eq('user_email', email)
        .in('announcement_id', annIds);
      if (rErr) throw rErr;
      for (const r of rRows || []) {
        readsMap[r.announcement_id] = r;
      }
    }

    // フィルタ・整形
    const result = [];
    for (const ann of announcements) {
      // 期限切れチェック（管理モードでない場合）
      if (!isManage && ann.expire_at && ann.expire_at <= now) continue;
      // 宛先フィルタ（管理モードでない場合）
      if (!isManage && !isAudienceMatch(ann, targetsMap[ann.id] || [], profile)) continue;

      const readInfo = readsMap[ann.id] || null;
      const is_read = !!readInfo?.read_at;
      const is_acknowledged = !!readInfo?.acknowledged_at;

      // unread_only フィルタ
      if (req.query.unread_only === '1' && is_read) continue;

      result.push({ ...ann, is_read, is_acknowledged });
    }

    res.json(result);
  } catch (error) {
    console.error('Error (announcements list):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 未読件数（GET /api/announcements/unread-count）← 固定パスのため :id より前に定義
app.get('/api/announcements/unread-count', requireAuth, async (req, res) => {
  try {
    const email = String(req.user.email || '').toLowerCase();
    const profile = await resolveStaffProfile(email);
    const now = new Date().toISOString();

    const { data: rows, error } = await supabase
      .from('announcements')
      .select('id, target_type, expire_at')
      .eq('is_active', true)
      .lte('publish_at', now);
    if (error) throw error;
    const announcements = rows || [];

    const annIds = announcements.map((a) => a.id);
    let targetsMap = {};
    if (annIds.length > 0) {
      const { data: tRows, error: tErr } = await supabase
        .from('announcement_targets')
        .select('announcement_id, kind, value')
        .in('announcement_id', annIds);
      if (tErr) throw tErr;
      for (const t of tRows || []) {
        (targetsMap[t.announcement_id] ||= []).push(t);
      }
    }

    // 既読済みの ID セットを取得
    let readIds = new Set();
    if (annIds.length > 0) {
      const { data: rRows, error: rErr } = await supabase
        .from('announcement_reads')
        .select('announcement_id')
        .eq('user_email', email)
        .not('read_at', 'is', null)
        .in('announcement_id', annIds);
      if (rErr) throw rErr;
      for (const r of rRows || []) readIds.add(r.announcement_id);
    }

    let count = 0;
    for (const ann of announcements) {
      if (ann.expire_at && ann.expire_at <= now) continue;
      if (!isAudienceMatch(ann, targetsMap[ann.id] || [], profile)) continue;
      if (!readIds.has(ann.id)) count++;
    }

    res.json({ count });
  } catch (error) {
    console.error('Error (unread-count):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ お知らせ詳細（GET /api/announcements/:id）
app.get('/api/announcements/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const email = String(req.user.email || '').toLowerCase();
    const annRole = await resolveAnnouncementRole(email);
    const profile = await resolveStaffProfile(email);

    const { data: ann, error } = await supabase
      .from('announcements')
      .select('*')
      .eq('id', id)
      .eq('is_active', true)
      .maybeSingle();
    if (error) throw error;
    if (!ann) return res.status(404).json({ error: 'お知らせが見つかりません' });

    const { data: targets, error: tErr } = await supabase
      .from('announcement_targets')
      .select('id, kind, value')
      .eq('announcement_id', id);
    if (tErr) throw tErr;

    // 閲覧権限チェック（admin はスキップ）
    if (annRole.role !== 'admin') {
      if (!isAudienceMatch(ann, targets || [], profile)) {
        return res.status(403).json({ error: 'このお知らせへのアクセス権がありません' });
      }
    }

    const { data: readRow } = await supabase
      .from('announcement_reads')
      .select('read_at, acknowledged_at')
      .eq('announcement_id', id)
      .eq('user_email', email)
      .maybeSingle();

    res.json({
      ...ann,
      targets: targets || [],
      is_read: !!readRow?.read_at,
      is_acknowledged: !!readRow?.acknowledged_at,
    });
  } catch (error) {
    console.error('Error (announcement detail):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 既読登録（POST /api/announcements/:id/read）
app.post('/api/announcements/:id/read', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const email = String(req.user.email || '').toLowerCase();
    const now = new Date().toISOString();

    const { error } = await supabase
      .from('announcement_reads')
      .upsert(
        { announcement_id: Number(id), user_email: email, read_at: now },
        { onConflict: 'announcement_id,user_email' }
      );
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) {
    console.error('Error (announcement read):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 確認（acknowledge）登録（POST /api/announcements/:id/acknowledge）
app.post('/api/announcements/:id/acknowledge', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const email = String(req.user.email || '').toLowerCase();
    const now = new Date().toISOString();

    // 既存行を確認（read_at が null なら同時にセット）
    const { data: existing } = await supabase
      .from('announcement_reads')
      .select('id, read_at')
      .eq('announcement_id', id)
      .eq('user_email', email)
      .maybeSingle();

    const upsertData = {
      announcement_id: Number(id),
      user_email: email,
      acknowledged_at: now,
      read_at: existing?.read_at || now,
    };

    const { error } = await supabase
      .from('announcement_reads')
      .upsert(upsertData, { onConflict: 'announcement_id,user_email' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) {
    console.error('Error (announcement acknowledge):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 到達率（GET /api/announcements/:id/reads）※ 管理者のみ
app.get('/api/announcements/:id/reads', requireAuth, requireAnnouncementAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // お知らせ本体を取得（宛先種別・values を確認するため）
    const { data: ann, error: annErr } = await supabase
      .from('announcements')
      .select('id, target_type')
      .eq('id', id)
      .eq('is_active', true)
      .maybeSingle();
    if (annErr) throw annErr;
    if (!ann) return res.status(404).json({ error: 'お知らせが見つかりません' });

    // 宛先リスト
    const { data: targets, error: tErr } = await supabase
      .from('announcement_targets')
      .select('kind, value')
      .eq('announcement_id', id);
    if (tErr) throw tErr;

    // 受信対象者の絞り込み
    //   target_type='all': is_active=true かつ email が NOT NULL の全社員
    //   company / department: さらに値で絞る
    let staffQuery = supabase
      .from('staff_master')
      .select('id, name, email')
      .eq('is_active', true)
      .not('email', 'is', null);

    const targetRows = targets || [];
    if (ann.target_type !== 'all' && targetRows.length > 0) {
      // company / department フィルタ（OR結合）
      const companyValues = targetRows.filter((t) => t.kind === 'company').map((t) => t.value);
      const deptValues = targetRows.filter((t) => t.kind === 'department').map((t) => t.value);
      // Supabase JS では OR フィルタを or() で指定
      const orParts = [];
      if (companyValues.length > 0) orParts.push(`company.in.(${companyValues.map((v) => `"${v}"`).join(',')})`);
      if (deptValues.length > 0) orParts.push(`department.in.(${deptValues.map((v) => `"${v}"`).join(',')})`);
      if (orParts.length > 0) staffQuery = staffQuery.or(orParts.join(','));
    }

    const { data: staffRows, error: sErr } = await staffQuery;
    if (sErr) throw sErr;
    const staff = staffRows || [];

    // 既読情報を一括取得
    const { data: readRows, error: rErr } = await supabase
      .from('announcement_reads')
      .select('user_email, read_at, acknowledged_at')
      .eq('announcement_id', id);
    if (rErr) throw rErr;

    const readByEmail = {};
    for (const r of readRows || []) readByEmail[r.user_email] = r;

    // 受信者リストに既読情報をマージ
    const recipients = staff.map((s) => {
      const r = readByEmail[String(s.email || '').toLowerCase()] || null;
      return {
        user_email: s.email,
        name: s.name,
        read_at: r?.read_at || null,
        acknowledged_at: r?.acknowledged_at || null,
      };
    });

    const read_count = recipients.filter((r) => r.read_at).length;
    const ack_count = recipients.filter((r) => r.acknowledged_at).length;

    res.json({
      targets_total: staff.length,
      read_count,
      ack_count,
      recipients,
    });
  } catch (error) {
    console.error('Error (announcement reads):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ お知らせ作成（POST /api/announcements）※ 管理者のみ
app.post('/api/announcements', requireAuth, requireAnnouncementAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title?.trim()) return res.status(400).json({ error: 'タイトルは必須です' });

    const row = {
      title: b.title.trim(),
      body: b.body || null,
      category: b.category || null,
      priority: ['low', 'normal', 'high', 'urgent'].includes(b.priority) ? b.priority : 'normal',
      target_type: ['all', 'company', 'department'].includes(b.target_type) ? b.target_type : 'all',
      is_pinned: !!b.is_pinned,
      requires_ack: !!b.requires_ack,
      publish_at: b.publish_at || new Date().toISOString(),
      expire_at: b.expire_at || null,
      attachments: Array.isArray(b.attachments) ? b.attachments : [],
      author_email: req.user.email,
      author_name: req.user.name || null,
      is_active: true,
    };

    const { data, error } = await supabase
      .from('announcements')
      .insert([row])
      .select();
    if (error) throw error;
    const ann = data[0];

    // 宛先が company / department の場合は targets を挿入
    if (ann.target_type !== 'all' && Array.isArray(b.targets) && b.targets.length > 0) {
      const targetRows = b.targets
        .filter((t) => t && ['company', 'department'].includes(t.kind) && t.value)
        .map((t) => ({ announcement_id: ann.id, kind: t.kind, value: t.value }));
      if (targetRows.length > 0) {
        const { error: tErr } = await supabase.from('announcement_targets').insert(targetRows);
        if (tErr) throw tErr;
      }
    }

    res.json(ann);
  } catch (error) {
    console.error('Error (announcement create):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ お知らせ更新（PUT /api/announcements/:id）※ 管理者のみ
app.put('/api/announcements/:id', requireAuth, requireAnnouncementAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body || {};

    const { data: existing, error: existErr } = await supabase
      .from('announcements')
      .select('id, target_type')
      .eq('id', id)
      .eq('is_active', true)
      .maybeSingle();
    if (existErr) throw existErr;
    if (!existing) return res.status(404).json({ error: 'お知らせが見つかりません' });

    const allowed = ['title', 'body', 'category', 'priority', 'target_type', 'is_pinned',
      'requires_ack', 'publish_at', 'expire_at', 'attachments'];
    const patch = { updated_at: new Date().toISOString() };
    for (const k of allowed) {
      if (b[k] !== undefined) patch[k] = b[k];
    }
    // priority / target_type のバリデーション
    if (patch.priority !== undefined && !['low', 'normal', 'high', 'urgent'].includes(patch.priority)) {
      patch.priority = 'normal';
    }
    if (patch.target_type !== undefined && !['all', 'company', 'department'].includes(patch.target_type)) {
      patch.target_type = 'all';
    }

    const { data, error } = await supabase
      .from('announcements')
      .update(patch)
      .eq('id', id)
      .select();
    if (error) throw error;
    const ann = data[0];

    // targets が渡されたら入れ替え（既存削除 → 再挿入）
    if (b.targets !== undefined) {
      await supabase.from('announcement_targets').delete().eq('announcement_id', id);
      const newTargetType = ann.target_type;
      if (newTargetType !== 'all' && Array.isArray(b.targets) && b.targets.length > 0) {
        const targetRows = b.targets
          .filter((t) => t && ['company', 'department'].includes(t.kind) && t.value)
          .map((t) => ({ announcement_id: ann.id, kind: t.kind, value: t.value }));
        if (targetRows.length > 0) {
          const { error: tErr } = await supabase.from('announcement_targets').insert(targetRows);
          if (tErr) throw tErr;
        }
      }
    }

    res.json(ann);
  } catch (error) {
    console.error('Error (announcement update):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ お知らせ論理削除（DELETE /api/announcements/:id）※ 管理者のみ
app.delete('/api/announcements/:id', requireAuth, requireAnnouncementAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('announcements')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id');
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: 'お知らせが見つかりません' });
    res.json({ ok: true });
  } catch (error) {
    console.error('Error (announcement delete):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 入札案件管理 API（all: requireAuth + requireBidAccess）
// ============================================================

const BID_BUCKET = 'bid-documents';
const BID_STATUSES = ['collecting', 'judging', 'estimating', 'bid', 'won', 'lost', 'contracted', 'declined'];
// 進行中（KPI: in_progress）とみなすステータス
const BID_IN_PROGRESS = ['collecting', 'judging', 'estimating', 'bid'];
// 「未入札」（期限間近判定の対象）
const BID_NOT_YET_BID = ['collecting', 'judging', 'estimating'];

// 現在のJST日付（YYYY-MM-DD）
function jstToday() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// staff_id→name のマップを取得
async function loadStaffNameMap() {
  const { data } = await supabase.from('staff_master').select('id, name');
  const map = {};
  for (const s of data || []) map[s.id] = s.name;
  return map;
}

// 期間レンジを算出（fy=年度4-3月 / cy=暦年 / custom=from,to）。返り値 { from, to }（YYYY-MM-DD）
function resolveBidPeriod(period, from, to) {
  const today = jstToday();
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  if (period === 'custom' && from && to) return { from, to };
  if (period === 'cy') return { from: `${y}-01-01`, to: `${y}-12-31` };
  // 既定: 年度（4月開始）
  const startY = m >= 4 ? y : y - 1;
  return { from: `${startY}-04-01`, to: `${startY + 1}-03-31` };
}

// 文字列から数字のみ抽出して整数化（予定価格など）。数字が無ければ null。
function digitsOrNull(s) {
  const digits = String(s ?? '').replace(/[^0-9]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

// AI 読取の対象にする「主要書類」を自動で絞り込む。
// 案件情報が載りやすい書類（指名通知・公告・設計書 等）を優先し、
// 図面など大容量・情報の薄い資料は除外する。返すのは PDF/画像のみ。
const BID_DOC_KEYWORDS = ['指名通知', '通知', '公告', '入札公告', '入札説明', '案内', '設計書', '設計図書', '特記', '仕様', '概要', '内訳', '現場説明', '入札'];
const BID_DOC_EXCLUDE = ['図面', 'リーフレット', '参考例', '別紙', '質問書', '記載例', '取扱要領', '届出', 'ランダム', '改正'];
function selectBidDocsForAI(files) {
  const MAX_FILE = 15 * 1024 * 1024;   // 1ファイル上限（これ超は図面等とみなし対象外）
  const MAX_TOTAL = 18 * 1024 * 1024;  // Gemini インライン合計上限の安全圏
  const MAX_COUNT = 3;

  const candidates = (files || []).filter(
    (f) => (f.mimetype === 'application/pdf' || f.mimetype.startsWith('image/')) && f.size <= MAX_FILE
  );
  const scored = candidates.map((f) => {
    const nm = f.originalname || '';
    let score = 0;
    for (const k of BID_DOC_KEYWORDS) if (nm.includes(k)) score += 2;
    for (const k of BID_DOC_EXCLUDE) if (nm.includes(k)) score -= 1;
    return { f, score };
  });
  // スコア降順 → 同点は小さいファイル優先（テキスト書類は概して小さい）
  scored.sort((a, b) => b.score - a.score || a.f.size - b.f.size);

  const picked = [];
  let total = 0;
  for (const { f } of scored) {
    if (picked.length >= MAX_COUNT) break;
    if (total + f.size > MAX_TOTAL) continue;
    picked.push(f);
    total += f.size;
  }
  // 合計上限で全部弾かれた場合でも、最小のものを最低1つは読む
  if (picked.length === 0 && candidates.length) {
    picked.push([...candidates].sort((a, b) => a.size - b.size)[0]);
  }
  return picked;
}

// 入札資料（PDF/画像）を Gemini で解析し、案件登録用フィールドを構造化して返す。
async function extractBidInfo(files) {
  if (!GEMINI_API_KEY) {
    const e = new Error('GEMINI_API_KEY が未設定です。Render の環境変数に設定してください。');
    e.status = 503;
    throw e;
  }
  const prompt = [
    'これは日本の公共工事「入札案件」に関する書類（指名通知書・入札公告・設計書・特記仕様書など）です。',
    '記載内容を読み取り、入札案件の登録に必要な項目を JSON で返してください。',
    '- project_name: 工事名（正式名称。例: 銘地区復旧治山工事）',
    '- client_name: 発注者（例: 長崎県、○○市、△△県土木事務所）',
    '- location: 工事場所（住所・地区名など）',
    '- work_type: 工種（例: 治山 / 道路 / 橋梁 / 舗装 / 河川。工事名等から判断できる代表的な工種を短く）',
    '- bid_method: 入札方式（例: 一般競争入札 / 指名競争入札 / 随意契約）',
    '- notice_date: 公告日または指名通知日（YYYY-MM-DD）',
    '- question_due: 質問書の提出期限（YYYY-MM-DD）',
    '- bid_start_date: 入札開始日（札入れ期間の開始。「入札開始日時」等。札入れに期間がある場合のみ。単日入札や記載なしは空文字）（YYYY-MM-DD）',
    '- bid_date: 入札締切日（入札書提出締切日。「入札書提出締切日時」等。札入れに期間がある場合は締切日、単日入札ならその入札日）（YYYY-MM-DD）',
    '- opening_date: 開札日（「開札予定日時」等。YYYY-MM-DD）',
    '- budget_price: 予定価格（円。半角数字のみ。公表されている場合のみ。非公表・記載なしは空文字）',
    '- remarks: 備考（「備考」欄に記載された内容をそのまま転記。なければ空文字）',
    '- reason: 理由（「理由」欄に記載された内容をそのまま転記。なければ空文字）',
    '- summary: 工事概要を1〜2文で（任意）',
    '日付が和暦（令和・平成等）の場合は西暦に変換してください。時刻が併記されていても日付のみ抽出してください。',
    '読み取れない項目は空文字にし、推測で埋めないでください。',
    '複数の書類がある場合は内容を突き合わせ、最も確からしい値を返してください。',
  ].join('\n');

  const parts = [{ text: prompt }];
  for (const f of files) {
    parts.push({ inlineData: { mimeType: f.mimetype || 'application/pdf', data: f.buffer.toString('base64') } });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          project_name: { type: 'STRING' },
          client_name: { type: 'STRING' },
          location: { type: 'STRING' },
          work_type: { type: 'STRING' },
          bid_method: { type: 'STRING' },
          notice_date: { type: 'STRING' },
          question_due: { type: 'STRING' },
          bid_start_date: { type: 'STRING' },
          bid_date: { type: 'STRING' },
          opening_date: { type: 'STRING' },
          budget_price: { type: 'STRING' },
          remarks: { type: 'STRING' },
          reason: { type: 'STRING' },
          summary: { type: 'STRING' },
        },
        required: ['project_name'],
      },
    },
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text();
    const e = new Error(`Gemini API エラー (${resp.status}): ${t.slice(0, 300)}`);
    e.status = 502;
    throw e;
  }
  const json = await resp.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini から有効な応答が得られませんでした');
  let p;
  try { p = JSON.parse(text); } catch { throw new Error('Gemini 応答の解析に失敗しました'); }

  return {
    project_name: (p.project_name || '').trim(),
    client_name: (p.client_name || '').trim(),
    location: (p.location || '').trim(),
    work_type: (p.work_type || '').trim(),
    bid_method: (p.bid_method || '').trim(),
    notice_date: cleanIsoDate(p.notice_date),
    question_due: cleanIsoDate(p.question_due),
    bid_start_date: cleanIsoDate(p.bid_start_date),
    bid_date: cleanIsoDate(p.bid_date),
    opening_date: cleanIsoDate(p.opening_date),
    budget_price: digitsOrNull(p.budget_price),
    remarks: (p.remarks || '').trim(),
    reason: (p.reason || '').trim(),
    note: (p.summary || '').trim(),
  };
}

// ✅ 入札 - KPI・分析集計（/:id より先に定義してルート衝突を防ぐ）
app.get('/api/bids/stats', requireAuth, requireBidAccess, async (req, res) => {
  try {
    const { period = 'fy', from, to, group_by = 'client' } = req.query;
    const range = resolveBidPeriod(period, from, to);
    const today = jstToday();

    const { data: rows, error } = await supabase
      .from('bid_projects')
      .select('*')
      .eq('is_active', true);
    if (error) throw error;
    const all = rows || [];

    // サマリ（進行中・今月入札・期限間近は現時点ベース、落札率は期間ベース）
    const inProgress = all.filter((b) => BID_IN_PROGRESS.includes(b.status));
    const estimating = all.filter((b) => b.status === 'estimating');
    const ym = today.slice(0, 7);
    const bidsThisMonth = all.filter((b) => b.bid_date && b.bid_date.slice(0, 7) === ym);

    // 次の入札（今日以降で最も近い入札日の未入札案件）
    const upcoming = inProgress
      .filter((b) => b.bid_date && b.bid_date >= today)
      .sort((a, b) => a.bid_date.localeCompare(b.bid_date));
    const nextBid = upcoming[0]
      ? { id: upcoming[0].id, project_name: upcoming[0].project_name, bid_date: upcoming[0].bid_date }
      : null;

    // 期限間近（今日〜7日以内 かつ 未入札）
    const in7 = new Date(Date.now() + 9 * 3600 * 1000 + 7 * 86400 * 1000).toISOString().slice(0, 10);
    const dueSoon = all
      .filter((b) => BID_NOT_YET_BID.includes(b.status) && b.bid_date && b.bid_date >= today && b.bid_date <= in7)
      .sort((a, b) => a.bid_date.localeCompare(b.bid_date))
      .map((b) => ({ id: b.id, project_name: b.project_name, bid_date: b.bid_date }));

    // 期間内（bid_date で判定）かつ結果確定のものを抽出
    const inPeriod = all.filter((b) => b.bid_date && b.bid_date >= range.from && b.bid_date <= range.to);
    const isWon = (s) => s === 'won' || s === 'contracted'; // 契約は落札の延長として勝ち扱い
    const isLost = (s) => s === 'lost';

    const wonRows = inPeriod.filter((b) => isWon(b.status));
    const lostRows = inPeriod.filter((b) => isLost(b.status));

    // 件数ベース落札率
    const wc = wonRows.length;
    const lc = lostRows.length;
    const winRateCount = { won: wc, lost: lc, rate: wc + lc > 0 ? +(wc / (wc + lc)).toFixed(3) : null };

    // 金額ベース落札率: 落札額合計 ÷ (落札+失注 の自社見積合計)
    const wonTotal = wonRows.reduce((s, b) => s + (Number(b.awarded_price) || 0), 0);
    const denomTotal = [...wonRows, ...lostRows].reduce((s, b) => s + (Number(b.our_estimate) || 0), 0);
    const winRateAmount = {
      won_total: wonTotal,
      denom_total: denomTotal,
      rate: denomTotal > 0 ? +(wonTotal / denomTotal).toFixed(3) : null,
    };

    // 平均応札率: 落札案件のうち予定価格ありの 平均(落札額/予定価格)
    const ratios = wonRows
      .filter((b) => Number(b.budget_price) > 0 && Number(b.awarded_price) > 0)
      .map((b) => Number(b.awarded_price) / Number(b.budget_price));
    const avgBidRatio = ratios.length ? +(ratios.reduce((s, r) => s + r, 0) / ratios.length).toFixed(3) : null;

    // 集計軸別（client | work_type | staff）。結果確定（won/contracted/lost）のみ集計。
    const keyOf = (b) => {
      if (group_by === 'work_type') return b.work_type || '（未分類）';
      if (group_by === 'staff') return b.staff_id || '（未割当）';
      return b.client_name || '（未設定）';
    };
    const groupMap = new Map();
    for (const b of inPeriod) {
      if (!isWon(b.status) && !isLost(b.status)) continue;
      const k = keyOf(b);
      const g = groupMap.get(k) || { key: k, total: 0, won: 0, lost: 0 };
      g.total += 1;
      if (isWon(b.status)) g.won += 1;
      else g.lost += 1;
      groupMap.set(k, g);
    }
    let byGroup = [...groupMap.values()].map((g) => ({
      ...g,
      win_rate: g.won + g.lost > 0 ? +(g.won / (g.won + g.lost)).toFixed(3) : null,
    }));
    byGroup.sort((a, b) => b.total - a.total);

    // staff 軸のときは ID を名前に置換
    if (group_by === 'staff') {
      const nameMap = await loadStaffNameMap();
      byGroup = byGroup.map((g) => ({ ...g, key: nameMap[g.key] || g.key }));
    }

    res.json({
      summary: {
        in_progress: inProgress.length,
        estimating: estimating.length,
        bids_this_month: bidsThisMonth.length,
        next_bid: nextBid,
        due_soon: dueSoon,
        win_rate_count: winRateCount,
        win_rate_amount: winRateAmount,
        avg_bid_ratio: avgBidRatio,
      },
      by_group: byGroup,
      period: { type: period, from: range.from, to: range.to },
    });
  } catch (error) {
    console.error('Error (bids stats):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 入札 - 一覧取得（?status= &staff_id= &q= &sort= で絞り込み・並び替え）
app.get('/api/bids', requireAuth, requireBidAccess, async (req, res) => {
  try {
    const { status, staff_id, q, sort = 'bid_date' } = req.query;
    let query = supabase.from('bid_projects').select('*').eq('is_active', true);
    if (status && BID_STATUSES.includes(status)) query = query.eq('status', status);
    if (staff_id) query = query.eq('staff_id', staff_id);

    // 並び替え（既定: 入札日昇順。null は末尾）
    const sortable = { bid_date: 'bid_date', created_at: 'created_at', project_name: 'project_name' };
    const col = sortable[sort] || 'bid_date';
    query = query.order(col, { ascending: col !== 'created_at', nullsFirst: false });

    const { data, error } = await query;
    if (error) throw error;
    let rows = data || [];

    // 検索（工事名・発注者の部分一致。件数規模が小さいためJS側で実施）
    if (q) {
      const needle = String(q).toLowerCase();
      rows = rows.filter(
        (b) =>
          (b.project_name || '').toLowerCase().includes(needle) ||
          (b.client_name || '').toLowerCase().includes(needle)
      );
    }

    // 担当者名を付与
    const nameMap = await loadStaffNameMap();
    rows = rows.map((b) => ({ ...b, staff_name: b.staff_id ? nameMap[b.staff_id] || null : null }));

    res.json(rows);
  } catch (error) {
    console.error('Error (bids list):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 入札 - 詳細取得（資料・履歴を含む）
app.get('/api/bids/:id', requireAuth, requireBidAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: bid, error } = await supabase
      .from('bid_projects')
      .select('*')
      .eq('id', id)
      .eq('is_active', true)
      .maybeSingle();
    if (error) throw error;
    if (!bid) return res.status(404).json({ error: '案件が見つかりません' });

    const [{ data: docs }, { data: history }, nameMap] = await Promise.all([
      supabase.from('bid_documents').select('*').eq('bid_id', id).order('created_at', { ascending: false }),
      supabase.from('bid_status_history').select('*').eq('bid_id', id).order('changed_at', { ascending: false }),
      loadStaffNameMap(),
    ]);

    res.json({
      ...bid,
      staff_name: bid.staff_id ? nameMap[bid.staff_id] || null : null,
      documents: docs || [],
      history: history || [],
    });
  } catch (error) {
    console.error('Error (bid detail):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 入札案件で受け付ける更新可能フィールド
const BID_FIELDS = [
  'project_name', 'client_name', 'location', 'work_type', 'bid_method', 'status',
  'notice_date', 'question_due', 'bid_start_date', 'bid_date', 'opening_date',
  'budget_price', 'our_estimate', 'bid_amount', 'awarded_price', 'awarded_company',
  'staff_id', 'note', 'remarks', 'reason',
];

// req.body から許可フィールドのみ抽出（空文字は null に正規化）
function pickBidFields(body) {
  const out = {};
  for (const k of BID_FIELDS) {
    if (!(k in body)) continue;
    let v = body[k];
    if (v === '' || v === undefined) v = null;
    out[k] = v;
  }
  return out;
}

// ✅ 入札 - 新規登録
app.post('/api/bids', requireAuth, requireBidAccess, async (req, res) => {
  try {
    const payload = pickBidFields(req.body);
    if (!payload.project_name) return res.status(400).json({ error: '工事名は必須です' });
    if (payload.status && !BID_STATUSES.includes(payload.status)) {
      return res.status(400).json({ error: '不正なステータスです' });
    }
    payload.created_by = req.user.email;

    const { data, error } = await supabase.from('bid_projects').insert([payload]).select('*').single();
    if (error) throw error;

    // 初期ステータスの履歴を記録
    await supabase.from('bid_status_history').insert([
      { bid_id: data.id, from_status: null, to_status: data.status, changed_by: req.user.email },
    ]);

    res.json(data);
  } catch (error) {
    console.error('Error (bid create):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 入札 - 更新（ステータス変更時は履歴を自動追記）
app.put('/api/bids/:id', requireAuth, requireBidAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const payload = pickBidFields(req.body);
    if ('project_name' in payload && !payload.project_name) {
      return res.status(400).json({ error: '工事名は必須です' });
    }
    if (payload.status && !BID_STATUSES.includes(payload.status)) {
      return res.status(400).json({ error: '不正なステータスです' });
    }

    // 既存を取得（ステータス差分の判定用）
    const { data: existing, error: exErr } = await supabase
      .from('bid_projects')
      .select('status')
      .eq('id', id)
      .eq('is_active', true)
      .maybeSingle();
    if (exErr) throw exErr;
    if (!existing) return res.status(404).json({ error: '案件が見つかりません' });

    payload.updated_at = new Date().toISOString();
    const { data, error } = await supabase
      .from('bid_projects')
      .update(payload)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw error;

    // ステータスが変わっていれば履歴に記録
    if (payload.status && payload.status !== existing.status) {
      await supabase.from('bid_status_history').insert([
        { bid_id: id, from_status: existing.status, to_status: payload.status, changed_by: req.user.email },
      ]);
    }

    res.json(data);
  } catch (error) {
    console.error('Error (bid update):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 入札 - ステータス変更のみ（利用可=member 以上に開放。編集とは別枠）
app.patch('/api/bids/:id/status', requireAuth, requireBidAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const status = req.body?.status;
    if (!status || !BID_STATUSES.includes(status)) {
      return res.status(400).json({ error: '不正なステータスです' });
    }
    const { data: existing, error: exErr } = await supabase
      .from('bid_projects')
      .select('status')
      .eq('id', id)
      .eq('is_active', true)
      .maybeSingle();
    if (exErr) throw exErr;
    if (!existing) return res.status(404).json({ error: '案件が見つかりません' });

    const { data, error } = await supabase
      .from('bid_projects')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw error;

    if (status !== existing.status) {
      await supabase.from('bid_status_history').insert([
        { bid_id: id, from_status: existing.status, to_status: status, changed_by: req.user.email },
      ]);
    }

    res.json(data);
  } catch (error) {
    console.error('Error (bid status change):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 入札 - 論理削除
app.delete('/api/bids/:id', requireAuth, requireBidAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('bid_projects')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id');
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: '案件が見つかりません' });
    res.json({ ok: true });
  } catch (error) {
    console.error('Error (bid delete):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 入札 - 資料から案件情報を AI 抽出（登録前のプレフィル用。DBには保存しない）
//    複数ファイルを受け取り、主要書類に自動で絞って Gemini で解析する。
app.post('/api/bids/extract', requireAuth, requireBidAccess, upload.array('files', 20), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'files（資料ファイル）が必要です' });

    // 日本語ファイル名の文字化けを補正（書類の絞り込みキーワード判定に必須）
    for (const f of files) f.originalname = decodeUploadName(f.originalname);

    const picked = selectBidDocsForAI(files);
    if (!picked.length) {
      return res.status(400).json({ error: 'AIで読み取れる資料（PDF/画像）が見つかりませんでした。手入力で登録してください。' });
    }

    const fields = await extractBidInfo(picked);
    res.json({ fields, used_files: picked.map((f) => f.originalname) });
  } catch (error) {
    console.error('Error (bid extract):', error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ── 入札資料: 保存ヘルパー（共有ドライブ優先＝標準ストレージ方針。cert/circular/工事管理と同方式）──
//   Drive: "drive:<fileId>"（（DRIVE_FOLDER_ID）/入札案件/<案件名>/）。未設定時のみ Supabase バケットへフォールバック。
async function storeBidFile({ projectName, fileName, buffer, mimeType, fallbackPath }) {
  if (driveConfigured()) {
    const folderId = await ensureFolderPath(['03.入札案件', sanitizeDriveSeg(projectName || '未設定')], SHARED_DRIVE_ROOT_ID);
    const fileId = await driveUpload({ name: fileName, buffer, mimeType, folderId });
    return `drive:${fileId}`;
  }
  const { error } = await supabase.storage.from(BID_BUCKET).upload(fallbackPath, buffer, { contentType: mimeType });
  if (error) throw error;
  return fallbackPath;
}
// 署名トークンで保護された入札資料の Drive プロキシ配信
app.get('/api/bid-file', async (req, res) => {
  try {
    const token = req.query.t;
    if (!token) return res.status(400).send('missing token');
    let payload;
    try { payload = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).send('invalid or expired token'); }
    if (payload.kind !== 'bid' || !payload.fileId) return res.status(400).send('bad token');
    const { buffer, contentType } = await driveDownload(payload.fileId);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=120');
    res.send(buffer);
  } catch (error) {
    console.error('Error (bid-file proxy):', error.message);
    res.status(error.status || 500).send(error.message);
  }
});

// ✅ 入札 - 資料アップロード（共有ドライブ保存）
app.post('/api/bids/:id/documents', requireAuth, requireBidAccess, upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'file フィールドが必要です' });

    const originalName = decodeUploadName(req.file.originalname); // 日本語ファイル名の文字化け補正
    const ext = (originalName.split('.').pop() || 'bin').toLowerCase();
    const { data: bidRow } = await supabase
      .from('bid_projects').select('project_name').eq('id', id).maybeSingle();
    const storagePath = await storeBidFile({
      projectName: bidRow?.project_name,
      fileName: originalName,
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      fallbackPath: `${id}/${Date.now()}-${uuidv4()}.${ext}`,
    });

    const { data, error } = await supabase
      .from('bid_documents')
      .insert([{
        bid_id: id,
        file_name: originalName,
        storage_path: storagePath,
        doc_type: req.body.doc_type || null,
        size_bytes: req.file.size,
        uploaded_by: req.user.email,
      }])
      .select('*')
      .single();
    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('Error (bid doc upload):', error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ✅ 入札 - 資料の署名付きダウンロードURL発行（120秒有効）
app.get('/api/bids/:id/documents/:docId/url', requireAuth, requireBidAccess, async (req, res) => {
  try {
    const { docId } = req.params;
    const { data: doc, error } = await supabase
      .from('bid_documents')
      .select('storage_path, file_name')
      .eq('id', docId)
      .maybeSingle();
    if (error) throw error;
    if (!doc) return res.status(404).json({ error: '資料が見つかりません' });

    // Drive 保存（drive:<id>）は短命JWTプロキシURL、従来Supabase保存分は署名URL（後方互換）
    if (String(doc.storage_path).startsWith('drive:')) {
      const fileId = String(doc.storage_path).slice('drive:'.length);
      const token = jwt.sign({ fileId, kind: 'bid' }, JWT_SECRET, { expiresIn: 120 });
      const base = process.env.PUBLIC_API_URL || 'https://portal-api-hhlx.onrender.com';
      return res.json({ url: `${base}/api/bid-file?t=${encodeURIComponent(token)}`, file_name: doc.file_name });
    }
    const { data, error: sErr } = await supabase.storage
      .from(BID_BUCKET)
      .createSignedUrl(doc.storage_path, 120);
    if (sErr) throw sErr;

    res.json({ url: data.signedUrl, file_name: doc.file_name });
  } catch (error) {
    console.error('Error (bid doc url):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 入札 - 資料削除（Storage実体 + メタ）
app.delete('/api/bids/:id/documents/:docId', requireAuth, requireBidAdmin, async (req, res) => {
  try {
    const { docId } = req.params;
    const { data: doc } = await supabase
      .from('bid_documents')
      .select('storage_path')
      .eq('id', docId)
      .maybeSingle();
    if (doc?.storage_path) {
      if (String(doc.storage_path).startsWith('drive:')) {
        try { await driveTrash(String(doc.storage_path).slice('drive:'.length)); } catch (e) { console.error('drive trash:', e.message); }
      } else {
        await supabase.storage.from(BID_BUCKET).remove([doc.storage_path]);
      }
    }
    const { error } = await supabase.from('bid_documents').delete().eq('id', docId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) {
    console.error('Error (bid doc delete):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 入札 - 積算データ(Excel)取込: 金額を自動検出して積算金額(our_estimate・税抜)に反映し、
//    ファイルは資料(doc_type='積算')として添付する。入札金額(bid_amount)は別途手入力。
app.post('/api/bids/:id/import-estimate', requireAuth, requireBidAccess, upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'file フィールドが必要です' });

    const { data: bid, error: bidErr } = await supabase
      .from('bid_projects').select('id, project_name').eq('id', id).eq('is_active', true).maybeSingle();
    if (bidErr) throw bidErr;
    if (!bid) return res.status(404).json({ error: '案件が見つかりません' });

    const originalName = decodeUploadName(req.file.originalname);
    const ext = (originalName.split('.').pop() || '').toLowerCase();
    if (!['xlsx', 'xlsm'].includes(ext)) {
      return res.status(400).json({ error: 'Excel(.xlsx)形式の積算データをアップロードしてください（古い.xls形式は非対応）' });
    }

    // 金額抽出（失敗してもファイル添付は行う）
    let parsed = { amount: null, label: null, candidates: [] };
    try {
      parsed = await parseEstimateFromXlsx(req.file.buffer);
    } catch (e) {
      console.error('Excel parse error:', e.message);
    }

    // 資料として保存＋メタ登録（共有ドライブ優先）
    const storagePath = await storeBidFile({
      projectName: bid.project_name,
      fileName: originalName,
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      fallbackPath: `${id}/${Date.now()}-${uuidv4()}.${ext}`,
    });
    await supabase.from('bid_documents').insert([{
      bid_id: id,
      file_name: originalName,
      storage_path: storagePath,
      doc_type: '積算',
      size_bytes: req.file.size,
      uploaded_by: req.user.email,
    }]);

    // 金額が取れたら積算金額(our_estimate)を更新（入札金額は触らない）
    let updated = false;
    if (parsed.amount != null) {
      const { error: updErr } = await supabase
        .from('bid_projects')
        .update({ our_estimate: parsed.amount, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (updErr) throw updErr;
      updated = true;
    }

    res.json({
      estimated_amount: parsed.amount,
      label_used: parsed.label,
      candidates: parsed.candidates,
      updated,
      file_name: originalName,
    });
  } catch (error) {
    console.error('Error (bid import-estimate):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 工事管理（提出書類・検査書類）  ← migration 023
//   - 利用可(member): 全工事の閲覧 / 書類の編集・提出・ステータス更新 / 工事の新規作成
//   - 管理者(admin) : 上記に加え 工事の削除
//   権限は staff_app_permissions['construction']（社員一覧画面のアプリ別権限から設定）。
//   ファイル本体は共有ドライブ等に置き、submission_documents.file_ref で参照する。
// ============================================================

const CONSTRUCTION_PROJECT_STATUSES = ['preparing', 'in_progress', 'inspecting', 'completed', 'archived'];
const SUBMISSION_STATUSES = ['not_started', 'drafting', 'internal_review', 'submitted', 'approved', 'rejected', 'na'];

// 工事管理のロール解決（app_key='construction'）。bids と同じ方式。
async function resolveConstructionRole(email) {
  const perms = await resolvePermissions(email); // { role, staffId }
  if (perms.role === 'admin') return { role: 'admin', access: true, staffId: perms.staffId, globalAdmin: true };
  let level = null;
  if (perms.staffId) {
    const { data } = await supabase
      .from('staff_app_permissions')
      .select('access_level')
      .eq('staff_id', perms.staffId)
      .eq('app_key', 'construction')
      .maybeSingle();
    level = data?.access_level || null;
  }
  const role = level === 'admin' ? 'admin' : level ? 'member' : 'none';
  return { role, access: role !== 'none', staffId: perms.staffId, globalAdmin: false };
}

async function requireConstructionAccess(req, res, next) {
  try {
    const r = await resolveConstructionRole(req.user.email);
    if (!r.access) return res.status(403).json({ error: '工事管理へのアクセス権がありません' });
    req.consRole = r;
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function requireConstructionAdmin(req, res, next) {
  try {
    const r = await resolveConstructionRole(req.user.email);
    if (r.role !== 'admin') return res.status(403).json({ error: 'この操作は工事管理の管理者のみ可能です' });
    req.consRole = r;
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// 締切コード → 実日付(YYYY-MM-DD)。算出不能（随時/毎月/工場製作日 等）は null を返す。
function consAddDays(dateStr, n) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function consAddBusinessDays(dateStr, n) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  let added = 0;
  while (added < n) {
    d.setDate(d.getDate() + 1);
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) added++;
  }
  return d.toISOString().slice(0, 10);
}
function computeDueDate(code, project) {
  if (!code) return null;
  const c = project.contract_date || null;
  const s = project.start_date || null;
  const insp = project.completion_inspection_date || null;
  switch (code) {
    case 'BEFORE_CONTRACT': return c;
    case 'CONTRACT+14d': return consAddDays(c, 14);
    case 'CORINS+10biz': return consAddBusinessDays(c, 10);
    case 'BEFORE_START': return s;
    case 'START-7d': return consAddDays(s, -7);
    case 'START-14d': return consAddDays(s, -14);
    case 'INSP-14d': return consAddDays(insp, -14);
    case 'ON_COMPLETION_INSP': return insp;
    case 'AFTER_COMPLETION': return insp;
    // FACTORY-14d / MONTHLY-25 / ASAP / ANYTIME / ON_EVENT / AFTER_ASAP は単一期日を持たない
    default: return null;
  }
}

// 必要書類マスタから工事の提出書類チェックリストを生成（既存と重複するテンプレは追加しない）。
async function generateChecklist(project, email) {
  const { data: tmpls, error } = await supabase
    .from('required_doc_templates').select('*').eq('is_active', true).order('sort_order', { ascending: true });
  if (error) throw error;
  const wc = project.work_category || '新設';

  // 既に生成済みのテンプレIDを除外
  const { data: existing } = await supabase
    .from('submission_documents').select('template_id').eq('project_id', project.id);
  const have = new Set((existing || []).map((r) => r.template_id).filter((v) => v != null));

  const rows = (tmpls || [])
    .filter((t) => !t.work_category || t.work_category === '共通' || t.work_category === wc)
    .filter((t) => !have.has(t.id))
    .map((t) => ({
      project_id: project.id,
      template_id: t.id,
      category_no: t.category_no,
      category: t.category,
      subcategory: t.subcategory,
      doc_name: t.doc_name,
      trade: t.trade,
      form_no: t.form_no,
      status: 'not_started',
      due_date: computeDueDate(t.deadline_code, project),
      created_by: email,
    }));
  if (!rows.length) return 0;
  for (let i = 0; i < rows.length; i += 100) {
    const { error: e } = await supabase.from('submission_documents').insert(rows.slice(i, i + 100));
    if (e) throw e;
  }
  return rows.length;
}

// 工事案件の更新可能フィールド
const CONS_FIELDS = [
  'bid_project_id', 'project_name', 'project_code', 'client_org', 'construction_type', 'work_category',
  'location', 'contract_amount', 'contract_date', 'start_date', 'end_date', 'completion_inspection_date',
  'site_agent_id', 'chief_engineer_id', 'drive_folder_url', 'status',
];
function pickConsFields(body) {
  const out = {};
  for (const k of CONS_FIELDS) {
    if (!(k in body)) continue;
    let v = body[k];
    if (v === '' || v === undefined) v = null;
    out[k] = v;
  }
  return out;
}

// ✅ 工事管理 - ダッシュボードKPI（工事数 / 締切間近 / 期限超過 / 差戻し / 未着手）
app.get('/api/construction/stats', requireAuth, requireConstructionAccess, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const soon = consAddDays(today, 14);
    const [{ data: projects }, { data: docs }] = await Promise.all([
      supabase.from('construction_projects').select('id,status').eq('is_active', true),
      supabase.from('submission_documents').select('project_id,status,due_date'),
    ]);
    const activeIds = new Set((projects || []).map((p) => p.id));
    const activeProjects = (projects || []).filter((p) => p.status !== 'archived').length;
    let dueSoon = 0, overdue = 0, rejected = 0, notStarted = 0;
    for (const d of docs || []) {
      if (!activeIds.has(d.project_id)) continue; // 削除（論理削除）済み工事の書類は集計しない
      if (d.status === 'rejected') rejected++;
      if (d.status === 'approved' || d.status === 'na') continue;
      if (d.status === 'not_started') notStarted++;
      if (d.due_date) {
        if (d.due_date < today) overdue++;
        else if (d.due_date <= soon) dueSoon++;
      }
    }
    res.json({
      total_projects: (projects || []).length,
      active_projects: activeProjects,
      due_soon: dueSoon, overdue, rejected, not_started: notStarted,
      role: req.consRole?.role || 'member', // 'admin' のときフロントが削除UIを表示
    });
  } catch (error) {
    console.error('Error (construction stats):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 工事管理 - 工事一覧（書類進捗サマリ付き）
app.get('/api/construction/projects', requireAuth, requireConstructionAccess, async (req, res) => {
  try {
    const { status, q } = req.query;
    let query = supabase.from('construction_projects').select('*').eq('is_active', true);
    if (status && CONSTRUCTION_PROJECT_STATUSES.includes(status)) query = query.eq('status', status);
    query = query.order('created_at', { ascending: false });
    const { data, error } = await query;
    if (error) throw error;
    let rows = data || [];
    if (q) {
      const needle = String(q).toLowerCase();
      rows = rows.filter((p) =>
        (p.project_name || '').toLowerCase().includes(needle) ||
        (p.location || '').toLowerCase().includes(needle));
    }
    const ids = rows.map((r) => r.id);
    const progress = {};
    if (ids.length) {
      const { data: docs } = await supabase
        .from('submission_documents').select('project_id,status').in('project_id', ids);
      for (const d of docs || []) {
        const p = progress[d.project_id] || (progress[d.project_id] = { total: 0, done: 0 });
        p.total++;
        if (d.status === 'submitted' || d.status === 'approved' || d.status === 'na') p.done++;
      }
    }
    const nameMap = await loadStaffNameMap();
    rows = rows.map((p) => ({
      ...p,
      site_agent_name: p.site_agent_id ? nameMap[p.site_agent_id] || null : null,
      chief_engineer_name: p.chief_engineer_id ? nameMap[p.chief_engineer_id] || null : null,
      doc_total: progress[p.id]?.total || 0,
      doc_done: progress[p.id]?.done || 0,
    }));
    res.json(rows);
  } catch (error) {
    console.error('Error (construction list):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 工事管理 - 工事詳細（提出書類・設計変更一覧を含む）
app.get('/api/construction/projects/:id', requireAuth, requireConstructionAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: project, error } = await supabase
      .from('construction_projects').select('*').eq('id', id).eq('is_active', true).maybeSingle();
    if (error) throw error;
    if (!project) return res.status(404).json({ error: '工事が見つかりません' });
    const [{ data: docs }, { data: files }, { data: changes }, { data: changeFiles }, nameMap] = await Promise.all([
      supabase.from('submission_documents').select('*')
        .eq('project_id', id)
        .order('category_no', { ascending: true })
        .order('id', { ascending: true }),
      supabase.from('submission_files').select('*')
        .eq('project_id', id).order('created_at', { ascending: true }),
      supabase.from('construction_design_changes').select('*')
        .eq('project_id', id).eq('is_active', true)
        .order('change_no', { ascending: true }),
      supabase.from('construction_design_change_files').select('change_id')
        .eq('project_id', id),
      loadStaffNameMap(),
    ]);
    // 添付ファイルを書類ごとにまとめ、署名付きの一時URLを付与
    const filesByDoc = {};
    for (const f of files || []) {
      const url = await constructionFileSignedUrl(f.file_ref);
      (filesByDoc[f.document_id] = filesByDoc[f.document_id] || []).push({
        id: f.id, file_name: f.file_name, mime_type: f.mime_type, size_bytes: f.size_bytes, url,
        source: f.source || 'manual', ai_classified: !!f.ai_classified, ai_confidence: f.ai_confidence ?? null,
      });
    }
    const documents = (docs || []).map((d) => ({
      ...d,
      assignee_name: d.assignee_id ? nameMap[d.assignee_id] || null : null,
      files: filesByDoc[d.id] || [],
    }));
    // 設計変更一覧（ファイル件数を付与）
    const fileCountByChange = {};
    for (const cf of changeFiles || []) {
      fileCountByChange[cf.change_id] = (fileCountByChange[cf.change_id] || 0) + 1;
    }
    const design_changes = (changes || []).map((c) => ({
      ...c,
      file_count: fileCountByChange[c.id] || 0,
    }));
    // 入札連携: 元の入札案件サマリを付与
    let bid = null;
    if (project.bid_project_id) {
      const { data: b } = await supabase
        .from('bid_projects').select('id, project_name, status, client_name, awarded_price')
        .eq('id', project.bid_project_id).maybeSingle();
      bid = b || null;
    }
    res.json({
      ...project,
      site_agent_name: project.site_agent_id ? nameMap[project.site_agent_id] || null : null,
      chief_engineer_name: project.chief_engineer_id ? nameMap[project.chief_engineer_id] || null : null,
      bid,
      documents,
      design_changes,
    });
  } catch (error) {
    console.error('Error (construction detail):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 工事管理 - 工事の新規登録（既定で必要書類チェックリストを自動生成）
app.post('/api/construction/projects', requireAuth, requireConstructionAccess, async (req, res) => {
  try {
    const payload = pickConsFields(req.body);
    if (!payload.project_name) return res.status(400).json({ error: '工事名は必須です' });
    if (payload.status && !CONSTRUCTION_PROJECT_STATUSES.includes(payload.status)) {
      return res.status(400).json({ error: '不正なステータスです' });
    }
    payload.created_by = req.user.email;
    const { data, error } = await supabase
      .from('construction_projects').insert([payload]).select('*').single();
    if (error) throw error;

    let generated = 0;
    if (req.body?.generate_checklist !== false) {
      generated = await generateChecklist(data, req.user.email);
    }
    res.json({ ...data, generated_documents: generated });
  } catch (error) {
    console.error('Error (construction create):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 工事管理 - 入札案件から工事へ昇格（受注案件の情報を引き継ぐ）
app.post('/api/construction/projects/from-bid/:bidId', requireAuth, requireConstructionAccess, async (req, res) => {
  try {
    const { bidId } = req.params;
    const { data: bid, error } = await supabase
      .from('bid_projects').select('*').eq('id', bidId).eq('is_active', true).maybeSingle();
    if (error) throw error;
    if (!bid) return res.status(404).json({ error: '入札案件が見つかりません' });
    if (!['won', 'contracted'].includes(bid.status)) {
      return res.status(400).json({ error: '受注（落札／契約）した案件のみ工事へ昇格できます' });
    }
    // 二重昇格の防止
    const { data: existing } = await supabase
      .from('construction_projects').select('id').eq('bid_project_id', bidId).eq('is_active', true).maybeSingle();
    if (existing) return res.status(409).json({ error: 'この入札案件は既に工事へ昇格済みです', project_id: existing.id });

    const payload = {
      bid_project_id: bid.id,
      project_name: bid.project_name,
      location: bid.location || null,
      client_org: bid.client_name || '九州防衛局',
      contract_amount: bid.awarded_price ?? bid.our_estimate ?? null,
      status: 'preparing',
      created_by: req.user.email,
    };
    const { data, error: insErr } = await supabase
      .from('construction_projects').insert([payload]).select('*').single();
    if (insErr) throw insErr;

    // 入札資料を工事へ引き継ぐ（AIで工事情報を補完＋各資料を分類して提出書類へ添付）。
    // best-effort: 失敗しても工事登録・チェックリスト生成は成立させる。
    let carry = { carried: 0, classified: 0, extracted: false, project: data };
    try {
      carry = await carryOverBidDocuments({ project: data, bidId: bid.id, email: req.user.email });
    } catch (e) { console.error('carryOverBidDocuments:', e.message); }

    // 必要書類チェックリストを生成（抽出後の工事情報＝契約日等から締切を計算）。
    // 引き継ぎ時に作成済みのテンプレ書類は generateChecklist 側で重複生成しない。
    const generated = await generateChecklist(carry.project || data, req.user.email);
    res.json({
      ...(carry.project || data),
      generated_documents: generated,
      carried_files: carry.carried,
      ai_classified: carry.classified,
      ai_extracted: carry.extracted,
    });
  } catch (error) {
    console.error('Error (construction from-bid):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 工事管理 - 工事の更新（利用可=member 以上）
app.put('/api/construction/projects/:id', requireAuth, requireConstructionAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const payload = pickConsFields(req.body);
    if ('project_name' in payload && !payload.project_name) {
      return res.status(400).json({ error: '工事名は必須です' });
    }
    if (payload.status && !CONSTRUCTION_PROJECT_STATUSES.includes(payload.status)) {
      return res.status(400).json({ error: '不正なステータスです' });
    }
    const { data: existing, error: exErr } = await supabase
      .from('construction_projects').select('id').eq('id', id).eq('is_active', true).maybeSingle();
    if (exErr) throw exErr;
    if (!existing) return res.status(404).json({ error: '工事が見つかりません' });

    payload.updated_at = new Date().toISOString();
    const { data, error } = await supabase
      .from('construction_projects').update(payload).eq('id', id).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Error (construction update):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 工事管理 - 工事の論理削除（管理者のみ）
app.delete('/api/construction/projects/:id', requireAuth, requireConstructionAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('construction_projects')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', id).select('id');
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: '工事が見つかりません' });
    res.json({ ok: true });
  } catch (error) {
    console.error('Error (construction delete):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 工事管理 - 不足している必要書類を追加生成（テンプレ更新後の補完用）
app.post('/api/construction/projects/:id/generate-checklist', requireAuth, requireConstructionAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: project, error } = await supabase
      .from('construction_projects').select('*').eq('id', id).eq('is_active', true).maybeSingle();
    if (error) throw error;
    if (!project) return res.status(404).json({ error: '工事が見つかりません' });
    const generated = await generateChecklist(project, req.user.email);
    res.json({ ok: true, generated_documents: generated });
  } catch (error) {
    console.error('Error (construction generate-checklist):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 工事管理 - 数量書（内訳書 .xlsx）取込と工種別構成比率  ← migration 026
//   1) import-boq         : xlsxを解析→明細・工種別集計・構成比率をDB保存し、NA候補を返す
//   2) GET boq            : 保存済みの明細＋工種別サマリを取得
//   3) apply-checklist-filter: 承認された不要書類を status='na'（対象外）へ
// ============================================================

// 解析結果を construction_boq / construction_trade_summary / projects へ保存（再取込は洗替え）
// changeId: null=当初版（従来通り）, 数値=その設計変更の変更後版
async function persistBoq(projectId, parsed, sourceFile, changeId = null) {
  // 当初版は change_id IS NULL のレコードのみ削除（変更版は維持）。変更版は change_id 指定で削除。
  if (changeId == null) {
    await supabase.from('construction_boq').delete().eq('project_id', projectId).is('change_id', null);
    await supabase.from('construction_trade_summary').delete().eq('project_id', projectId).is('change_id', null);
  } else {
    await supabase.from('construction_boq').delete().eq('project_id', projectId).eq('change_id', changeId);
    await supabase.from('construction_trade_summary').delete().eq('project_id', projectId).eq('change_id', changeId);
  }

  const boqRows = parsed.nodes.map((x) => ({
    project_id: projectId, source_file: sourceFile || null, sheet_name: x.sheet_name || null,
    kind: x.kind || '細目', level: x.level ?? 2, path: x.path || null, seq: x.seq ?? 0,
    group_label: x.group_label || null, trade: x.trade || null, raw_category: x.raw_category || null,
    item_name: x.item_name || null, spec: x.spec || null, quantity: x.quantity ?? null,
    unit: x.unit || null, unit_price: x.unit_price ?? null,
    amount: x.amount != null ? Math.round(x.amount) : null, beppi_no: x.beppi_no || null,
    ratio_total: x.ratio_total != null ? Number(x.ratio_total.toFixed(6)) : null,
    ratio_parent: x.ratio_parent != null ? Number(x.ratio_parent.toFixed(6)) : null,
    sort_order: x.sort_order ?? 0,
    change_id: changeId ?? null,
  }));
  for (let i = 0; i < boqRows.length; i += 200) {
    const { error } = await supabase.from('construction_boq').insert(boqRows.slice(i, i + 200));
    if (error) throw error;
  }

  const sumRows = parsed.summary.map((t) => ({
    project_id: projectId, trade: t.trade, canonical: t.canonical || null,
    amount: Math.round(t.amount || 0),
    ratio: t.ratio != null ? Number(t.ratio.toFixed(4)) : null,
    item_count: t.item_count || 0, present: true,
    change_id: changeId ?? null,
  }));
  if (sumRows.length) {
    const { error } = await supabase.from('construction_trade_summary').insert(sumRows);
    if (error) throw error;
  }

  // 当初版の場合のみ projects の boq_total / boq_imported_at を更新
  if (changeId == null) {
    await supabase.from('construction_projects')
      .update({ boq_total: Math.round(parsed.total || 0), boq_imported_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', projectId);
  }
}

// 数量書に出現しなかった工種の「工種別書類」をNA候補として算出（共通・着手済みは除外）
async function computeNaCandidates(projectId, presentTrades) {
  const present = new Set(presentTrades || []);
  const { data: docs } = await supabase
    .from('submission_documents').select('id, doc_name, category, category_no, trade, status')
    .eq('project_id', projectId)
    .in('status', ['not_started', 'drafting']);
  return (docs || []).filter((d) => {
    const tr = (d.trade || '共通').trim();
    if (tr === '共通' || !CANONICAL_TRADES.includes(tr)) return false; // 共通・工種非依存は対象外
    return !present.has(tr);                                            // 数量書に無い工種のみ
  });
}

// ✅ 工事管理 - 数量書(xlsx)を取込：明細・構成比率を保存し、不要書類のNA候補を返す
// change_id（任意）を body か query で受け取り、指定時は変更版として保存する。
// change_id 未指定=当初版（従来通り。NA候補の算出も当初版のみ行う）。
app.post('/api/construction/projects/:id/import-boq', requireAuth, requireConstructionAccess, upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'file フィールド（数量書 .xlsx）が必要です' });
    const { data: project, error } = await supabase
      .from('construction_projects').select('id, project_name').eq('id', id).eq('is_active', true).maybeSingle();
    if (error) throw error;
    if (!project) return res.status(404).json({ error: '工事が見つかりません' });

    const originalName = decodeUploadName(req.file.originalname);
    const ext = (originalName.split('.').pop() || '').toLowerCase();
    if (!['xlsx', 'xlsm'].includes(ext)) {
      return res.status(400).json({ error: '数量書は Excel(.xlsx) 形式でアップロードしてください' });
    }

    // change_id: body フィールドまたは query パラメータから取得（任意）
    const rawChangeId = req.body?.change_id ?? req.query?.change_id ?? null;
    const changeId = rawChangeId != null && rawChangeId !== '' ? Number(rawChangeId) : null;
    if (changeId != null && isNaN(changeId)) {
      return res.status(400).json({ error: 'change_id は数値で指定してください' });
    }
    // boq_mode: change_id 指定時のみ有効（'full'=全体版 / 'delta'=変更分のみ）。既定 'full'
    const rawBoqMode = req.body?.boq_mode ?? req.query?.boq_mode ?? 'full';
    const boqMode = ['full', 'delta'].includes(rawBoqMode) ? rawBoqMode : 'full';

    // 変更版指定の場合、該当設計変更の存在確認
    if (changeId != null) {
      const { data: chk } = await supabase
        .from('construction_design_changes').select('id').eq('id', changeId).eq('project_id', id).eq('is_active', true).maybeSingle();
      if (!chk) return res.status(404).json({ error: '指定された設計変更が見つかりません' });
    }

    const parsed = parseBoqFromXlsx(req.file.buffer, originalName);
    if (parsed.mode === 'empty' || !parsed.nodes.length) {
      return res.status(422).json({ error: '数量書の明細を読み取れませんでした。様式（種目・科目・細目の各シート）をご確認ください', mode: parsed.mode });
    }

    await persistBoq(id, parsed, originalName, changeId);

    // 変更版取込後は design_changes に boq_mode / boq_total / boq_imported_at を記録
    if (changeId != null) {
      await supabase.from('construction_design_changes')
        .update({
          boq_mode: boqMode,
          boq_total: Math.round(parsed.total || 0),
          boq_imported_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', changeId);
    }

    // NA候補は当初版のみ算出（変更版取込時はスキップ）
    const na_candidates = changeId == null ? await computeNaCandidates(id, parsed.presentTrades) : [];

    res.json({
      ok: true,
      file_name: originalName,
      mode: parsed.mode,
      boq_mode: changeId != null ? boqMode : null,  // 変更版のみ付与
      total: parsed.total,
      line_count: parsed.lineCount,
      counts: parsed.counts,
      present_trades: parsed.presentTrades,
      summary: parsed.summary.map((t) => ({ trade: t.trade, amount: t.amount, ratio: t.ratio, item_count: t.item_count, canonical: t.canonical })),
      na_candidates,  // 承認画面で確認 → apply-checklist-filter で確定（当初版のみ）
      change_id: changeId,
    });
  } catch (error) {
    console.error('Error (construction import-boq):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 工事管理 - 保存済みの数量書（明細＋工種別構成比率）を取得
// change_id クエリ未指定=当初版(NULL)、指定=その変更版
app.get('/api/construction/projects/:id/boq', requireAuth, requireConstructionAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const rawChangeId = req.query?.change_id ?? null;
    const changeId = rawChangeId != null && rawChangeId !== '' ? Number(rawChangeId) : null;

    let boqQuery = supabase.from('construction_boq').select('*').eq('project_id', id).order('sort_order', { ascending: true });
    let sumQuery = supabase.from('construction_trade_summary').select('*').eq('project_id', id).order('amount', { ascending: false });
    if (changeId == null) {
      boqQuery = boqQuery.is('change_id', null);
      sumQuery = sumQuery.is('change_id', null);
    } else {
      boqQuery = boqQuery.eq('change_id', changeId);
      sumQuery = sumQuery.eq('change_id', changeId);
    }
    const [{ data: rows }, { data: summary }, { data: project }] = await Promise.all([
      boqQuery,
      sumQuery,
      supabase.from('construction_projects').select('boq_total, boq_imported_at').eq('id', id).maybeSingle(),
    ]);
    res.json({
      rows: rows || [],
      summary: summary || [],
      total: project?.boq_total ?? null,
      imported_at: project?.boq_imported_at ?? null,
      change_id: changeId,
    });
  } catch (error) {
    console.error('Error (construction boq get):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 工事管理 - 当初版 vs 変更版の工種別金額比較
app.get('/api/construction/projects/:id/boq-compare', requireAuth, requireConstructionAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const rawChangeId = req.query?.change_id ?? null;
    if (rawChangeId == null || rawChangeId === '') {
      return res.status(400).json({ error: 'change_id クエリパラメータが必要です' });
    }
    const changeId = Number(rawChangeId);
    if (isNaN(changeId)) return res.status(400).json({ error: 'change_id は数値で指定してください' });

    // 当初版と変更版のサマリを並行取得
    const [{ data: baseSummary }, { data: changeSummary }] = await Promise.all([
      supabase.from('construction_trade_summary').select('trade, amount').eq('project_id', id).is('change_id', null),
      supabase.from('construction_trade_summary').select('trade, amount').eq('project_id', id).eq('change_id', changeId),
    ]);

    // 工種をキーにマップ化
    const baseMap = {};
    for (const r of baseSummary || []) baseMap[r.trade] = r.amount || 0;
    const changeMap = {};
    for (const r of changeSummary || []) changeMap[r.trade] = r.amount || 0;

    // 全工種（当初 + 変更双方に出現するものを網羅）
    const allTrades = Array.from(new Set([...Object.keys(baseMap), ...Object.keys(changeMap)])).sort();

    const rows = allTrades.map((trade) => {
      const base_amount = baseMap[trade] ?? null;
      const change_amount = changeMap[trade] ?? null;
      const diff = (change_amount ?? 0) - (base_amount ?? 0);
      return { trade, base_amount, change_amount, diff };
    });

    const base_total = (baseSummary || []).reduce((s, r) => s + (r.amount || 0), 0);
    const change_total = (changeSummary || []).reduce((s, r) => s + (r.amount || 0), 0);

    res.json({
      base_total,
      change_total,
      diff: change_total - base_total,
      rows,
    });
  } catch (error) {
    console.error('Error (construction boq-compare):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 工事管理 - 設計変更の「変更後」集計を boq_mode を考慮して解決して返す
// ?change_id=N: 対象設計変更ID（必須）
// full 版: 変更版サマリをそのまま「変更後」として使用。変更版に無い当初工種は after=0（撤去）。
// delta 版: 当初額 + 変更版(増減)額 で「変更後」を算出。変更版に無い工種は当初のまま維持。
app.get('/api/construction/projects/:id/boq-resolved', requireAuth, requireConstructionAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const rawChangeId = req.query?.change_id ?? null;
    if (rawChangeId == null || rawChangeId === '') {
      return res.status(400).json({ error: 'change_id クエリパラメータが必要です' });
    }
    const changeId = Number(rawChangeId);
    if (isNaN(changeId)) return res.status(400).json({ error: 'change_id は数値で指定してください' });

    // 設計変更ヘッダ取得（boq_mode / change_no を参照）
    const { data: changeRow, error: cErr } = await supabase
      .from('construction_design_changes')
      .select('id, change_no, boq_mode, boq_total, boq_imported_at')
      .eq('id', changeId).eq('project_id', id).eq('is_active', true).maybeSingle();
    if (cErr) throw cErr;
    if (!changeRow) return res.status(404).json({ error: '指定された設計変更が見つかりません' });

    const boqMode = changeRow.boq_mode || 'full';

    // 当初版と変更版のサマリ・明細を並行取得
    const [
      { data: baseSummary },
      { data: changeSummary },
      { data: changeRows },
    ] = await Promise.all([
      supabase.from('construction_trade_summary').select('trade, amount').eq('project_id', id).is('change_id', null),
      supabase.from('construction_trade_summary').select('trade, amount').eq('project_id', id).eq('change_id', changeId),
      supabase.from('construction_boq').select('*').eq('project_id', id).eq('change_id', changeId).order('sort_order', { ascending: true }),
    ]);

    // 工種マップ化
    const baseMap = {};
    for (const r of baseSummary || []) baseMap[r.trade] = r.amount || 0;
    const changeMap = {};
    for (const r of changeSummary || []) changeMap[r.trade] = r.amount || 0;
    const deltaTradeSet = new Set(Object.keys(changeMap)); // delta 版で存在する工種

    // 変更後を解決する全工種リスト
    let allTrades;
    if (boqMode === 'full') {
      // full: 変更版に存在する工種 + 当初版の工種（変更版に無い当初工種は after=0）
      allTrades = Array.from(new Set([...Object.keys(baseMap), ...Object.keys(changeMap)]));
    } else {
      // delta: 当初版の工種 + delta に出現した追加工種 の統合
      allTrades = Array.from(new Set([...Object.keys(baseMap), ...Object.keys(changeMap)]));
    }

    // 工種別の変更後額を算出
    const base_total = (baseSummary || []).reduce((s, r) => s + (r.amount || 0), 0);

    const trades = allTrades.map((trade) => {
      const base_amount = baseMap[trade] ?? 0;
      const delta_amount = changeMap[trade] ?? 0;

      let after_amount;
      let changed;
      if (boqMode === 'full') {
        // full: 変更版にある額がそのまま変更後。変更版に無い工種は0（撤去）
        after_amount = changeMap.hasOwnProperty(trade) ? (changeMap[trade] || 0) : 0;
        changed = base_amount !== after_amount;
      } else {
        // delta: 当初額 + 増減額
        after_amount = base_amount + delta_amount;
        changed = deltaTradeSet.has(trade);
      }

      return { trade, base_amount, after_amount, diff: after_amount - base_amount, ratio: null, changed };
    });

    // 変更後合計
    const change_total = trades.reduce((s, t) => s + t.after_amount, 0);

    // ratio を付与（0除算ガード）
    for (const t of trades) {
      t.ratio = change_total > 0 ? Number((t.after_amount / change_total).toFixed(6)) : 0;
    }

    // after_amount 降順でソート
    trades.sort((a, b) => b.after_amount - a.after_amount);

    // rows: 変更版の BOQ 明細にそのまま is_delta フラグを付与
    const rows = (changeRows || []).map((r) => ({ ...r, is_delta: boqMode === 'delta' }));

    res.json({
      change_id: changeId,
      change_no: changeRow.change_no,
      boq_mode: boqMode,
      base_total,
      change_total,
      diff: change_total - base_total,
      trades,
      rows,
    });
  } catch (error) {
    console.error('Error (construction boq-resolved):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 工事管理 - 承認された不要書類を「対象外(na)」へ（チェックリスト絞り込みの確定）
app.post('/api/construction/projects/:id/apply-checklist-filter', requireAuth, requireConstructionAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const ids = Array.isArray(req.body?.document_ids) ? req.body.document_ids.filter((v) => v != null) : [];
    if (!ids.length) return res.json({ ok: true, updated: 0 });
    const { data, error } = await supabase
      .from('submission_documents')
      .update({ status: 'na', updated_at: new Date().toISOString() })
      .eq('project_id', id).in('id', ids).in('status', ['not_started', 'drafting'])
      .select('id');
    if (error) throw error;
    res.json({ ok: true, updated: (data || []).length });
  } catch (error) {
    console.error('Error (construction apply-checklist-filter):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 提出書類の更新可能フィールド
const SUB_DOC_FIELDS = [
  'status', 'due_date', 'submitted_at', 'approved_at', 'assignee_id', 'file_ref', 'note',
  'doc_name', 'category_no', 'category', 'subcategory', 'trade', 'form_no',
];
function pickSubDocFields(body) {
  const out = {};
  for (const k of SUB_DOC_FIELDS) {
    if (!(k in body)) continue;
    let v = body[k];
    if (v === '' || v === undefined) v = null;
    out[k] = v;
  }
  return out;
}

// ✅ 工事管理 - 提出書類の更新（ステータス・締切・担当・ファイル参照 等）
app.patch('/api/construction/documents/:docId', requireAuth, requireConstructionAccess, async (req, res) => {
  try {
    const { docId } = req.params;
    const payload = pickSubDocFields(req.body);
    if (payload.status && !SUBMISSION_STATUSES.includes(payload.status)) {
      return res.status(400).json({ error: '不正なステータスです' });
    }
    // 提出/承認のステータスに合わせて日付を自動補完（明示指定があれば優先）
    const today = new Date().toISOString().slice(0, 10);
    if (payload.status === 'submitted' && !('submitted_at' in req.body)) payload.submitted_at = today;
    if (payload.status === 'approved' && !('approved_at' in req.body)) payload.approved_at = today;
    payload.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('submission_documents').update(payload).eq('id', docId).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Error (submission update):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 工事管理 - 提出書類を手動追加（テンプレ外の書類）
app.post('/api/construction/projects/:id/documents', requireAuth, requireConstructionAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body || {};
    if (!b.doc_name) return res.status(400).json({ error: '書類名は必須です' });
    if (!b.category_no || !b.category) return res.status(400).json({ error: '大分類は必須です' });
    if (b.status && !SUBMISSION_STATUSES.includes(b.status)) {
      return res.status(400).json({ error: '不正なステータスです' });
    }
    const row = {
      project_id: Number(id),
      template_id: null,
      category_no: Number(b.category_no),
      category: b.category,
      subcategory: b.subcategory || null,
      doc_name: b.doc_name,
      trade: b.trade || '共通',
      form_no: b.form_no || null,
      status: b.status || 'not_started',
      due_date: b.due_date || null,
      assignee_id: b.assignee_id || null,
      note: b.note || null,
      created_by: req.user.email,
    };
    const { data, error } = await supabase
      .from('submission_documents').insert([row]).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Error (submission add):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 工事管理 - 提出書類の削除
app.delete('/api/construction/documents/:docId', requireAuth, requireConstructionAccess, async (req, res) => {
  try {
    const { docId } = req.params;
    const { data, error } = await supabase
      .from('submission_documents').delete().eq('id', docId).select('id');
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: '書類が見つかりません' });
    res.json({ ok: true });
  } catch (error) {
    console.error('Error (submission delete):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 工事管理 - 必要書類マスタ一覧（チェックリスト構築の参照用）
app.get('/api/construction/templates', requireAuth, requireConstructionAccess, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('required_doc_templates').select('*').eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error('Error (construction templates):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── 工事管理: 提出書類の添付ファイル（共有ドライブ保存。方針は certs と同じ）──
const CONSTRUCTION_BUCKET = 'construction-files';
let constructionBucketEnsured = false;
async function ensureConstructionBucket() {
  if (constructionBucketEnsured) return;
  try { await supabase.storage.createBucket(CONSTRUCTION_BUCKET, { public: false }); } catch { /* 既存ならOK */ }
  constructionBucketEnsured = true;
}
// Drive/OSのフォルダ名に使えない文字を除去
function sanitizeDriveSeg(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100) || '_';
}
function categoryFolderName(no, name) {
  return `${String(no).padStart(2, '0')}_${name}`;
}
// ファイルを保存し参照文字列を返す（drive:<id> もしくは Supabaseパス）。
//   保存先: （DRIVE_FOLDER_ID）/工事管理/<工事名>/<NN_大分類名>/
async function storeConstructionFile({ projectName, categoryNo, categoryName, fileName, buffer, mimeType }) {
  if (driveConfigured()) {
    const folderId = await ensureFolderPath([
      '05.工事管理',
      sanitizeDriveSeg(projectName),
      sanitizeDriveSeg(categoryFolderName(categoryNo, categoryName)),
    ], SHARED_DRIVE_ROOT_ID);
    const fileId = await driveUpload({ name: fileName, buffer, mimeType, folderId });
    return `drive:${fileId}`;
  }
  await ensureConstructionBucket();
  const path = `${Date.now()}-${uuidv4()}-${sanitizeDriveSeg(fileName)}`;
  const { error } = await supabase.storage.from(CONSTRUCTION_BUCKET).upload(path, buffer, { contentType: mimeType });
  if (error) throw error;
  return path;
}
// 一時表示/DL用URL。drive: 参照は短命JWT付きの API プロキシ、その他は Supabase 署名URL。
async function constructionFileSignedUrl(ref, expiresIn = 3600) {
  if (!ref) return null;
  if (String(ref).startsWith('drive:')) {
    const fileId = String(ref).slice('drive:'.length);
    const token = jwt.sign({ fileId, kind: 'construction' }, JWT_SECRET, { expiresIn });
    const base = process.env.PUBLIC_API_URL || 'https://portal-api-hhlx.onrender.com';
    return `${base}/api/construction-file?t=${encodeURIComponent(token)}`;
  }
  const { data } = await supabase.storage.from(CONSTRUCTION_BUCKET).createSignedUrl(ref, expiresIn);
  return data?.signedUrl || null;
}
// 署名トークンで保護された Drive ファイルプロキシ（認証ヘッダ無しで開ける）。
app.get('/api/construction-file', async (req, res) => {
  try {
    const token = req.query.t;
    if (!token) return res.status(400).send('missing token');
    let payload;
    try { payload = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).send('invalid or expired token'); }
    if (payload.kind !== 'construction' || !payload.fileId) return res.status(400).send('bad token');
    const { buffer, contentType } = await driveDownload(payload.fileId);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.send(buffer);
  } catch (error) {
    console.error('Error (construction-file proxy):', error.message);
    res.status(error.status || 500).send(error.message);
  }
});

// ✅ 工事管理 - 書類へファイル添付（共有ドライブへアップロード）
app.post('/api/construction/documents/:docId/files', requireAuth, requireConstructionAccess, upload.single('file'), async (req, res) => {
  try {
    const { docId } = req.params;
    if (!req.file) return res.status(400).json({ error: 'file フィールドが必要です' });
    const { data: doc, error: dErr } = await supabase
      .from('submission_documents').select('id, project_id, category_no, category').eq('id', docId).maybeSingle();
    if (dErr) throw dErr;
    if (!doc) return res.status(404).json({ error: '書類が見つかりません' });
    const { data: proj } = await supabase
      .from('construction_projects').select('project_name').eq('id', doc.project_id).maybeSingle();

    const fileName = decodeUploadName(req.file.originalname);
    const ref = await storeConstructionFile({
      projectName: proj?.project_name || `project-${doc.project_id}`,
      categoryNo: doc.category_no, categoryName: doc.category,
      fileName, buffer: req.file.buffer, mimeType: req.file.mimetype,
    });
    const { data, error } = await supabase.from('submission_files').insert([{
      document_id: doc.id, project_id: doc.project_id, file_ref: ref,
      file_name: fileName, mime_type: req.file.mimetype, size_bytes: req.file.size,
      uploaded_by: req.user.email,
    }]).select('*').single();
    if (error) throw error;
    const url = await constructionFileSignedUrl(data.file_ref);
    res.json({ id: data.id, file_name: data.file_name, mime_type: data.mime_type, size_bytes: data.size_bytes, url });
  } catch (error) {
    console.error('Error (construction file upload):', error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ✅ 工事管理 - 書類の添付ファイル一覧（署名付きURL）
app.get('/api/construction/documents/:docId/files', requireAuth, requireConstructionAccess, async (req, res) => {
  try {
    const { docId } = req.params;
    const { data, error } = await supabase
      .from('submission_files').select('*').eq('document_id', docId).order('created_at', { ascending: true });
    if (error) throw error;
    const withUrls = await Promise.all((data || []).map(async (f) => ({
      id: f.id, file_name: f.file_name, mime_type: f.mime_type, size_bytes: f.size_bytes,
      url: await constructionFileSignedUrl(f.file_ref),
      source: f.source || 'manual', ai_classified: !!f.ai_classified, ai_confidence: f.ai_confidence ?? null,
    })));
    res.json(withUrls);
  } catch (error) {
    console.error('Error (construction files list):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 工事管理 - 添付ファイルの削除（Drive はゴミ箱へ）
app.delete('/api/construction/files/:fileId', requireAuth, requireConstructionAccess, async (req, res) => {
  try {
    const { fileId } = req.params;
    const { data: f, error: fErr } = await supabase
      .from('submission_files').select('*').eq('id', fileId).maybeSingle();
    if (fErr) throw fErr;
    if (!f) return res.status(404).json({ error: 'ファイルが見つかりません' });
    if (String(f.file_ref).startsWith('drive:')) {
      try { await driveTrash(String(f.file_ref).slice('drive:'.length)); } catch (e) { console.error('drive trash:', e.message); }
    } else {
      try { await supabase.storage.from(CONSTRUCTION_BUCKET).remove([f.file_ref]); } catch { /* noop */ }
    }
    await supabase.from('submission_files').delete().eq('id', fileId);
    res.json({ ok: true });
  } catch (error) {
    console.error('Error (construction file delete):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 工事管理 - 設計変更（変更契約）管理  ← migration 029
//   - GET /api/construction/projects/:id/design-changes       : 変更一覧
//   - POST /api/construction/projects/:id/design-changes      : 変更新規作成（member）
//   - PATCH /api/construction/design-changes/:changeId        : 変更編集（member）
//   - POST /api/construction/design-changes/:changeId/apply   : 工事基本情報へ反映（member）
//   - DELETE /api/construction/design-changes/:changeId       : 論理削除（admin。未適用のみ）
//   - POST /api/construction/design-changes/:changeId/files   : 変更関連書類アップロード（member）
//   - GET /api/construction/design-changes/:changeId/files    : 変更関連書類一覧（member）
//   - DELETE /api/construction/design-change-files/:fileId    : 変更関連書類削除（member）
// ============================================================

const DESIGN_CHANGE_STATUSES = ['negotiating', 'instructed', 'estimating', 'contracted', 'cancelled'];
const DESIGN_CHANGE_REASON_CATEGORIES = ['数量増減', '設計変更指示', '追加工事', '工法変更', '条件変更', 'その他'];
const DESIGN_CHANGE_DOC_TYPES = ['変更指示書', '変更見積書', '変更契約書', '変更設計図', '変更数量書', 'その他'];

// 編集可能フィールド
const DESIGN_CHANGE_FIELDS = [
  'title', 'reason_category', 'reason', 'status',
  'amount_after', 'end_date_after', 'completion_inspection_date_after',
  'instruction_date', 'agreement_date', 'note',
];
function pickDesignChangeFields(body) {
  const out = {};
  for (const k of DESIGN_CHANGE_FIELDS) {
    if (!(k in body)) continue;
    let v = body[k];
    if (v === '' || v === undefined) v = null;
    out[k] = v;
  }
  return out;
}

// ✅ 設計変更 - 一覧（is_active=true, change_no 昇順）
app.get('/api/construction/projects/:id/design-changes', requireAuth, requireConstructionAccess, async (req, res) => {
  try {
    const { id } = req.params;
    // 工事の存在確認
    const { data: project, error: pErr } = await supabase
      .from('construction_projects').select('id').eq('id', id).eq('is_active', true).maybeSingle();
    if (pErr) throw pErr;
    if (!project) return res.status(404).json({ error: '工事が見つかりません' });

    const { data: changes, error } = await supabase
      .from('construction_design_changes').select('*')
      .eq('project_id', id).eq('is_active', true)
      .order('change_no', { ascending: true });
    if (error) throw error;

    // ファイル件数を付与
    const { data: fileCounts } = await supabase
      .from('construction_design_change_files').select('change_id').eq('project_id', id);
    const countMap = {};
    for (const f of fileCounts || []) countMap[f.change_id] = (countMap[f.change_id] || 0) + 1;

    res.json((changes || []).map((c) => ({ ...c, file_count: countMap[c.id] || 0 })));
  } catch (error) {
    console.error('Error (design-changes list):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 設計変更 - 新規作成（member）
app.post('/api/construction/projects/:id/design-changes', requireAuth, requireConstructionAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: project, error: pErr } = await supabase
      .from('construction_projects')
      .select('id, contract_amount, end_date, completion_inspection_date')
      .eq('id', id).eq('is_active', true).maybeSingle();
    if (pErr) throw pErr;
    if (!project) return res.status(404).json({ error: '工事が見つかりません' });

    const b = req.body || {};

    // バリデーション
    if (b.reason_category && !DESIGN_CHANGE_REASON_CATEGORIES.includes(b.reason_category)) {
      return res.status(400).json({ error: '不正な reason_category です' });
    }
    if (b.status && !DESIGN_CHANGE_STATUSES.includes(b.status)) {
      return res.status(400).json({ error: '不正なステータスです' });
    }

    // change_no: 未指定なら max(既存)+1
    let changeNo = b.change_no != null ? Number(b.change_no) : null;
    if (changeNo == null) {
      const { data: maxRow } = await supabase
        .from('construction_design_changes').select('change_no')
        .eq('project_id', id).eq('is_active', true)
        .order('change_no', { ascending: false }).limit(1).maybeSingle();
      changeNo = (maxRow?.change_no || 0) + 1;
    }

    // *_before は現在の工事値をスナップショット
    const row = {
      project_id: Number(id),
      change_no: changeNo,
      title: b.title || null,
      reason_category: b.reason_category || null,
      reason: b.reason || null,
      status: b.status || 'negotiating',
      amount_before: project.contract_amount ?? null,
      amount_after: b.amount_after != null && b.amount_after !== '' ? Number(b.amount_after) : null,
      end_date_before: project.end_date ?? null,
      end_date_after: b.end_date_after || null,
      completion_inspection_date_before: project.completion_inspection_date ?? null,
      completion_inspection_date_after: b.completion_inspection_date_after || null,
      instruction_date: b.instruction_date || null,
      agreement_date: b.agreement_date || null,
      note: b.note || null,
      created_by: req.user.email,
    };

    const { data, error } = await supabase
      .from('construction_design_changes').insert([row]).select('*').single();
    if (error) throw error;
    res.json({ ...data, file_count: 0 });
  } catch (error) {
    console.error('Error (design-change create):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 設計変更 - 編集（member）
app.patch('/api/construction/design-changes/:changeId', requireAuth, requireConstructionAccess, async (req, res) => {
  try {
    const { changeId } = req.params;
    const payload = pickDesignChangeFields(req.body);

    if (payload.reason_category && !DESIGN_CHANGE_REASON_CATEGORIES.includes(payload.reason_category)) {
      return res.status(400).json({ error: '不正な reason_category です' });
    }
    if (payload.status && !DESIGN_CHANGE_STATUSES.includes(payload.status)) {
      return res.status(400).json({ error: '不正なステータスです' });
    }
    if (payload.amount_after != null && payload.amount_after !== '') {
      payload.amount_after = Number(payload.amount_after);
    }

    const { data: existing, error: exErr } = await supabase
      .from('construction_design_changes').select('id').eq('id', changeId).eq('is_active', true).maybeSingle();
    if (exErr) throw exErr;
    if (!existing) return res.status(404).json({ error: '設計変更が見つかりません' });

    payload.updated_at = new Date().toISOString();
    const { data, error } = await supabase
      .from('construction_design_changes').update(payload).eq('id', changeId).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Error (design-change update):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 設計変更 - 工事基本情報へ反映（member）
// 反映前に project.original_* がNULLなら現在値を退避（当初値の初回保存）。
// amount_after / end_date_after / completion_inspection_date_after が非NULLなら project へ上書き。
// applied=true に更新し、change_count を applied 件数で再計算。冪等（二重適用防止）。
app.post('/api/construction/design-changes/:changeId/apply', requireAuth, requireConstructionAccess, async (req, res) => {
  try {
    const { changeId } = req.params;
    const { data: change, error: cErr } = await supabase
      .from('construction_design_changes').select('*').eq('id', changeId).eq('is_active', true).maybeSingle();
    if (cErr) throw cErr;
    if (!change) return res.status(404).json({ error: '設計変更が見つかりません' });

    // 二重適用防止（冪等）
    if (change.applied) {
      return res.json({ ok: true, already_applied: true, change });
    }

    const { data: project, error: pErr } = await supabase
      .from('construction_projects')
      .select('id, contract_amount, end_date, completion_inspection_date, original_contract_amount, original_end_date, original_completion_inspection_date')
      .eq('id', change.project_id).eq('is_active', true).maybeSingle();
    if (pErr) throw pErr;
    if (!project) return res.status(404).json({ error: '工事が見つかりません' });

    // 当初値の退避（original_* が NULL なら現在値を保存）
    const projectUpdate = {};
    if (project.original_contract_amount == null) {
      projectUpdate.original_contract_amount = project.contract_amount ?? null;
    }
    if (project.original_end_date == null) {
      projectUpdate.original_end_date = project.end_date ?? null;
    }
    if (project.original_completion_inspection_date == null) {
      projectUpdate.original_completion_inspection_date = project.completion_inspection_date ?? null;
    }

    // 変更後値を工事基本情報へ反映
    if (change.amount_after != null) projectUpdate.contract_amount = change.amount_after;
    if (change.end_date_after != null) projectUpdate.end_date = change.end_date_after;
    if (change.completion_inspection_date_after != null) {
      projectUpdate.completion_inspection_date = change.completion_inspection_date_after;
    }

    // applied 件数で change_count を再計算（この変更も含む）
    const { count: appliedCount } = await supabase
      .from('construction_design_changes')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', change.project_id).eq('is_active', true).eq('applied', true);
    projectUpdate.change_count = (appliedCount || 0) + 1; // この変更を含む
    projectUpdate.latest_change_at = new Date().toISOString();
    projectUpdate.updated_at = new Date().toISOString();

    // 当該変更を applied=true, status='contracted'（未設定なら）へ更新
    const changeUpdate = {
      applied: true,
      applied_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (!change.status || change.status !== 'contracted') {
      changeUpdate.status = 'contracted';
    }

    // プロジェクトと変更を並行更新
    const [{ error: puErr }, { data: updatedChange, error: cuErr }] = await Promise.all([
      supabase.from('construction_projects').update(projectUpdate).eq('id', change.project_id),
      supabase.from('construction_design_changes').update(changeUpdate).eq('id', changeId).select('*').single(),
    ]);
    if (puErr) throw puErr;
    if (cuErr) throw cuErr;

    res.json({ ok: true, already_applied: false, change: updatedChange });
  } catch (error) {
    console.error('Error (design-change apply):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 設計変更 - 論理削除（admin。applied=true のものは削除不可）
app.delete('/api/construction/design-changes/:changeId', requireAuth, requireConstructionAdmin, async (req, res) => {
  try {
    const { changeId } = req.params;
    const { data: change, error: cErr } = await supabase
      .from('construction_design_changes').select('id, applied').eq('id', changeId).eq('is_active', true).maybeSingle();
    if (cErr) throw cErr;
    if (!change) return res.status(404).json({ error: '設計変更が見つかりません' });
    if (change.applied) {
      return res.status(409).json({ error: '工事基本情報に反映済みの設計変更は削除できません。先に取り消し操作が必要です' });
    }
    const { error } = await supabase
      .from('construction_design_changes')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', changeId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) {
    console.error('Error (design-change delete):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── 設計変更関連書類のストレージヘルパー ──────────────────────────────────────
// 保存先: （DRIVE_FOLDER_ID）/工事管理/<工事名>/設計変更/第N回/
async function storeDesignChangeFile({ projectName, changeNo, fileName, buffer, mimeType }) {
  if (driveConfigured()) {
    const folderId = await ensureFolderPath([
      '05.工事管理',
      sanitizeDriveSeg(projectName),
      '設計変更',
      sanitizeDriveSeg(`第${changeNo}回`),
    ], SHARED_DRIVE_ROOT_ID);
    const fileId = await driveUpload({ name: fileName, buffer, mimeType, folderId });
    return `drive:${fileId}`;
  }
  await ensureConstructionBucket();
  const path = `design-changes/${Date.now()}-${uuidv4()}-${sanitizeDriveSeg(fileName)}`;
  const { error } = await supabase.storage.from(CONSTRUCTION_BUCKET).upload(path, buffer, { contentType: mimeType });
  if (error) throw error;
  return path;
}

// ✅ 設計変更 - 関連書類のアップロード（member）
app.post('/api/construction/design-changes/:changeId/files', requireAuth, requireConstructionAccess, upload.single('file'), async (req, res) => {
  try {
    const { changeId } = req.params;
    if (!req.file) return res.status(400).json({ error: 'file フィールドが必要です' });

    const { data: change, error: cErr } = await supabase
      .from('construction_design_changes').select('id, project_id, change_no').eq('id', changeId).eq('is_active', true).maybeSingle();
    if (cErr) throw cErr;
    if (!change) return res.status(404).json({ error: '設計変更が見つかりません' });

    const docType = req.body?.doc_type || 'その他';
    if (!DESIGN_CHANGE_DOC_TYPES.includes(docType)) {
      return res.status(400).json({ error: '不正な doc_type です' });
    }

    const { data: proj } = await supabase
      .from('construction_projects').select('project_name').eq('id', change.project_id).maybeSingle();
    const fileName = decodeUploadName(req.file.originalname);

    const ref = await storeDesignChangeFile({
      projectName: proj?.project_name || `project-${change.project_id}`,
      changeNo: change.change_no,
      fileName, buffer: req.file.buffer, mimeType: req.file.mimetype,
    });

    const { data, error } = await supabase.from('construction_design_change_files').insert([{
      change_id: Number(changeId),
      project_id: change.project_id,
      doc_type: docType,
      file_ref: ref,
      file_name: fileName,
      mime_type: req.file.mimetype,
      size_bytes: req.file.size,
      uploaded_by: req.user.email,
    }]).select('*').single();
    if (error) throw error;

    const url = await constructionFileSignedUrl(data.file_ref);
    res.json({ id: data.id, doc_type: data.doc_type, file_name: data.file_name, mime_type: data.mime_type, size_bytes: data.size_bytes, url });
  } catch (error) {
    console.error('Error (design-change file upload):', error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ✅ 設計変更 - 関連書類一覧（member）
app.get('/api/construction/design-changes/:changeId/files', requireAuth, requireConstructionAccess, async (req, res) => {
  try {
    const { changeId } = req.params;
    const { data, error } = await supabase
      .from('construction_design_change_files').select('*').eq('change_id', changeId).order('created_at', { ascending: true });
    if (error) throw error;

    const withUrls = await Promise.all((data || []).map(async (f) => ({
      id: f.id, doc_type: f.doc_type, file_name: f.file_name, mime_type: f.mime_type,
      size_bytes: f.size_bytes, url: await constructionFileSignedUrl(f.file_ref),
      uploaded_by: f.uploaded_by, created_at: f.created_at,
    })));
    res.json(withUrls);
  } catch (error) {
    console.error('Error (design-change files list):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 設計変更 - 関連書類の削除（member。Driveはゴミ箱へ）
app.delete('/api/construction/design-change-files/:fileId', requireAuth, requireConstructionAccess, async (req, res) => {
  try {
    const { fileId } = req.params;
    const { data: f, error: fErr } = await supabase
      .from('construction_design_change_files').select('*').eq('id', fileId).maybeSingle();
    if (fErr) throw fErr;
    if (!f) return res.status(404).json({ error: 'ファイルが見つかりません' });

    if (String(f.file_ref).startsWith('drive:')) {
      try { await driveTrash(String(f.file_ref).slice('drive:'.length)); } catch (e) { console.error('drive trash:', e.message); }
    } else {
      try { await supabase.storage.from(CONSTRUCTION_BUCKET).remove([f.file_ref]); } catch { /* noop */ }
    }
    await supabase.from('construction_design_change_files').delete().eq('id', fileId);
    res.json({ ok: true });
  } catch (error) {
    console.error('Error (design-change file delete):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 工事管理 - 書類のAI解析（Gemini）: 自動振り分け & 工事情報の自動抽出
//   既存の入札資料AI抽出（extractBidInfo）と同じ Gemini 連携方式を踏襲。
//   - classifyConstructionDoc : 1ファイルの内容＋ファイル名から「必要書類マスタ」のどれかを判定
//   - extractConstructionInfo : 契約・設計図書から工事の基本情報を構造化抽出
//   GEMINI_API_KEY 未設定なら AI 機能はスキップ（書類引継ぎ・登録などコア機能は継続）。
// ============================================================

const CONS_AI_MAX_FILE = 15 * 1024 * 1024;    // 1ファイル上限（超過は図面等とみなしAI対象外）
const CONS_AI_EXTRACT_TOTAL = 18 * 1024 * 1024; // 抽出時のインライン合計上限の安全圏

// 大分類No→名称（必要書類マスタのシードと一致。AIプロンプト/手動作成時の補完に使う）
const CONSTRUCTION_CATEGORY_NAMES = [
  { no: 1, name: '契約・設計図書' }, { no: 2, name: '着手・届出' }, { no: 3, name: '施工計画' },
  { no: 4, name: '施工管理' }, { no: 5, name: '品質・出来形' }, { no: 6, name: '安全・環境' },
  { no: 7, name: '工事写真' }, { no: 8, name: '検査' }, { no: 9, name: '完成・引渡' },
];

// drive:<id> もしくはストレージバケットのパスから実バイト列を取得
async function loadStoredFileBuffer(ref, bucket) {
  if (!ref) return null;
  if (String(ref).startsWith('drive:')) {
    const { buffer } = await driveDownload(String(ref).slice('drive:'.length));
    return buffer;
  }
  const { data, error } = await supabase.storage.from(bucket).download(ref);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}
function guessMimeByName(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  const map = {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword',
  };
  return map[ext] || 'application/octet-stream';
}
// Gemini にインラインで渡せる形式・サイズか（PDF/画像、かつ上限以内）
function geminiAnalyzable(mimeType, size) {
  const mt = mimeType || '';
  return (mt === 'application/pdf' || mt.startsWith('image/')) && (size == null || size <= CONS_AI_MAX_FILE);
}
async function getActiveDocTemplates() {
  const { data } = await supabase
    .from('required_doc_templates').select('*').eq('is_active', true).order('sort_order', { ascending: true });
  return data || [];
}

// 1ファイルの内容＋ファイル名から、必要書類マスタのどれに該当するかを判定
async function classifyConstructionDoc({ fileName, buffer, mimeType, templates }) {
  if (!GEMINI_API_KEY) return null;
  const catalog = (templates || [])
    .map((t) => `${t.category_no}\t${t.doc_name}\t${t.trade || '共通'}`)
    .join('\n');
  const catNames = CONSTRUCTION_CATEGORY_NAMES.map((c) => `${c.no}:${c.name}`).join(' / ');
  const prompt = [
    'これは日本の公共建築工事（発注者: 九州防衛局）で扱う書類の1つです。',
    'ファイル名と内容（PDF/画像）から、この書類が「必要書類マスタ」のどれに該当するかを1つだけ判定してください。',
    `大分類(category_no): ${catNames}`,
    '必要書類マスタ（タブ区切り: category_no / 書類名 / 工種）:',
    catalog,
    '出力JSON:',
    '- category_no: 1〜9の整数（最も適切な大分類）',
    '- doc_name: マスタの「書類名」のうち最も一致するものを正確に転記。該当が無ければ内容に基づき簡潔な書類名を記述',
    '- matched: マスタに一致する書類名があれば true、無ければ false',
    '- trade: 工種（マスタに合わせる。不明なら「共通」）',
    '- confidence: 判定の確信度 0.0〜1.0',
    '- reason: 判定理由を簡潔に（20字程度）',
    `ファイル名: ${fileName || '(不明)'}`,
  ].join('\n');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [
      { text: prompt },
      { inlineData: { mimeType: mimeType || 'application/pdf', data: buffer.toString('base64') } },
    ] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          category_no: { type: 'INTEGER' },
          doc_name: { type: 'STRING' },
          matched: { type: 'BOOLEAN' },
          trade: { type: 'STRING' },
          confidence: { type: 'NUMBER' },
          reason: { type: 'STRING' },
        },
        required: ['category_no', 'doc_name'],
      },
    },
  };
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) {
    const t = await resp.text();
    const e = new Error(`Gemini API エラー (${resp.status}): ${t.slice(0, 300)}`); e.status = 502; throw e;
  }
  const json = await resp.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return null;
  let p; try { p = JSON.parse(text); } catch { return null; }
  let no = Number(p.category_no);
  if (!Number.isInteger(no) || no < 1 || no > 9) no = null;
  return {
    category_no: no,
    doc_name: (p.doc_name || '').trim(),
    matched: !!p.matched,
    trade: (p.trade || '共通').trim() || '共通',
    confidence: typeof p.confidence === 'number' ? Math.max(0, Math.min(1, p.confidence)) : null,
    reason: (p.reason || '').trim(),
  };
}

// 分類結果から、紐付け先の提出書類(submission_documents)を解決（無ければ作成）
async function routeFileToDocument({ projectId, classification, email }) {
  const cls = classification;
  // 1) マスタ一致 → 同テンプレ由来の提出書類があればそれ、無ければテンプレから生成
  if (cls?.matched && cls.category_no && cls.doc_name) {
    const { data: tmpl } = await supabase
      .from('required_doc_templates').select('*')
      .eq('category_no', cls.category_no).eq('doc_name', cls.doc_name).eq('is_active', true).maybeSingle();
    if (tmpl) {
      const { data: existing } = await supabase
        .from('submission_documents').select('*')
        .eq('project_id', projectId).eq('template_id', tmpl.id).maybeSingle();
      if (existing) return existing;
      const { data: created, error } = await supabase.from('submission_documents').insert([{
        project_id: projectId, template_id: tmpl.id,
        category_no: tmpl.category_no, category: tmpl.category, subcategory: tmpl.subcategory,
        doc_name: tmpl.doc_name, trade: tmpl.trade, form_no: tmpl.form_no,
        status: 'not_started', created_by: email,
      }]).select('*').single();
      if (error) throw error;
      return created;
    }
  }
  // 2) 同名の既存提出書類（手動追加分など）に一致
  if (cls?.doc_name) {
    const { data: byName } = await supabase
      .from('submission_documents').select('*')
      .eq('project_id', projectId).eq('doc_name', cls.doc_name).maybeSingle();
    if (byName) return byName;
  }
  // 3) どれにも該当しない → 分類カテゴリ（不明なら1）に新規の提出書類を作成
  const no = cls?.category_no || 1;
  const catName = (CONSTRUCTION_CATEGORY_NAMES.find((c) => c.no === no) || {}).name || '契約・設計図書';
  const { data: created, error } = await supabase.from('submission_documents').insert([{
    project_id: projectId, template_id: null,
    category_no: no, category: catName, subcategory: null,
    doc_name: cls?.doc_name || '分類未確定の資料', trade: cls?.trade || '共通', form_no: null,
    status: 'not_started', created_by: email,
    note: cls ? 'AI自動振り分け' : 'AI判定なし（要確認）',
  }]).select('*').single();
  if (error) throw error;
  return created;
}

// 工事情報の抽出対象を絞る（契約・設計図書系を優先。PDF/画像のみ・合計上限内で最大3件）
function selectConstructionDocsForExtract(files) {
  const KW = ['契約', '設計', '特記', '仕様', '内訳', '概要', '工事'];
  const cand = (files || []).filter((f) => geminiAnalyzable(f.mimetype, f.size));
  const scored = cand.map((f) => {
    const nm = f.originalname || '';
    let s = 0; for (const k of KW) if (nm.includes(k)) s += 2;
    return { f, s };
  }).sort((a, b) => b.s - a.s || (a.f.size || 0) - (b.f.size || 0));
  const picked = []; let total = 0;
  for (const { f } of scored) {
    if (picked.length >= 3) break;
    if (total + (f.size || 0) > CONS_AI_EXTRACT_TOTAL) continue;
    picked.push(f); total += (f.size || 0);
  }
  if (!picked.length && cand.length) picked.push([...cand].sort((a, b) => (a.size || 0) - (b.size || 0))[0]);
  return picked;
}

// 契約・設計図書から工事の基本情報を構造化抽出
async function extractConstructionInfo(files) {
  if (!GEMINI_API_KEY) { const e = new Error('GEMINI_API_KEY が未設定です。'); e.status = 503; throw e; }
  const prompt = [
    'これは日本の公共建築工事（発注者: 九州防衛局）の契約・設計図書など（契約書・設計図書・特記仕様書・内訳書 等）です。',
    '記載内容を読み取り、工事管理の登録に必要な項目を JSON で返してください。',
    '- project_name: 工事名（正式名称）',
    '- project_code: 工事番号 / 契約番号',
    '- client_org: 発注者（例: 九州防衛局）',
    '- construction_type: 工種大別。「建築」「土木」「電気」「機械」「その他」のいずれか',
    '- work_category: 工事区分。「新設」「改修」「その他」のいずれか',
    '- location: 工事場所（基地・駐屯地名・住所）',
    '- contract_amount: 契約金額（円。半角数字のみ。税込）',
    '- contract_date: 契約日（YYYY-MM-DD）',
    '- start_date: 着工日（YYYY-MM-DD）',
    '- end_date: 工期末（YYYY-MM-DD）',
    '- completion_inspection_date: 完成検査(予定)日（YYYY-MM-DD）',
    '- summary: 工事概要を1〜2文（任意）',
    '日付が和暦（令和・平成等）の場合は西暦へ変換。時刻が併記されていても日付のみ抽出。読み取れない項目は空文字にし推測で埋めないこと。',
  ].join('\n');
  const parts = [{ text: prompt }];
  for (const f of files) parts.push({ inlineData: { mimeType: f.mimetype || 'application/pdf', data: f.buffer.toString('base64') } });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          project_name: { type: 'STRING' }, project_code: { type: 'STRING' }, client_org: { type: 'STRING' },
          construction_type: { type: 'STRING' }, work_category: { type: 'STRING' }, location: { type: 'STRING' },
          contract_amount: { type: 'STRING' }, contract_date: { type: 'STRING' }, start_date: { type: 'STRING' },
          end_date: { type: 'STRING' }, completion_inspection_date: { type: 'STRING' }, summary: { type: 'STRING' },
        },
      },
    },
  };
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) {
    const t = await resp.text();
    const e = new Error(`Gemini API エラー (${resp.status}): ${t.slice(0, 300)}`); e.status = 502; throw e;
  }
  const json = await resp.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini から有効な応答が得られませんでした');
  let p; try { p = JSON.parse(text); } catch { throw new Error('Gemini 応答の解析に失敗しました'); }
  const ctype = ['建築', '土木', '電気', '機械', 'その他'].includes((p.construction_type || '').trim()) ? p.construction_type.trim() : null;
  const wcat = ['新設', '改修', 'その他'].includes((p.work_category || '').trim()) ? p.work_category.trim() : null;
  return {
    project_name: (p.project_name || '').trim(),
    project_code: (p.project_code || '').trim(),
    client_org: (p.client_org || '').trim(),
    construction_type: ctype,
    work_category: wcat,
    location: (p.location || '').trim(),
    contract_amount: digitsOrNull(p.contract_amount),
    contract_date: cleanIsoDate(p.contract_date),
    start_date: cleanIsoDate(p.start_date),
    end_date: cleanIsoDate(p.end_date),
    completion_inspection_date: cleanIsoDate(p.completion_inspection_date),
    summary: (p.summary || '').trim(),
  };
}

// 入札の添付資料を工事へ引き継ぐ（AI抽出で工事情報を補完＋各資料を分類して提出書類へ添付）。
// best-effort: 個々の失敗はスキップし、工事登録自体は必ず成立させる。チェックリスト生成は呼び出し側で行う。
async function carryOverBidDocuments({ project, bidId, email }) {
  const result = { carried: 0, classified: 0, extracted: false, project };
  const { data: bidDocs } = await supabase
    .from('bid_documents').select('*').eq('bid_id', bidId).order('created_at', { ascending: true });
  if (!bidDocs || !bidDocs.length) return result;

  // 実バイト列を取得（個別失敗はスキップ）
  const loaded = [];
  for (const d of bidDocs) {
    try {
      const buffer = await loadStoredFileBuffer(d.storage_path, BID_BUCKET);
      if (buffer) loaded.push({ doc: d, buffer, originalname: d.file_name, mimetype: guessMimeByName(d.file_name), size: buffer.length });
    } catch (e) { console.error('carry load:', d.file_name, e.message); }
  }
  if (!loaded.length) return result;

  // 1) 工事情報の自動抽出 → 空欄のみ反映（手動指定済みは尊重）
  let updatedProject = project;
  if (GEMINI_API_KEY) {
    try {
      const picked = selectConstructionDocsForExtract(loaded);
      if (picked.length) {
        const info = await extractConstructionInfo(picked);
        const patch = {};
        const setIf = (k, v) => { if (v != null && v !== '' && (project[k] == null || project[k] === '')) patch[k] = v; };
        setIf('project_code', info.project_code);
        setIf('client_org', info.client_org);
        setIf('construction_type', info.construction_type);
        setIf('work_category', info.work_category);
        setIf('location', info.location);
        setIf('contract_amount', info.contract_amount);
        setIf('contract_date', info.contract_date);
        setIf('start_date', info.start_date);
        setIf('end_date', info.end_date);
        setIf('completion_inspection_date', info.completion_inspection_date);
        if (Object.keys(patch).length) {
          patch.updated_at = new Date().toISOString();
          const { data: up } = await supabase.from('construction_projects').update(patch).eq('id', project.id).select('*').single();
          if (up) { updatedProject = up; result.extracted = true; }
        }
      }
    } catch (e) { console.error('carry extract:', e.message); }
  }
  result.project = updatedProject;

  // 2) 各資料を分類 → 提出書類へ添付
  const templates = GEMINI_API_KEY ? await getActiveDocTemplates() : [];
  for (const item of loaded) {
    try {
      let classification = null;
      if (GEMINI_API_KEY && geminiAnalyzable(item.mimetype, item.size)) {
        try { classification = await classifyConstructionDoc({ fileName: item.originalname, buffer: item.buffer, mimeType: item.mimetype, templates }); }
        catch (e) { console.error('carry classify:', e.message); }
      }
      const doc = await routeFileToDocument({ projectId: project.id, classification, email });
      const ref = await storeConstructionFile({
        projectName: updatedProject.project_name || project.project_name,
        categoryNo: doc.category_no, categoryName: doc.category,
        fileName: item.originalname, buffer: item.buffer, mimeType: item.mimetype,
      });
      await supabase.from('submission_files').insert([{
        document_id: doc.id, project_id: project.id, file_ref: ref,
        file_name: item.originalname, mime_type: item.mimetype, size_bytes: item.size,
        uploaded_by: email, source: 'bid', ai_classified: !!classification,
        ai_confidence: classification?.confidence ?? null,
        ai_note: classification ? (classification.reason || null) : `入札資料: ${item.doc.doc_type || 'その他'}`,
      }]);
      result.carried += 1;
      if (classification) result.classified += 1;
    } catch (e) { console.error('carry attach:', item.originalname, e.message); }
  }
  return result;
}

// ✅ 工事管理 - ファイルをアップロード→Geminiが内容を読み取り、提出書類へ自動振り分けして添付
app.post('/api/construction/projects/:id/documents/auto-file', requireAuth, requireConstructionAccess, upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'file フィールドが必要です' });
    const { data: proj } = await supabase
      .from('construction_projects').select('id, project_name').eq('id', id).eq('is_active', true).maybeSingle();
    if (!proj) return res.status(404).json({ error: '工事が見つかりません' });

    const fileName = decodeUploadName(req.file.originalname);
    let classification = null;
    if (GEMINI_API_KEY && geminiAnalyzable(req.file.mimetype, req.file.size)) {
      try {
        const templates = await getActiveDocTemplates();
        classification = await classifyConstructionDoc({ fileName, buffer: req.file.buffer, mimeType: req.file.mimetype, templates });
      } catch (e) { console.error('auto-file classify:', e.message); }
    }
    const doc = await routeFileToDocument({ projectId: Number(id), classification, email: req.user.email });
    const ref = await storeConstructionFile({
      projectName: proj.project_name || `project-${id}`,
      categoryNo: doc.category_no, categoryName: doc.category,
      fileName, buffer: req.file.buffer, mimeType: req.file.mimetype,
    });
    const { data: fileRow, error } = await supabase.from('submission_files').insert([{
      document_id: doc.id, project_id: Number(id), file_ref: ref,
      file_name: fileName, mime_type: req.file.mimetype, size_bytes: req.file.size,
      uploaded_by: req.user.email, source: 'auto', ai_classified: !!classification,
      ai_confidence: classification?.confidence ?? null, ai_note: classification?.reason || null,
    }]).select('*').single();
    if (error) throw error;
    const url = await constructionFileSignedUrl(fileRow.file_ref);
    res.json({
      file: { id: fileRow.id, file_name: fileRow.file_name, mime_type: fileRow.mime_type, size_bytes: fileRow.size_bytes, url, source: 'auto', ai_classified: !!classification, ai_confidence: classification?.confidence ?? null },
      document: { id: doc.id, category_no: doc.category_no, category: doc.category, doc_name: doc.doc_name },
      classification,
    });
  } catch (error) {
    console.error('Error (construction auto-file):', error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ✅ 工事管理 - 書類から工事情報を AI 抽出（新規登録のプレフィル用。DBには保存しない）
app.post('/api/construction/extract-info', requireAuth, requireConstructionAccess, upload.array('files', 20), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'files（書類）が必要です' });
    for (const f of files) f.originalname = decodeUploadName(f.originalname);
    const picked = selectConstructionDocsForExtract(files);
    if (!picked.length) return res.status(400).json({ error: 'AIで読み取れる書類（PDF/画像）が見つかりませんでした。手入力で登録してください。' });
    const fields = await extractConstructionInfo(picked);
    res.json({ fields, used_files: picked.map((f) => f.originalname) });
  } catch (error) {
    console.error('Error (construction extract-info):', error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ============================================================
// 工事管理 - 設計変更書類からの AI 抽出（Gemini）
//   - extractDesignChangeInfo : 変更指示書・変更契約書・変更見積書・変更設計図などを読み取り
//                               設計変更フォームへのプレフィル用 draft を返す
//   - POST /api/construction/projects/:id/design-changes/extract : multipart, フィールド名 files
//     → { draft, confidence, summary } を返す。保存はしない（プレビュー専用）。
// ============================================================

// 設計変更関連書類のスコアリング（変更・契約・指示書キーワードを優先。合計上限内で最大5件）
function selectDesignChangeDocsForExtract(files) {
  const KW = ['変更', '指示', '契約', '見積', '設計', '数量'];
  const cand = (files || []).filter((f) => geminiAnalyzable(f.mimetype, f.size));
  const scored = cand.map((f) => {
    const nm = f.originalname || '';
    let s = 0; for (const k of KW) if (nm.includes(k)) s += 2;
    return { f, s };
  }).sort((a, b) => b.s - a.s || (a.f.size || 0) - (b.f.size || 0));
  const picked = []; let total = 0;
  for (const { f } of scored) {
    if (picked.length >= 5) break;
    if (total + (f.size || 0) > CONS_AI_EXTRACT_TOTAL) continue;
    picked.push(f); total += (f.size || 0);
  }
  if (!picked.length && cand.length) picked.push([...cand].sort((a, b) => (a.size || 0) - (b.size || 0))[0]);
  return picked;
}

// 設計変更書類から設計変更フォーム用の情報を構造化抽出
async function extractDesignChangeInfo(files, project) {
  if (!GEMINI_API_KEY) { const e = new Error('GEMINI_API_KEY が未設定です。'); e.status = 503; throw e; }
  const projectCtx = [
    project?.contract_amount != null ? `現在の契約金額: ${project.contract_amount}円` : null,
    project?.end_date ? `現在の工期末: ${project.end_date}` : null,
    project?.completion_inspection_date ? `現在の完成検査日: ${project.completion_inspection_date}` : null,
  ].filter(Boolean).join(' / ');
  const prompt = [
    'これは日本の公共建築工事（発注者: 九州防衛局）の設計変更に関する書類です（変更指示書・変更契約書・変更見積書・変更設計図・変更数量書 等）。',
    '複数の書類がある場合は総合的に読み取り、設計変更フォームの入力に必要な項目を JSON で返してください。',
    projectCtx ? `【工事現状参考情報】${projectCtx}` : '',
    '',
    '- title: 変更の概要・件名（書類から読み取った正式名称または内容を簡潔に。例: 「第1回設計変更（数量増減）」）',
    '- reason_category: 変更理由の区分。次の6種から最も当てはまるものを1つだけ選ぶ → 数量増減 / 設計変更指示 / 追加工事 / 工法変更 / 条件変更 / その他。判断できない場合は「その他」',
    '- reason: 変更内容・理由の要約。書類から読み取った具体的な内容を1〜3文で記述。読み取れなければ空文字',
    '- amount_after: 変更後の契約金額（円。半角数字のみ。税込。読み取れなければ null）',
    '- end_date_after: 変更後の工期末（YYYY-MM-DD。和暦は西暦へ変換。読み取れなければ null）',
    '- completion_inspection_date_after: 変更後の完成検査(予定)日（YYYY-MM-DD。読み取れなければ null）',
    '- instruction_date: 変更指示日（YYYY-MM-DD。変更指示書の発行日。読み取れなければ null）',
    '- agreement_date: 変更契約日（YYYY-MM-DD。変更契約書の締結日。読み取れなければ null）',
    '- status: 書類の種別から変更の進捗状態を推定する。変更指示書のみ→"instructed"、見積書のみまたは見積回答中→"estimating"、変更契約書あり→"contracted"、それ以外または不明→"negotiating"',
    '- confidence: 読み取り全体の確信度 0.0〜1.0（数値）',
    '- summary: 読み取り根拠の短い説明（どの書類のどの箇所から何を読み取ったか。50字程度）',
    '日付が和暦（令和・平成等）の場合は西暦へ変換。金額が複数書類で矛盾する場合は最終的な確定値（変更契約書優先）を採用。推測で埋めず、読み取れない項目は null または空文字にすること。',
  ].filter((l) => l !== '').join('\n');

  const parts = [{ text: prompt }];
  for (const f of files) parts.push({ inlineData: { mimeType: f.mimetype || 'application/pdf', data: f.buffer.toString('base64') } });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          reason_category: { type: 'STRING' },
          reason: { type: 'STRING' },
          amount_after: { type: 'STRING' },
          end_date_after: { type: 'STRING' },
          completion_inspection_date_after: { type: 'STRING' },
          instruction_date: { type: 'STRING' },
          agreement_date: { type: 'STRING' },
          status: { type: 'STRING' },
          confidence: { type: 'NUMBER' },
          summary: { type: 'STRING' },
        },
      },
    },
  };

  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) {
    const t = await resp.text();
    const e = new Error(`Gemini API エラー (${resp.status}): ${t.slice(0, 300)}`); e.status = 502; throw e;
  }
  const json = await resp.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini から有効な応答が得られませんでした');
  let p; try { p = JSON.parse(text); } catch { throw new Error('Gemini 応答の解析に失敗しました'); }

  // reason_category の正規化
  const validReasonCats = ['数量増減', '設計変更指示', '追加工事', '工法変更', '条件変更', 'その他'];
  const reasonCat = validReasonCats.includes((p.reason_category || '').trim()) ? p.reason_category.trim() : 'その他';

  // status の正規化
  const validStatuses = ['negotiating', 'instructed', 'estimating', 'contracted', 'cancelled'];
  const status = validStatuses.includes((p.status || '').trim()) ? p.status.trim() : 'negotiating';

  const draft = {
    title: (p.title || '').trim() || null,
    reason_category: reasonCat,
    reason: (p.reason || '').trim() || null,
    amount_after: digitsOrNull(p.amount_after),
    end_date_after: cleanIsoDate(p.end_date_after),
    completion_inspection_date_after: cleanIsoDate(p.completion_inspection_date_after),
    instruction_date: cleanIsoDate(p.instruction_date),
    agreement_date: cleanIsoDate(p.agreement_date),
    status,
  };
  const confidence = typeof p.confidence === 'number' ? Math.max(0, Math.min(1, p.confidence)) : null;
  const summary = (p.summary || '').trim();
  return { draft, confidence, summary };
}

// ✅ 設計変更書類から設計変更フォームへのプレフィル情報を AI 抽出（保存しない・プレビュー専用）
app.post('/api/construction/projects/:id/design-changes/extract', requireAuth, requireConstructionAccess, upload.array('files', 20), async (req, res) => {
  try {
    const { id } = req.params;
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'files（書類）が必要です' });
    for (const f of files) f.originalname = decodeUploadName(f.originalname);

    const { data: project, error: pErr } = await supabase
      .from('construction_projects')
      .select('id, contract_amount, end_date, completion_inspection_date')
      .eq('id', id).eq('is_active', true).maybeSingle();
    if (pErr) throw pErr;
    if (!project) return res.status(404).json({ error: '工事が見つかりません' });

    const picked = selectDesignChangeDocsForExtract(files);
    if (!picked.length) return res.status(400).json({ error: 'AIで読み取れる書類（PDF/画像）が見つかりませんでした。手入力で登録してください。' });

    const result = await extractDesignChangeInfo(picked, project);
    res.json({ draft: result.draft, confidence: result.confidence, summary: result.summary, used_files: picked.map((f) => f.originalname) });
  } catch (error) {
    console.error('Error (design-changes extract):', error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ============================================================
// バグ報告・改善要望（フィードバック）機能  ← migration 019
//   - 投稿・自分の報告閲覧: 全社員（requireAuth のみ）
//   - 全件閲覧 / トリアージ / エクスポート: feedback 管理者のみ
//   収集データは Claude Code が実装着手しやすいよう構造化して保持し、
//   未対応分を Markdown バックログとして取り出せる（GET /api/feedback/export）。
// ============================================================

const FEEDBACK_BUCKET = 'feedback-photos';
let feedbackBucketEnsured = false;
async function ensureFeedbackBucket() {
  if (feedbackBucketEnsured) return;
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw error;
  if (!buckets?.some((b) => b.name === FEEDBACK_BUCKET)) {
    const { error: createError } = await supabase.storage.createBucket(FEEDBACK_BUCKET, { public: true });
    if (createError && !/exist/i.test(createError.message || '')) throw createError;
  }
  feedbackBucketEnsured = true;
}

// 対象アプリ識別子 → 日本語表示名（エクスポート/一覧の見出し用）
const FEEDBACK_APP_LABELS = {
  portal: 'ポータル全般',
  'safety-patrol': '安全パトロール',
  'employee-list': '社員一覧',
  announcements: 'お知らせ',
  bids: '入札案件管理',
  other: 'その他',
};
const FEEDBACK_STATUS_LABELS = {
  new: '未対応', triaged: '確認済', in_progress: '対応中', done: '完了', wont_fix: '対応しない',
};
const FEEDBACK_SEVERITY_LABELS = { low: '低', medium: '中', high: '高', critical: '致命的' };
const FEEDBACK_FREQ_LABELS = { always: '毎回', sometimes: '時々', once: '一度だけ' };
const FEEDBACK_PRIORITY_LABELS = { low: '低', normal: '通常', high: '高' };

// フィードバック管理者か判定（グローバル管理者 or staff_app_permissions['feedback']='admin'）
async function resolveFeedbackRole(email) {
  const perms = await resolvePermissions(email); // { role, staffId } グローバル
  if (perms.role === 'admin') return { role: 'admin', staffId: perms.staffId };
  let level = null;
  if (perms.staffId) {
    const { data } = await supabase
      .from('staff_app_permissions')
      .select('access_level')
      .eq('staff_id', perms.staffId)
      .eq('app_key', 'feedback')
      .maybeSingle();
    level = data?.access_level || null;
  }
  const role = level === 'admin' ? 'admin' : level ? 'member' : 'none';
  return { role, staffId: perms.staffId };
}

// ============================================================
// 見積比較（quote_compare）API ── P0: 骨格＋6類型分類
//   設計書: D:\01.claude code\04.アプリ\見積比較_設計書.md（＝正）
//   1プロジェクト＝1つの入札時積算数量書（工事×分野）に複数社の見積をぶら下げる。
//   原本xlsx → boqParser で BOQ行(sheet,excel_row付)に分解（書き戻しの骨格）。
//   各社見積はアップロード時に6類型（書式軸×媒体軸）を自動分類＋人が確認・上書き。
//   ※ Excel直読抽出・PDFキュー抽出・横並び比較・最安・書き戻しは P1 以降。
// ============================================================

// 権限: staff_app_permissions['quote_compare'] に行があれば全操作可（入札担当中心）。
//   グローバル管理者は常に許可。bids と同型（行があれば閲覧/編集を分けない）。
async function resolveQuoteCompareRole(email) {
  const perms = await resolvePermissions(email); // { role, staffId }
  if (perms.role === 'admin') return { role: 'admin', access: true, staffId: perms.staffId, globalAdmin: true };
  let level = null;
  if (perms.staffId) {
    const { data } = await supabase
      .from('staff_app_permissions')
      .select('access_level')
      .eq('staff_id', perms.staffId)
      .eq('app_key', 'quote_compare')
      .maybeSingle();
    level = data?.access_level || null;
  }
  const role = level === 'admin' ? 'admin' : level ? 'member' : 'none';
  return { role, access: role !== 'none', staffId: perms.staffId, globalAdmin: false };
}

async function requireQuoteCompareAccess(req, res, next) {
  try {
    const r = await resolveQuoteCompareRole(req.user.email);
    if (!r.access) return res.status(403).json({ error: '見積比較へのアクセス権がありません' });
    req.qcRole = r;
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// 見積比較の有効な軸の値
const QC_FORM_TYPES = ['official', 'vendor'];
const QC_MEDIA = ['excel', 'text_pdf', 'image_pdf'];
const QC_DISCIPLINES = ['建築', '機械', '電気・通信'];

// 見積比較ファイルを Drive に保存し drive:<id> を返す（共有ドライブ「見積比較/<工事名>/<sub>/」）。
//   Drive 未設定時は Supabase バケットへフォールバック（construction と同型）。
async function storeQuoteFile({ projectName, sub, fileName, buffer, mimeType }) {
  if (driveConfigured()) {
    const folderId = await ensureFolderPath([
      '04.見積比較',
      sanitizeDriveSeg(projectName || 'project'),
      sanitizeDriveSeg(sub || '見積'),
    ], SHARED_DRIVE_ROOT_ID);
    const fileId = await driveUpload({ name: fileName, buffer, mimeType, folderId });
    return `drive:${fileId}`;
  }
  await ensureConstructionBucket();
  const path = `quote/${Date.now()}-${uuidv4()}-${sanitizeDriveSeg(fileName)}`;
  const { error } = await supabase.storage.from(CONSTRUCTION_BUCKET).upload(path, buffer, { contentType: mimeType });
  if (error) throw error;
  return path;
}

// boqParser の nodes を quote_boq_rows へ保存（全行 replace）。
//   書き戻しの鍵として sheet_name / excel_row を必ず保持する（boqParser 拡張で付与済み）。
async function persistQuoteBoq(projectId, parsed) {
  await supabase.from('quote_boq_rows').delete().eq('project_id', projectId);
  const rows = parsed.nodes.map((x) => ({
    project_id: projectId,
    sheet_name: x.sheet_name || null,
    excel_row: x.excel_row ?? null,
    path: x.path || null,
    level: x.level ?? 2,
    kind: x.kind || '細目',
    item_name: x.item_name || null,
    spec: x.spec || null,
    // quantity_raw は書き戻し（P3）で原本の文字列(▲/カンマ)を参照する想定。
    // 現状 boqParser は数値のみ公開のため暫定で文字列化（原本書式の厳密保持は P3 で対応）。
    quantity_raw: x.quantity != null ? String(x.quantity) : null,
    quantity_num: x.quantity ?? null,
    unit: x.unit || null,
    official_unit_price: null,
    beppi_no: x.beppi_no || null,
    trade: x.trade || null,
    canonical: x.trade || null,
    sort_order: x.sort_order ?? 0,
  }));
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase.from('quote_boq_rows').insert(rows.slice(i, i + 200));
    if (error) throw error;
  }
}

// ✅ 見積比較 - プロジェクト一覧（権限内は全件。業者数を付与）
app.get('/api/quote-compare/projects', requireAuth, requireQuoteCompareAccess, async (req, res) => {
  try {
    const { data: projects, error } = await supabase
      .from('quote_compare_projects').select('*').order('updated_at', { ascending: false });
    if (error) throw error;
    const ids = (projects || []).map((p) => p.id);
    const vcount = {};
    if (ids.length) {
      const { data: vs } = await supabase.from('quote_vendors').select('project_id').in('project_id', ids);
      for (const v of vs || []) vcount[v.project_id] = (vcount[v.project_id] || 0) + 1;
    }
    res.json((projects || []).map((p) => ({ ...p, vendor_count: vcount[p.id] || 0 })));
  } catch (error) {
    console.error('Error (quote-compare projects):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 見積比較 - プロジェクト新規（bid_project_id 任意紐付け）
app.post('/api/quote-compare/projects', requireAuth, requireQuoteCompareAccess, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name（プロジェクト名）は必須です' });
    const discipline = req.body?.discipline ? String(req.body.discipline) : null;
    if (discipline && !QC_DISCIPLINES.includes(discipline)) {
      return res.status(400).json({ error: 'discipline は 建築/機械/電気・通信 のいずれかです' });
    }
    const rawBid = req.body?.bid_project_id;
    const bidProjectId = rawBid != null && rawBid !== '' ? Number(rawBid) : null;
    if (bidProjectId != null && isNaN(bidProjectId)) {
      return res.status(400).json({ error: 'bid_project_id は数値で指定してください' });
    }
    const { data, error } = await supabase
      .from('quote_compare_projects')
      .insert({
        name,
        client: req.body?.client ? String(req.body.client) : null,
        discipline,
        bid_project_id: bidProjectId,
        created_by: req.user.email,
      })
      .select('*')
      .single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Error (quote-compare create):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 見積比較 - プロジェクト詳細（BOQ件数＋業者一覧）
app.get('/api/quote-compare/projects/:id', requireAuth, requireQuoteCompareAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: project, error } = await supabase
      .from('quote_compare_projects').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!project) return res.status(404).json({ error: 'プロジェクトが見つかりません' });
    const [{ count: boqCount }, { data: vendors }, { data: cellRows }, { data: unmatchedRows }] = await Promise.all([
      supabase.from('quote_boq_rows').select('id', { count: 'exact', head: true }).eq('project_id', id),
      supabase.from('quote_vendors').select('*').eq('project_id', id).order('created_at', { ascending: true }),
      supabase.from('quote_cells').select('vendor_id').eq('project_id', id),
      supabase.from('quote_unmatched').select('vendor_id').eq('project_id', id),
    ]);
    const cellCount = {}; for (const c of cellRows || []) cellCount[c.vendor_id] = (cellCount[c.vendor_id] || 0) + 1;
    const unmCount = {}; for (const u of unmatchedRows || []) unmCount[u.vendor_id] = (unmCount[u.vendor_id] || 0) + 1;
    res.json({
      ...project,
      boq_row_count: boqCount || 0,
      vendors: (vendors || []).map((v) => ({ ...v, cell_count: cellCount[v.id] || 0, unmatched_count: unmCount[v.id] || 0 })),
    });
  } catch (error) {
    console.error('Error (quote-compare detail):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 見積比較 - プロジェクト削除（紐づく行はCASCADE）
app.delete('/api/quote-compare/projects/:id', requireAuth, requireQuoteCompareAccess, async (req, res) => {
  try {
    const { error } = await supabase.from('quote_compare_projects').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) {
    console.error('Error (quote-compare delete):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 見積比較 - 原本（入札時積算数量書 xlsx）取込 → boqParser → quote_boq_rows
app.post('/api/quote-compare/projects/:id/import-template', requireAuth, requireQuoteCompareAccess, upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'file フィールド（数量書 .xlsx）が必要です' });
    const { data: project, error } = await supabase
      .from('quote_compare_projects').select('id, name').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!project) return res.status(404).json({ error: 'プロジェクトが見つかりません' });

    const originalName = decodeUploadName(req.file.originalname);
    const ext = (originalName.split('.').pop() || '').toLowerCase();
    if (!['xlsx', 'xlsm'].includes(ext)) {
      return res.status(400).json({ error: '原本数量書は Excel(.xlsx) 形式でアップロードしてください' });
    }

    const parsed = parseBoqFromXlsx(req.file.buffer, originalName);
    if (parsed.mode === 'empty' || !parsed.nodes.length) {
      return res.status(422).json({ error: '数量書の明細を読み取れませんでした。様式（種目・科目・細目の各シート）をご確認ください', mode: parsed.mode });
    }

    await persistQuoteBoq(id, parsed);

    // 原本テンプレを Drive に保存（書き戻しジョブで現物同梱するための参照。失敗しても取込は成功とする）
    let templateRef = null;
    try {
      templateRef = await storeQuoteFile({
        projectName: project.name, sub: '原本', fileName: originalName,
        buffer: req.file.buffer,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
    } catch (e) {
      console.error('Warning (quote template store):', e.message);
    }

    await supabase.from('quote_compare_projects')
      .update({
        template_drive_id: templateRef,
        template_filename: originalName,
        boq_total: Math.round(parsed.total || 0),
        boq_imported_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    res.json({
      ok: true,
      file_name: originalName,
      total: parsed.total,
      line_count: parsed.lineCount,
      counts: parsed.counts,
      template_saved: !!templateRef,
    });
  } catch (error) {
    console.error('Error (quote-compare import-template):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 見積比較 - 保存済み BOQ 行を取得（タブ1 数量書ツリー表示用）
app.get('/api/quote-compare/projects/:id/boq', requireAuth, requireQuoteCompareAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const [{ data: rows }, { data: project }] = await Promise.all([
      supabase.from('quote_boq_rows').select('*').eq('project_id', id).order('sort_order', { ascending: true }),
      supabase.from('quote_compare_projects').select('boq_total, boq_imported_at, template_filename').eq('id', id).maybeSingle(),
    ]);
    res.json({
      rows: rows || [],
      total: project?.boq_total ?? null,
      imported_at: project?.boq_imported_at ?? null,
      template_filename: project?.template_filename ?? null,
    });
  } catch (error) {
    console.error('Error (quote-compare boq get):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 見積比較 - 業者追加＋見積アップロード＋6類型 自動分類
//   multipart: name（業者名）, files（見積ファイル 1つ以上。1アップロード＝1業者）。
//   先頭ファイルで自動分類（媒体軸=拡張子/PDFテキスト層プローブ, 書式軸=シート/表題ヘッダ）。
app.post('/api/quote-compare/projects/:id/vendors', requireAuth, requireQuoteCompareAccess, upload.array('files', 10), async (req, res) => {
  try {
    const { id } = req.params;
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name（業者名）は必須です' });
    const { data: project, error } = await supabase
      .from('quote_compare_projects').select('id, name').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!project) return res.status(404).json({ error: 'プロジェクトが見つかりません' });
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'files（見積ファイル）を1つ以上添付してください' });

    // 先頭ファイルで自動分類（例外は classifyQuote 内で握り低確信フォールバック）
    const primary = files[0];
    const primaryName = decodeUploadName(primary.originalname);
    const cls = await classifyQuote({ buffer: primary.buffer, filename: primaryName });

    // 全ファイルを Drive 保存（失敗してもレコードは作る。参照は取れたものだけ）
    const driveIds = [];
    for (const f of files) {
      try {
        const ref = await storeQuoteFile({
          projectName: project.name, sub: '見積',
          fileName: `${name}__${decodeUploadName(f.originalname)}`,
          buffer: f.buffer, mimeType: f.mimetype || 'application/octet-stream',
        });
        driveIds.push(ref);
      } catch (e) {
        console.error('Warning (quote vendor file store):', e.message);
      }
    }

    const { data, error: insErr } = await supabase
      .from('quote_vendors')
      .insert({
        project_id: id,
        name,
        form_type: cls.form_type,
        medium: cls.medium,
        class_no: cls.class_no,
        auto_classified: true,
        classify_confidence: cls.confidence,
        source_drive_ids: driveIds,
        status: 'classified',
        created_by: req.user.email,
      })
      .select('*')
      .single();
    if (insErr) throw insErr;

    await supabase.from('quote_compare_projects')
      .update({ updated_at: new Date().toISOString() }).eq('id', id);

    res.json({ ...data, classify_signals: cls.signals || null, primary_file: primaryName });
  } catch (error) {
    console.error('Error (quote-compare add vendor):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 見積比較 - 分類の手動上書き（書式軸/媒体軸トグル）。class_no を再導出し auto_classified=false。
app.patch('/api/quote-compare/vendors/:id/classification', requireAuth, requireQuoteCompareAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: vendor, error } = await supabase
      .from('quote_vendors').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!vendor) return res.status(404).json({ error: '業者が見つかりません' });

    const formType = req.body?.form_type != null ? String(req.body.form_type) : vendor.form_type;
    const medium = req.body?.medium != null ? String(req.body.medium) : vendor.medium;
    if (!QC_FORM_TYPES.includes(formType)) return res.status(400).json({ error: 'form_type は official / vendor のいずれかです' });
    if (!QC_MEDIA.includes(medium)) return res.status(400).json({ error: 'medium は excel / text_pdf / image_pdf のいずれかです' });

    const { data, error: upErr } = await supabase
      .from('quote_vendors')
      .update({
        form_type: formType,
        medium,
        class_no: classNoOf(formType, medium),
        auto_classified: false,
        classify_confidence: 'high', // 人が確認・確定したので high
      })
      .eq('id', id)
      .select('*')
      .single();
    if (upErr) throw upErr;
    res.json(data);
  } catch (error) {
    console.error('Error (quote-compare reclassify):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 見積比較 - 業者削除
app.delete('/api/quote-compare/vendors/:id', requireAuth, requireQuoteCompareAccess, async (req, res) => {
  try {
    const { error } = await supabase.from('quote_vendors').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) {
    console.error('Error (quote-compare vendor delete):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── 見積比較 抽出（P2: PDFはローカルエージェントへキュー投入）──────────────
// 見積比較キューのルート（共有ドライブ root\04.見積比較\_queue\）。
const QC_QUEUE_SEGMENTS = ['04.見積比較', '_queue'];

// drive:<id> 参照から fileId を取り出す（接頭辞なしはそのまま）。
function driveIdOf(ref) {
  const s = String(ref || '');
  return s.startsWith('drive:') ? s.slice('drive:'.length) : s;
}

// Drive フォルダ内の name のファイルを探して JSON として読む（無ければ null）。
async function readDriveJson(folderId, name) {
  const kids = await driveListChildren(folderId);
  const f = kids.find((k) => k.name === name);
  if (!f) return null;
  const { buffer } = await driveDownload(f.id);
  try { return JSON.parse(buffer.toString('utf8')); } catch { return null; }
}

// ✅ 見積比較 - 抽出を実行。PDF(類型3-6)は共有ドライブの _queue に extract ジョブを投入し、
//    ローカル常駐エージェント（このPC）が処理する。Excel(類型1,2)直読は P1 で対応予定。
app.post('/api/quote-compare/vendors/:id/extract', requireAuth, requireQuoteCompareAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: vendor, error } = await supabase.from('quote_vendors').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!vendor) return res.status(404).json({ error: '業者が見つかりません' });
    if (!['text_pdf', 'image_pdf'].includes(vendor.medium)) {
      return res.status(400).json({ error: 'PDF(類型3-6)のみ抽出に対応しています。Excel直読(類型1,2)は P1 で対応予定です' });
    }
    if (!driveConfigured()) return res.status(503).json({ error: '共有ドライブ未設定のためキュー投入できません' });
    const srcIds = (Array.isArray(vendor.source_drive_ids) ? vendor.source_drive_ids : []).map(driveIdOf).filter(Boolean);
    if (!srcIds.length) return res.status(400).json({ error: 'この業者に見積ファイルが添付されていません' });

    // BOQ行（書き戻しの鍵 sheet/excel_row を持つ行のみ）をジョブに同梱
    const { data: boq } = await supabase.from('quote_boq_rows').select('*').eq('project_id', vendor.project_id).order('sort_order', { ascending: true });
    const boqRows = (boq || [])
      .filter((r) => r.sheet_name && r.excel_row != null)
      .map((r) => ({
        boq_row_id: r.id, sheet: r.sheet_name, row: r.excel_row,
        name: r.item_name, spec: r.spec, quantity_num: r.quantity_num, unit: r.unit, beppi_no: r.beppi_no,
      }));
    if (!boqRows.length) return res.status(400).json({ error: '先に原本数量書を取込んでください（BOQ行がありません）' });

    const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').slice(0, 15);
    const jobFolderId = await ensureFolderPath(
      [...QC_QUEUE_SEGMENTS, String(vendor.project_id), 'extract', `${vendor.id}__${ts}`],
      SHARED_DRIVE_ROOT_ID,
    );

    const job = {
      job_type: 'extract',
      project_id: vendor.project_id,
      vendor: { id: vendor.id, name: vendor.name, form_type: vendor.form_type, medium: vendor.medium, class_no: vendor.class_no },
      boq_rows: boqRows,
      options: {
        official_minimal: vendor.form_type === 'official',
        name_fallback: vendor.form_type === 'vendor',
        dpi: 200, jpg_quality: 65,
      },
    };
    await driveUpload({ name: 'extract_job.json', buffer: Buffer.from(JSON.stringify(job, null, 2), 'utf8'), mimeType: 'application/json', folderId: jobFolderId });

    // 見積PDFをジョブフォルダへ同梱（エージェントはキューフォルダだけ見れば完結）
    let n = 0;
    for (const fid of srcIds) {
      try {
        const { buffer } = await driveDownload(fid);
        n += 1;
        await driveUpload({ name: `source_${n}.pdf`, buffer, mimeType: 'application/pdf', folderId: jobFolderId });
      } catch (e) { console.error('Warning (quote extract source copy):', e.message); }
    }
    if (!n) return res.status(502).json({ error: '見積ファイルの取得に失敗しました' });

    await driveUpload({
      name: 'status.json',
      buffer: Buffer.from(JSON.stringify({ status: 'queued', message: '', updated_at: new Date().toISOString() }), 'utf8'),
      mimeType: 'application/json', folderId: jobFolderId,
    });

    await supabase.from('quote_vendors').update({ status: 'extracting' }).eq('id', vendor.id);
    res.json({ ok: true, job: `${vendor.id}__${ts}`, queued_files: n });
  } catch (error) {
    console.error('Error (quote-compare extract enqueue):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 見積比較 - 抽出ジョブの状態取得。done なら result.json を取り込み cells/unmatched を保存（画面ポーリング用）。
app.get('/api/quote-compare/vendors/:id/extract-status', requireAuth, requireQuoteCompareAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: vendor, error } = await supabase.from('quote_vendors').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!vendor) return res.status(404).json({ error: '業者が見つかりません' });
    if (!driveConfigured()) return res.json({ status: 'none' });

    const extractFolderId = await ensureFolderPath(
      [...QC_QUEUE_SEGMENTS, String(vendor.project_id), 'extract'],
      SHARED_DRIVE_ROOT_ID,
    );
    const jobs = (await driveListChildren(extractFolderId))
      .filter((k) => k.mimeType === 'application/vnd.google-apps.folder' && k.name.startsWith(`${vendor.id}__`))
      .sort((a, b) => (a.name < b.name ? 1 : -1)); // 最新(ts降順)
    if (!jobs.length) return res.json({ status: 'none' });
    const job = jobs[0];

    const status = await readDriveJson(job.id, 'status.json');
    const st = status?.status || 'queued';
    if (st !== 'done') {
      return res.json({ status: st, message: status?.message || '', already_imported: vendor.status === 'extracted' });
    }

    // done: まだ未取込なら result.json を取り込む（extracted を取込済の印にする）
    if (vendor.status !== 'extracted') {
      const result = await readDriveJson(job.id, 'result.json');
      if (!result) return res.json({ status: 'done', message: 'result.json 未到着（同期待ち）' });

      const qById = new Map((await supabase.from('quote_boq_rows').select('id, quantity_num').eq('project_id', vendor.project_id)).data?.map((r) => [r.id, r.quantity_num]) || []);
      const cells = (result.cells || []).map((c) => {
        const q = qById.get(c.boq_row_id);
        const amount = (c.unit_price != null && q != null) ? Math.round(c.unit_price * Math.abs(q)) : null;
        return {
          project_id: vendor.project_id, vendor_id: vendor.id, boq_row_id: c.boq_row_id,
          unit_price: c.unit_price ?? null, amount,
          match_type: c.match_type || null, sim: c.sim ?? null,
          source_label: c.source_label || null,
          confidence: c.match_type === 'qty' ? 'high' : 'review',
        };
      }).filter((c) => c.boq_row_id != null);

      const unmatched = (result.unmatched || []).map((u) => ({
        project_id: vendor.project_id, vendor_id: vendor.id,
        name: u.name || null, spec: u.spec || null, quantity: u.quantity ?? null, unit: u.unit || null,
        unit_price: u.unit_price ?? null,
        best_candidate: u.best_candidate != null ? { name: u.best_candidate, sim: u.sim ?? null } : null,
        sim: u.sim ?? null,
      }));

      // 既存を置換してから挿入（再取込の冪等性）
      await supabase.from('quote_cells').delete().eq('vendor_id', vendor.id);
      await supabase.from('quote_unmatched').delete().eq('vendor_id', vendor.id);
      for (let i = 0; i < cells.length; i += 200) {
        const { error: e } = await supabase.from('quote_cells').insert(cells.slice(i, i + 200));
        if (e) throw e;
      }
      if (unmatched.length) {
        const { error: e } = await supabase.from('quote_unmatched').insert(unmatched);
        if (e) throw e;
      }
      await supabase.from('quote_vendors').update({
        status: 'extracted',
        extracted_total: result.extracted_total != null ? Math.round(result.extracted_total) : null,
        excluded: Array.isArray(result.excluded) ? result.excluded : [],
      }).eq('id', vendor.id);

      return res.json({ status: 'done', imported: true, cells: cells.length, unmatched: unmatched.length, extracted_total: result.extracted_total ?? null });
    }

    // 既に取込済
    const [{ count: cc }, { count: uc }] = await Promise.all([
      supabase.from('quote_cells').select('id', { count: 'exact', head: true }).eq('vendor_id', vendor.id),
      supabase.from('quote_unmatched').select('id', { count: 'exact', head: true }).eq('vendor_id', vendor.id),
    ]);
    res.json({ status: 'done', imported: true, cells: cc || 0, unmatched: uc || 0, extracted_total: vendor.extracted_total });
  } catch (error) {
    console.error('Error (quote-compare extract-status):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// バグ報告・改善の利用権限（member 以上＝報告できる）。要 requireAuth 後段。
async function requireFeedbackAccess(req, res, next) {
  try {
    const r = await resolveFeedbackRole(req.user?.email);
    if (r.role === 'none') {
      return res.status(403).json({ error: 'バグ報告・改善の利用権限がありません' });
    }
    req.fbRole = r;
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

async function requireFeedbackAdmin(req, res, next) {
  try {
    const r = await resolveFeedbackRole(req.user?.email);
    if (r.role !== 'admin') {
      return res.status(403).json({ error: 'この操作はフィードバック管理者のみ可能です' });
    }
    req.fbRole = r;
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// 1件を Claude Code 向け Markdown ブロックに整形
function feedbackToMarkdown(f) {
  const typeIcon = f.type === 'bug' ? '🐞バグ' : '💡改善要望';
  const sev = f.severity ? ` / ${FEEDBACK_SEVERITY_LABELS[f.severity] || f.severity}` : '';
  const appName = FEEDBACK_APP_LABELS[f.app_key] || f.app_key || '不明';
  const appLine = f.app_label ? `${appName}（${f.app_label}）` : appName;
  const created = f.created_at ? new Date(f.created_at).toLocaleString('ja-JP') : '';
  const reporter = [f.reporter_name, f.reporter_email].filter(Boolean).join(' ');
  const lines = [];
  lines.push(`## [#${f.id}] ${typeIcon}${sev} — ${f.title}`);
  lines.push('');
  lines.push(`- **対象アプリ**: ${appLine} \`${f.app_key}\``);
  lines.push(`- **状態**: ${FEEDBACK_STATUS_LABELS[f.status] || f.status} / 優先度: ${FEEDBACK_PRIORITY_LABELS[f.priority] || f.priority}` +
    (f.frequency ? ` / 頻度: ${FEEDBACK_FREQ_LABELS[f.frequency] || f.frequency}` : ''));
  lines.push(`- **報告者**: ${reporter || '不明'} / ${created}`);
  if (f.page_url) lines.push(`- **発生ページ**: ${f.page_url}`);
  const env = [f.screen_info, f.app_version ? `ver ${f.app_version}` : null, f.user_agent]
    .filter(Boolean).join(' / ');
  if (env) lines.push(`- **環境**: ${env}`);
  lines.push('');
  if (f.description) { lines.push('**説明**', '', f.description, ''); }
  if (f.steps) { lines.push('**再現手順**', '', f.steps, ''); }
  if (f.expected) { lines.push('**期待する動作**', '', f.expected, ''); }
  if (f.actual) { lines.push('**実際の動作**', '', f.actual, ''); }
  const shots = Array.isArray(f.screenshot_urls) ? f.screenshot_urls : [];
  if (shots.length) {
    lines.push('**スクリーンショット**', '');
    for (const u of shots) lines.push(`- ${u}`);
    lines.push('');
  }
  if (f.admin_note) { lines.push('**管理メモ / 指示**', '', f.admin_note, ''); }
  return lines.join('\n');
}

// 複数件＋見出しを Markdown バックログに（エクスポート/ローカルスクリプト共通の体裁）
function buildFeedbackBacklog(rows, meta = {}) {
  const now = new Date().toLocaleString('ja-JP');
  const statusText = (meta.statuses || []).map((s) => FEEDBACK_STATUS_LABELS[s] || s).join('・') || 'すべて';
  const header = [
    '# バグ報告・改善要望 バックログ（Claude Code 向け）',
    '',
    `> 生成日時: ${now}`,
    `> 対象ステータス: ${statusText} ／ 全 ${rows.length} 件`,
    '>',
    '> 各項目を上から順に対応してください。着手時は status を `in_progress`、',
    '> 完了時は `done`（見送りは `wont_fix`）に更新します。',
    '> 更新はポータルの管理画面、または `PATCH /api/feedback/:id` で行えます。',
    '',
    '---',
    '',
  ].join('\n');
  if (rows.length === 0) {
    return header + '_対象のフィードバックはありません。_\n';
  }
  return header + rows.map(feedbackToMarkdown).join('\n\n---\n\n') + '\n';
}

// ✅ フィードバック - スクリーンショットアップロード（公開バケット feedback-photos）
//    固定パスのため :id ルートより前に定義する
app.post('/api/feedback/upload-photo', requireAuth, requireFeedbackAccess, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'photo フィールドが必要です' });
    await ensureFeedbackBucket();
    const ext = (req.file.originalname.split('.').pop() || 'png').toLowerCase();
    const path = `${Date.now()}-${uuidv4()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from(FEEDBACK_BUCKET)
      .upload(path, req.file.buffer, { contentType: req.file.mimetype });
    if (uploadError) throw uploadError;
    const { data: urlData } = supabase.storage.from(FEEDBACK_BUCKET).getPublicUrl(path);
    res.json({ url: urlData.publicUrl });
  } catch (error) {
    console.error('Error (feedback upload):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ フィードバック - Claude Code 向け Markdown バックログをエクスポート（管理者のみ）
//    固定パスのため :id ルートより前に定義する
//    ?status=new,triaged,in_progress（既定: 未完了の3状態） ?type=bug|improvement ?app=bids
app.get('/api/feedback/export', requireAuth, requireFeedbackAdmin, async (req, res) => {
  try {
    const statuses = (req.query.status
      ? String(req.query.status).split(',')
      : ['new', 'triaged', 'in_progress']
    ).map((s) => s.trim()).filter(Boolean);

    let query = supabase
      .from('feedback')
      .select('*')
      .eq('is_active', true)
      .in('status', statuses)
      // 優先度高→新しい順（priority は文字列のため JS 側で安定ソート）
      .order('created_at', { ascending: true });
    if (req.query.type) query = query.eq('type', req.query.type);
    if (req.query.app) query = query.eq('app_key', req.query.app);

    const { data, error } = await query;
    if (error) throw error;

    const prRank = { high: 0, normal: 1, low: 2 };
    const rows = (data || []).sort(
      (a, b) => (prRank[a.priority] ?? 1) - (prRank[b.priority] ?? 1)
    );

    const md = buildFeedbackBacklog(rows, { statuses });
    if (req.query.format === 'json') {
      return res.json({ count: rows.length, markdown: md, items: rows });
    }
    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.send(md);
  } catch (error) {
    console.error('Error (feedback export):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ フィードバック一覧（管理者=全件 / 一般=自分の報告のみ）
//    ?status= ?type= ?app= で絞り込み
app.get('/api/feedback', requireAuth, async (req, res) => {
  try {
    const email = String(req.user.email || '').toLowerCase();
    const fbRole = await resolveFeedbackRole(email);
    const isAdmin = fbRole.role === 'admin';

    let query = supabase
      .from('feedback')
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (!isAdmin) query = query.ilike('reporter_email', email);
    if (req.query.status) query = query.eq('status', req.query.status);
    if (req.query.type) query = query.eq('type', req.query.type);
    if (req.query.app) query = query.eq('app_key', req.query.app);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ is_admin: isAdmin, items: data || [] });
  } catch (error) {
    console.error('Error (feedback list):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ フィードバック詳細（管理者 or 本人）
app.get('/api/feedback/:id', requireAuth, async (req, res) => {
  try {
    const email = String(req.user.email || '').toLowerCase();
    const fbRole = await resolveFeedbackRole(email);
    const { data: f, error } = await supabase
      .from('feedback')
      .select('*')
      .eq('id', req.params.id)
      .eq('is_active', true)
      .maybeSingle();
    if (error) throw error;
    if (!f) return res.status(404).json({ error: 'フィードバックが見つかりません' });
    if (fbRole.role !== 'admin' && String(f.reporter_email || '').toLowerCase() !== email) {
      return res.status(403).json({ error: 'この報告へのアクセス権がありません' });
    }
    res.json({ ...f, markdown: feedbackToMarkdown(f) });
  } catch (error) {
    console.error('Error (feedback detail):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ フィードバック投稿（全社員）
app.post('/api/feedback', requireAuth, requireFeedbackAccess, async (req, res) => {
  try {
    const {
      type, title, app_key, app_label, description,
      steps, expected, actual, severity, frequency,
      page_url, user_agent, screen_info, app_version, screenshot_urls,
    } = req.body;

    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'タイトルを入力してください' });
    }
    const t = type === 'improvement' ? 'improvement' : 'bug';
    const validSeverity = ['low', 'medium', 'high', 'critical'].includes(severity) ? severity : null;
    const validFrequency = ['always', 'sometimes', 'once'].includes(frequency) ? frequency : null;

    const row = {
      type: t,
      title: String(title).trim(),
      app_key: app_key || 'portal',
      app_label: app_label || null,
      description: description || null,
      steps: steps || null,
      expected: expected || null,
      actual: actual || null,
      severity: t === 'bug' ? validSeverity : null,
      frequency: t === 'bug' ? validFrequency : null,
      page_url: page_url || null,
      user_agent: user_agent || null,
      screen_info: screen_info || null,
      app_version: app_version || null,
      screenshot_urls: Array.isArray(screenshot_urls) ? screenshot_urls.filter(Boolean) : [],
      reporter_email: req.user.email || null,
      reporter_name: req.user.name || null,
    };

    const { data, error } = await supabase.from('feedback').insert([row]).select();
    if (error) throw error;
    res.json(data[0]);
  } catch (error) {
    console.error('Error (feedback create):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ フィードバック更新（トリアージ: 管理者のみ）
//    status / priority / admin_note / resolution_note を更新
app.patch('/api/feedback/:id', requireAuth, requireFeedbackAdmin, async (req, res) => {
  try {
    const { status, priority, admin_note, resolution_note } = req.body;
    const patch = { updated_at: new Date().toISOString() };
    if (status !== undefined) {
      if (!['new', 'triaged', 'in_progress', 'done', 'wont_fix'].includes(status)) {
        return res.status(400).json({ error: '不正なステータスです' });
      }
      patch.status = status;
    }
    if (priority !== undefined) {
      if (!['low', 'normal', 'high'].includes(priority)) {
        return res.status(400).json({ error: '不正な優先度です' });
      }
      patch.priority = priority;
    }
    if (admin_note !== undefined) patch.admin_note = admin_note || null;
    if (resolution_note !== undefined) patch.resolution_note = resolution_note || null;

    const { data, error } = await supabase
      .from('feedback')
      .update(patch)
      .eq('id', req.params.id)
      .select();
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: 'フィードバックが見つかりません' });
    res.json(data[0]);
  } catch (error) {
    console.error('Error (feedback update):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ フィードバック削除（論理削除: 管理者のみ）
app.delete('/api/feedback/:id', requireAuth, requireFeedbackAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from('feedback')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) {
    console.error('Error (feedback delete):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ✅ 文書回覧 API
//    - 閲覧: 宛先に一致する認証済みユーザー全員
//    - 既読/フラグ/対応: 閲覧権限があれば可
//    - 管理（アップロード/作成/編集/削除/到達率）: documents の admin のみ
// ============================================================

// 文書回覧アプリにおける本人ロールを解決
//  - グローバル管理者（ADMIN_EMAILS / staff_master.app_role='admin'）は常に 'admin'
//  - それ以外は staff_app_permissions の 'documents' を見る（admin / member / none）
async function resolveDocRole(email) {
  const perms = await resolvePermissions(email); // { role, staffId }
  if (perms.role === 'admin') return { role: 'admin', staffId: perms.staffId };
  let level = null;
  if (perms.staffId) {
    const { data } = await supabase
      .from('staff_app_permissions')
      .select('access_level')
      .eq('staff_id', perms.staffId)
      .eq('app_key', 'documents')
      .maybeSingle();
    level = data?.access_level || null;
  }
  const role = level === 'admin' ? 'admin' : level ? 'member' : 'none';
  return { role, staffId: perms.staffId };
}

// 文書回覧管理者のみ許可するミドルウェア（要 requireAuth 後段）
async function requireDocAdmin(req, res, next) {
  try {
    const r = await resolveDocRole(req.user?.email);
    if (r.role !== 'admin') {
      return res.status(403).json({ error: 'この操作は文書回覧の管理者のみ可能です' });
    }
    req.docRole = r;
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ── ストレージ抽象（証明書と同型） ────────────────────────────────

// 文書回覧の原本を入れる Supabase Storage バケット（非公開）。
const CIRCULAR_BUCKET = 'circular-files';
let circularBucketEnsured = false;
async function ensureCircularBucket() {
  if (circularBucketEnsured) return;
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw error;
  if (!buckets?.some((b) => b.name === CIRCULAR_BUCKET)) {
    const { error: createError } = await supabase.storage.createBucket(CIRCULAR_BUCKET, { public: false });
    if (createError && !/exist/i.test(createError.message || '')) throw createError;
  }
  circularBucketEnsured = true;
}

// 保存先の方針: 'drive'（既定）で共有ドライブ、それ以外は Supabase。
// Drive 連携の環境変数が揃っていない場合は安全に Supabase へフォールバック。
const CIRCULAR_STORAGE = (process.env.CIRCULAR_STORAGE || 'drive').toLowerCase();

// 文書回覧の Drive 保存ルート（共有ドライブ「社内システム」直下）。
// 資格者証(DRIVE_FOLDER_ID)とは別フォルダに出すため専用ルートを使う。env で上書き可。
const CIRCULAR_DRIVE_FOLDER_ID = process.env.CIRCULAR_DRIVE_FOLDER_ID || '0AK5TgtO_Sr4RUk9PVA';

// 回覧書類ファイルを方針に従って保存し、DBの original_ref に入れる「参照」を返す。
//   Drive   : "drive:<fileId>"（接頭辞で見分ける）。segments があれば サブフォルダへ自動格納。
//   Supabase: バケット内のパス（例 "docs/xxx.pdf"）
async function storeCircular(pathKey, buffer, mimeType, segments) {
  if (CIRCULAR_STORAGE === 'drive' && driveConfigured()) {
    const folderId = segments && segments.length
      ? await ensureFolderPath(segments, CIRCULAR_DRIVE_FOLDER_ID)
      : CIRCULAR_DRIVE_FOLDER_ID;
    const name = String(pathKey).split('/').pop();
    const fileId = await driveUpload({ name, buffer, mimeType, folderId });
    return `drive:${fileId}`;
  }
  await ensureCircularBucket();
  const { error } = await supabase.storage.from(CIRCULAR_BUCKET).upload(pathKey, buffer, { contentType: mimeType, upsert: true });
  if (error) throw error;
  return pathKey;
}

// 回覧書類を一時表示するための URL（既定 1 時間）。
//   "drive:" 参照 → 署名トークン付きの API プロキシURL（/api/circular-file）
//   それ以外      → Supabase の署名付きURL
async function circularSignedUrl(ref, expiresIn = 3600) {
  if (!ref) return null;
  if (String(ref).startsWith('drive:')) {
    const fileId = String(ref).slice('drive:'.length);
    const token = jwt.sign({ fileId, kind: 'circular' }, JWT_SECRET, { expiresIn });
    const base = process.env.PUBLIC_API_URL || 'https://portal-api-hhlx.onrender.com';
    return `${base}/api/circular-file?t=${encodeURIComponent(token)}`;
  }
  const { data } = await supabase.storage.from(CIRCULAR_BUCKET).createSignedUrl(ref, expiresIn);
  return data?.signedUrl || null;
}

// 署名トークンで保護された回覧書類プロキシ。Drive 上の非公開ファイルを API 経由で配信する。
app.get('/api/circular-file', async (req, res) => {
  try {
    const token = req.query.t;
    if (!token) return res.status(400).send('missing token');
    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).send('invalid or expired token');
    }
    if (payload.kind !== 'circular' || !payload.fileId) return res.status(400).send('bad token');
    const { buffer, contentType } = await driveDownload(payload.fileId);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.send(buffer);
  } catch (error) {
    console.error('Error (circular-file proxy):', error.message);
    res.status(error.status || 500).send(error.message);
  }
});

// ── Gemini による束ねPDF分割解析 ─────────────────────────────────

// まとめてスキャンした回覧書類PDF/画像を Gemini に1回渡し、
// 書類の境界と内容を { start_page, end_page, doc_type, sender, title, ocr_text } の配列で返す。
async function analyzeCircularBatch(buffer, mimeType) {
  if (!GEMINI_API_KEY) {
    const e = new Error('GEMINI_API_KEY が未設定です。Render の環境変数に設定してください。');
    e.status = 503;
    throw e;
  }

  const prompt = [
    'これはまとめてスキャンした社内回覧書類のPDF/画像です。',
    '書類の境界を判定し、各書類を1要素として返してください。',
    '1枚の用紙が1つの書類に対応することが多いですが、複数ページにわたる書類もあります。',
    '',
    '【フィールド説明】',
    '- start_page: この書類が始まるページ番号（1始まり）',
    '- end_page:   この書類が終わるページ番号（1始まり。1ページのみなら start_page と同値）',
    '- doc_type:   書類の種別。次のいずれか1つ: 通達 / 案内 / 依頼 / 報告 / その他',
    '- sender:     発信元・差出人（機関名・部署名。読めなければ空文字）',
    '- title:      書類のタイトル・件名（書かれているタイトルをそのまま読み取る。読めなければ空文字）',
    '- ocr_text:   この書類に書かれている本文テキスト全体（検索インデックス用。読み取れる範囲で。改行は \\n で）',
    '',
    '読み取れない項目は空文字にしてください。推測で埋めないでください。',
  ].join('\n');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: mimeType || 'application/pdf', data: buffer.toString('base64') } },
      ],
    }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      maxOutputTokens: 32768,
      responseSchema: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            start_page: { type: 'INTEGER' },
            end_page:   { type: 'INTEGER' },
            doc_type:   { type: 'STRING', enum: ['通達', '案内', '依頼', '報告', 'その他'] },
            sender:     { type: 'STRING' },
            title:      { type: 'STRING' },
            ocr_text:   { type: 'STRING' },
          },
          required: ['start_page', 'end_page', 'title'],
        },
      },
    },
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text();
    const e = new Error(`Gemini API エラー (${resp.status}): ${t.slice(0, 300)}`);
    e.status = 502;
    throw e;
  }
  const json = await resp.json();
  const cand = json?.candidates?.[0];
  if (cand?.finishReason === 'MAX_TOKENS') {
    const e = new Error('PDFの情報量が多く、AIが読み切れませんでした。書類を分割してアップロードしてください。');
    e.status = 413;
    throw e;
  }
  const text = cand?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini から有効な応答が得られませんでした');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('Gemini 応答の解析に失敗しました'); }
  if (!Array.isArray(parsed)) throw new Error('Gemini 応答が配列形式ではありません');
  return parsed;
}

// ── pdf-lib によるページ範囲分割 ─────────────────────────────────

// buffer（PDFバイト列）から startPage〜endPage（1始まり）を切り出して新しい PDF Buffer を返す。
// 画像ファイルはそのまま返す（mime が image/* の場合はスキップを呼び出し側で判断）。
async function splitPdfByRange(buffer, startPage, endPage) {
  const srcDoc = await PDFDocument.load(buffer);
  const total = srcDoc.getPageCount();
  // ページ番号を 0 始まりにクランプ
  const from = Math.max(0, (startPage || 1) - 1);
  const to   = Math.min(total - 1, (endPage || total) - 1);
  const newDoc = await PDFDocument.create();
  const indices = [];
  for (let i = from; i <= to; i++) indices.push(i);
  const copied = await newDoc.copyPages(srcDoc, indices);
  for (const page of copied) newDoc.addPage(page);
  const bytes = await newDoc.save();
  return Buffer.from(bytes);
}

// ── 文書回覧の宛先一致チェック（isAudienceMatch の文書回覧版） ────

// targets: circular_targets の配列 [{kind, value}]
// profile: { staffId, company, department } + email
function isCircularAudienceMatch(doc, targets, profile, email) {
  if (doc.target_type === 'all') return true;
  const lowerEmail = String(email || '').toLowerCase();
  return (targets || []).some((t) => {
    if (t.kind === 'company') return t.value === profile.company;
    if (t.kind === 'department') return t.value === profile.department;
    if (t.kind === 'user') return String(t.value || '').toLowerCase() === lowerEmail;
    return false;
  });
}

// ── API エンドポイント ──────────────────────────────────────────

// ✅ 文書回覧 - バッチ解析（POST /api/circulars/analyze）※ 管理者のみ
//    ファイルを受領してGeminiに掛け、書類境界の解析結果を返す（DBには保存しない）。
app.post('/api/circulars/analyze', requireAuth, requireDocAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file フィールドが必要です' });

    const buffer = req.file.buffer;
    const mimeType = req.file.mimetype;
    const isImage = mimeType.startsWith('image/');

    // 一時領域に保存して batch_ref を取得
    const year = new Date().getFullYear();
    const tmpName = `tmp_${Date.now()}_${uuidv4()}.${isImage ? mimeType.split('/')[1] : 'pdf'}`;
    const tmpRef = await storeCircular(`tmp/${tmpName}`, buffer, mimeType, ['07.文書回覧', '_一時']);

    let splits;
    if (isImage) {
      // 画像は 1 書類扱い
      splits = [{ start_page: 1, end_page: 1, doc_type: 'その他', sender: '', title: '', ocr_text: '' }];
    } else {
      splits = await analyzeCircularBatch(buffer, mimeType);
    }

    // PDF のページ数を取得（pdf-lib で計算）
    let page_count = 1;
    if (!isImage) {
      try {
        const srcDoc = await PDFDocument.load(buffer);
        page_count = srcDoc.getPageCount();
      } catch {
        page_count = splits.length;
      }
    }

    res.json({ batch_ref: tmpRef, page_count, splits });
  } catch (error) {
    console.error('Error (circulars analyze):', error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ✅ 文書回覧 - 一括登録（POST /api/circulars）※ 管理者のみ
//    analyze で得た batch_ref と編集済み splits を受け取り、各書類を分割・保存・DB登録する。
app.post('/api/circulars', requireAuth, requireDocAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const { batch_ref, documents } = b;
    if (!batch_ref) return res.status(400).json({ error: 'batch_ref は必須です' });
    if (!Array.isArray(documents) || documents.length === 0) return res.status(400).json({ error: 'documents は空にできません' });

    // バッチIDを生成（同一アップロードを束ねる）
    const batch_id = uuidv4();

    // 原本バッファを Drive/Supabase から取得
    let srcBuffer = null;
    let srcMime = 'application/pdf';
    if (String(batch_ref).startsWith('drive:')) {
      const fileId = String(batch_ref).slice('drive:'.length);
      const dl = await driveDownload(fileId);
      srcBuffer = dl.buffer;
      srcMime = dl.contentType || 'application/pdf';
    } else {
      // Supabase バケットからダウンロード
      const { data, error: dlErr } = await supabase.storage.from(CIRCULAR_BUCKET).download(batch_ref);
      if (dlErr) throw dlErr;
      srcBuffer = Buffer.from(await data.arrayBuffer());
    }

    const isImage = srcMime.startsWith('image/');
    const year = String(new Date().getFullYear());
    const createdIds = [];

    for (const doc of documents) {
      const {
        start_page = 1, end_page = 1, title, doc_type = 'その他',
        sender = '', ocr_text = '', target_type = 'all', targets = [],
      } = doc;

      if (!title?.trim()) continue; // タイトル無しはスキップ

      // ページ分割（画像はそのまま）
      let docBuffer;
      let docMime;
      let docSize;
      if (isImage) {
        docBuffer = srcBuffer;
        docMime = srcMime;
        docSize = srcBuffer.length;
      } else {
        docBuffer = await splitPdfByRange(srcBuffer, start_page, end_page);
        docMime = 'application/pdf';
        docSize = docBuffer.length;
      }

      // ファイル保存
      const ext = isImage ? (srcMime.split('/')[1] || 'jpg') : 'pdf';
      const fileName = `${Date.now()}_${uuidv4()}.${ext}`;
      const docRef = await storeCircular(
        `docs/${year}/${fileName}`,
        docBuffer,
        docMime,
        ['07.文書回覧', year, sanitizeSeg(doc_type || 'その他')],
      );

      // circular_documents 挿入
      const { data: inserted, error: insErr } = await supabase
        .from('circular_documents')
        .insert([{
          batch_id,
          title: title.trim(),
          doc_type: doc_type || null,
          sender: sender || null,
          original_ref: docRef,
          mime: docMime,
          size: docSize,
          page_from: isImage ? null : start_page,
          page_to:   isImage ? null : end_page,
          ocr_text:  ocr_text || null,
          target_type: ['all', 'company', 'department', 'user'].includes(target_type) ? target_type : 'all',
          created_by: req.user.email,
        }])
        .select('id');
      if (insErr) throw insErr;
      const docId = inserted[0].id;
      createdIds.push(docId);

      // 宛先 targets 挿入（target_type !== 'all' の場合）
      const validTargets = (targets || []).filter(
        (t) => t && ['company', 'department', 'user'].includes(t.kind) && t.value,
      );
      if (validTargets.length > 0) {
        const targetRows = validTargets.map((t) => ({ document_id: docId, kind: t.kind, value: t.value }));
        const { error: tErr } = await supabase.from('circular_targets').insert(targetRows);
        if (tErr) throw tErr;
      }
    }

    // 一時ファイルを削除（失敗しても無視）
    try {
      if (String(batch_ref).startsWith('drive:')) {
        await driveTrash(String(batch_ref).slice('drive:'.length));
      } else {
        await supabase.storage.from(CIRCULAR_BUCKET).remove([batch_ref]);
      }
    } catch {
      // 一時ファイル削除の失敗は無視
    }

    res.json({ created: createdIds.length, batch_id });
  } catch (error) {
    console.error('Error (circulars create):', error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ✅ 文書回覧 一覧（GET /api/circulars）
//    ?unread_only=1  未読のみ
//    ?action=要対応   フラグ絞り込み
//    ?manage=1       管理者用: 宛先フィルタなし・全件
app.get('/api/circulars', requireAuth, async (req, res) => {
  try {
    const email = String(req.user.email || '').toLowerCase();
    const docRole = await resolveDocRole(email);
    const profile = await resolveStaffProfile(email);
    const isManage = req.query.manage === '1' && docRole.role === 'admin';

    // 書類本体を取得（activeのみ）
    const { data: rows, error } = await supabase
      .from('circular_documents')
      .select('*')
      .eq('status', 'active')
      .order('created_at', { ascending: false });
    if (error) throw error;
    const docs = rows || [];

    // 宛先を一括取得
    const docIds = docs.map((d) => d.id);
    let targetsMap = {};
    if (docIds.length > 0) {
      const { data: tRows, error: tErr } = await supabase
        .from('circular_targets')
        .select('document_id, kind, value')
        .in('document_id', docIds);
      if (tErr) throw tErr;
      for (const t of tRows || []) {
        (targetsMap[t.document_id] ||= []).push(t);
      }
    }

    // 自分のレスポンスを一括取得
    let responseMap = {};
    if (docIds.length > 0) {
      const { data: rRows, error: rErr } = await supabase
        .from('circular_responses')
        .select('document_id, read_at, action_label, action_status')
        .eq('user_email', email)
        .in('document_id', docIds);
      if (rErr) throw rErr;
      for (const r of rRows || []) responseMap[r.document_id] = r;
    }

    // フィルタ・整形
    const result = [];
    for (const doc of docs) {
      // 宛先フィルタ（管理モードでない場合）
      if (!isManage && !isCircularAudienceMatch(doc, targetsMap[doc.id] || [], profile, email)) continue;

      const resp = responseMap[doc.id] || null;
      const is_read = !!resp?.read_at;

      // unread_only フィルタ
      if (req.query.unread_only === '1' && is_read) continue;
      // action フィルタ
      if (req.query.action && resp?.action_label !== req.query.action) continue;

      result.push({
        id: doc.id,
        title: doc.title,
        doc_type: doc.doc_type,
        sender: doc.sender,
        summary: doc.summary,
        created_at: doc.created_at,
        status: doc.status,
        target_type: doc.target_type,
        read: is_read,
        action_label: resp?.action_label || null,
        action_status: resp?.action_status || null,
      });
    }

    res.json(result);
  } catch (error) {
    console.error('Error (circulars list):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 文書回覧 インボックスカウント（GET /api/circulars/inbox-count）← 固定パスのため :id より前に定義
app.get('/api/circulars/inbox-count', requireAuth, async (req, res) => {
  try {
    const email = String(req.user.email || '').toLowerCase();
    const profile = await resolveStaffProfile(email);

    // active な書類を全取得
    const { data: rows, error } = await supabase
      .from('circular_documents')
      .select('id, target_type')
      .eq('status', 'active');
    if (error) throw error;
    const docs = rows || [];

    const docIds = docs.map((d) => d.id);
    let targetsMap = {};
    if (docIds.length > 0) {
      const { data: tRows, error: tErr } = await supabase
        .from('circular_targets')
        .select('document_id, kind, value')
        .in('document_id', docIds);
      if (tErr) throw tErr;
      for (const t of tRows || []) {
        (targetsMap[t.document_id] ||= []).push(t);
      }
    }

    // 自分のレスポンスを取得
    let responseMap = {};
    if (docIds.length > 0) {
      const { data: rRows, error: rErr } = await supabase
        .from('circular_responses')
        .select('document_id, read_at, action_label, action_status')
        .eq('user_email', email)
        .in('document_id', docIds);
      if (rErr) throw rErr;
      for (const r of rRows || []) responseMap[r.document_id] = r;
    }

    let unread = 0;
    let action_required_pending = 0;
    for (const doc of docs) {
      if (!isCircularAudienceMatch(doc, targetsMap[doc.id] || [], profile, email)) continue;
      const resp = responseMap[doc.id] || null;
      if (!resp?.read_at) unread++;
      if (resp?.action_label === '要対応' && resp?.action_status !== '対応済') action_required_pending++;
    }

    res.json({ unread, action_required_pending });
  } catch (error) {
    console.error('Error (circulars inbox-count):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 文書回覧 詳細（GET /api/circulars/:id）
//    宛先チェック後、詳細データ・署名URL・自分の対応状況を返す。
//    同時に当該ユーザーの read_at を未設定なら now() で自動セット（自動既読）。
app.get('/api/circulars/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const email = String(req.user.email || '').toLowerCase();
    const docRole = await resolveDocRole(email);
    const profile = await resolveStaffProfile(email);

    const { data: doc, error } = await supabase
      .from('circular_documents')
      .select('*')
      .eq('id', id)
      .eq('status', 'active')
      .maybeSingle();
    if (error) throw error;
    if (!doc) return res.status(404).json({ error: '書類が見つかりません' });

    const { data: targets, error: tErr } = await supabase
      .from('circular_targets')
      .select('id, kind, value')
      .eq('document_id', id);
    if (tErr) throw tErr;

    // 閲覧権限チェック（admin はスキップ）
    if (docRole.role !== 'admin') {
      if (!isCircularAudienceMatch(doc, targets || [], profile, email)) {
        return res.status(403).json({ error: 'この書類へのアクセス権がありません' });
      }
    }

    // 自動既読: read_at が null の場合のみ upsert
    const now = new Date().toISOString();
    const { data: existingResp } = await supabase
      .from('circular_responses')
      .select('id, read_at, action_label, action_status, note')
      .eq('document_id', Number(id))
      .eq('user_email', email)
      .maybeSingle();

    if (!existingResp?.read_at) {
      await supabase
        .from('circular_responses')
        .upsert(
          {
            document_id: Number(id),
            user_email: email,
            read_at: now,
            updated_at: now,
            ...(existingResp ? {} : { created_at: now }),
          },
          { onConflict: 'document_id,user_email' },
        );
    }

    const original_url = await circularSignedUrl(doc.original_ref);

    res.json({
      ...doc,
      targets: targets || [],
      original_url,
      my: {
        read_at: existingResp?.read_at || now,
        action_label: existingResp?.action_label || null,
        action_status: existingResp?.action_status || null,
        note: existingResp?.note || null,
      },
    });
  } catch (error) {
    console.error('Error (circular detail):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 文書回覧 フラグ設定（POST /api/circulars/:id/flag）
//    action_label（要対応 / 重要）と任意メモを設定する。
app.post('/api/circulars/:id/flag', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const email = String(req.user.email || '').toLowerCase();
    const { action_label, note } = req.body || {};

    if (!['要対応', '重要'].includes(action_label)) {
      return res.status(400).json({ error: 'action_label は「要対応」または「重要」を指定してください' });
    }

    const now = new Date().toISOString();
    // 要対応 かつ action_status 未設定なら '未対応' をセット
    const { data: existing } = await supabase
      .from('circular_responses')
      .select('action_status, read_at')
      .eq('document_id', Number(id))
      .eq('user_email', email)
      .maybeSingle();

    const upsertData = {
      document_id: Number(id),
      user_email: email,
      action_label,
      updated_at: now,
      read_at: existing?.read_at || now,
    };
    if (note !== undefined) upsertData.note = note || null;
    if (action_label === '要対応' && !existing?.action_status) {
      upsertData.action_status = '未対応';
    }

    const { error } = await supabase
      .from('circular_responses')
      .upsert(upsertData, { onConflict: 'document_id,user_email' });
    if (error) throw error;

    res.json({ ok: true });
  } catch (error) {
    console.error('Error (circular flag):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 文書回覧 対応完了（POST /api/circulars/:id/action-done）
//    自分の action_status を '対応済' に更新する。
app.post('/api/circulars/:id/action-done', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const email = String(req.user.email || '').toLowerCase();
    const now = new Date().toISOString();

    const { data: existing } = await supabase
      .from('circular_responses')
      .select('read_at')
      .eq('document_id', Number(id))
      .eq('user_email', email)
      .maybeSingle();

    const { error } = await supabase
      .from('circular_responses')
      .upsert(
        {
          document_id: Number(id),
          user_email: email,
          action_status: '対応済',
          read_at: existing?.read_at || now,
          updated_at: now,
        },
        { onConflict: 'document_id,user_email' },
      );
    if (error) throw error;

    res.json({ ok: true });
  } catch (error) {
    console.error('Error (circular action-done):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 文書回覧 到達率（GET /api/circulars/:id/responses）※ 管理者のみ
app.get('/api/circulars/:id/responses', requireAuth, requireDocAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: doc, error: docErr } = await supabase
      .from('circular_documents')
      .select('id, target_type')
      .eq('id', id)
      .maybeSingle();
    if (docErr) throw docErr;
    if (!doc) return res.status(404).json({ error: '書類が見つかりません' });

    const { data: responses, error: rErr } = await supabase
      .from('circular_responses')
      .select('user_email, read_at, action_label, action_status')
      .eq('document_id', id);
    if (rErr) throw rErr;

    const respList = responses || [];
    const summary = {
      read: respList.filter((r) => r.read_at).length,
      要対応: respList.filter((r) => r.action_label === '要対応').length,
      重要:   respList.filter((r) => r.action_label === '重要').length,
      対応済: respList.filter((r) => r.action_status === '対応済').length,
    };

    res.json({ document_id: Number(id), responses: respList, summary });
  } catch (error) {
    console.error('Error (circular responses):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 文書回覧 更新（PUT /api/circulars/:id）※ 管理者のみ
//    title / doc_type / sender / target_type / targets / status を更新する。
app.put('/api/circulars/:id', requireAuth, requireDocAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body || {};

    const { data: existing, error: existErr } = await supabase
      .from('circular_documents')
      .select('id, target_type')
      .eq('id', id)
      .maybeSingle();
    if (existErr) throw existErr;
    if (!existing) return res.status(404).json({ error: '書類が見つかりません' });

    const allowed = ['title', 'doc_type', 'sender', 'target_type', 'status', 'summary'];
    const patch = { updated_at: new Date().toISOString() };
    for (const k of allowed) {
      if (b[k] !== undefined) patch[k] = b[k];
    }
    if (patch.target_type !== undefined && !['all', 'company', 'department', 'user'].includes(patch.target_type)) {
      patch.target_type = 'all';
    }
    if (patch.status !== undefined && !['active', 'archived'].includes(patch.status)) {
      delete patch.status;
    }

    const { data, error } = await supabase
      .from('circular_documents')
      .update(patch)
      .eq('id', id)
      .select();
    if (error) throw error;
    const updated = data[0];

    // targets が渡されたら入れ替え
    if (b.targets !== undefined) {
      await supabase.from('circular_targets').delete().eq('document_id', id);
      const newTargetType = updated.target_type;
      if (newTargetType !== 'all' && Array.isArray(b.targets) && b.targets.length > 0) {
        const targetRows = b.targets
          .filter((t) => t && ['company', 'department', 'user'].includes(t.kind) && t.value)
          .map((t) => ({ document_id: updated.id, kind: t.kind, value: t.value }));
        if (targetRows.length > 0) {
          const { error: tErr } = await supabase.from('circular_targets').insert(targetRows);
          if (tErr) throw tErr;
        }
      }
    }

    res.json(updated);
  } catch (error) {
    console.error('Error (circular update):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 文書回覧 削除（DELETE /api/circulars/:id）※ 管理者のみ
//    原本ファイルを削除してからレコードを削除する。
app.delete('/api/circulars/:id', requireAuth, requireDocAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: doc, error: docErr } = await supabase
      .from('circular_documents')
      .select('id, original_ref')
      .eq('id', id)
      .maybeSingle();
    if (docErr) throw docErr;
    if (!doc) return res.status(404).json({ error: '書類が見つかりません' });

    // 原本ファイルを削除
    if (doc.original_ref) {
      try {
        if (String(doc.original_ref).startsWith('drive:')) {
          await driveTrash(String(doc.original_ref).slice('drive:'.length));
        } else {
          await supabase.storage.from(CIRCULAR_BUCKET).remove([doc.original_ref]);
        }
      } catch (e) {
        console.warn('circular ファイル削除失敗（無視）:', e.message);
      }
    }

    // レコード削除（circular_targets / circular_responses は CASCADE で自動削除）
    const { error } = await supabase.from('circular_documents').delete().eq('id', id);
    if (error) throw error;

    res.json({ ok: true });
  } catch (error) {
    console.error('Error (circular delete):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ===== 法令集 API =====  ← migration 030
//   e-Gov法令APIから取込んだ条文データの検索・閲覧・ブックマーク。
//   - 閲覧・検索・ブックマーク : requireRegulationsAccess（member 以上）
//   - 同期スタブ              : requireRegulationsAdmin（admin のみ）
//   権限は staff_app_permissions['regulations'] で管理。
//   出典: 出典：e-Gov法令検索（https://laws.e-gov.go.jp/）
// ============================================================

// 法令集のロール解決（app_key='regulations'）。construction と同じ方式。
async function resolveRegulationsRole(email) {
  const perms = await resolvePermissions(email); // { role, staffId } グローバル
  if (perms.role === 'admin') return { role: 'admin', access: true, staffId: perms.staffId, globalAdmin: true };
  let level = null;
  if (perms.staffId) {
    const { data } = await supabase
      .from('staff_app_permissions')
      .select('access_level')
      .eq('staff_id', perms.staffId)
      .eq('app_key', 'regulations')
      .maybeSingle();
    level = data?.access_level || null;
  }
  const role = level === 'admin' ? 'admin' : level ? 'member' : 'none';
  return { role, access: role !== 'none', staffId: perms.staffId, globalAdmin: false };
}

// 法令集の閲覧権限（member 以上）。要 requireAuth 後段。
async function requireRegulationsAccess(req, res, next) {
  try {
    const r = await resolveRegulationsRole(req.user.email);
    if (!r.access) return res.status(403).json({ error: '法令集へのアクセス権がありません' });
    req.regRole = r;
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// 法令集の管理権限（admin のみ）。要 requireAuth 後段。
async function requireRegulationsAdmin(req, res, next) {
  try {
    const r = await resolveRegulationsRole(req.user.email);
    if (r.role !== 'admin') return res.status(403).json({ error: 'この操作は法令集の管理者のみ可能です' });
    req.regRole = r;
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// 分類コードと日本語ラベルの固定マスタ（e-Gov 事項別分類コードに基づく社内絞り込み用）
const REGULATIONS_CATEGORY_MAP = [
  { code: '47', label: '建設業' },
  { code: '22', label: '建築・住宅' },
  { code: '23', label: '土地' },
  { code: '09', label: '林業' },
  { code: '03', label: '労働基準' },
  { code: '04', label: '職業安定・雇用対策' },
  { code: '05', label: '労働安全衛生' },
  { code: '13', label: '民法・商法' },
  { code: '14', label: '会社法' },
  { code: '17', label: '税務' },
];

// snippet: 条文 content の中からキーワード周辺 ±60文字を抽出するJS側ユーティリティ
function extractSnippet(text, keyword, radius) {
  if (!text || !keyword) return text ? text.slice(0, 120) : '';
  const r = radius != null ? radius : 60;
  const idx = text.toLowerCase().indexOf(String(keyword).toLowerCase());
  if (idx < 0) return text.slice(0, 120);
  const start = Math.max(0, idx - r);
  const end   = Math.min(text.length, idx + keyword.length + r);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

// 条文リストから編章節の階層ツリーを構築するJS側ユーティリティ
// articles: regulations_article[] を sort_order 昇順で渡す
// 返値: [ { level:'part'|'chapter'|'section'|'article', num, title, articles:[...] } ]
function buildTocTree(articles) {
  const toc = [];
  let curPart = null, curChapter = null, curSection = null;

  for (const a of articles) {
    // 編
    const partKey = a.part_num ? `${a.part_num}|${a.part_title || ''}` : null;
    if (partKey && (!curPart || curPart.key !== partKey)) {
      curPart = { key: partKey, level: 'part', num: a.part_num, title: a.part_title || null, chapters: [] };
      toc.push(curPart);
      curChapter = null;
      curSection = null;
    }
    // 章
    const chapKey = a.chapter_num ? `${a.chapter_num}|${a.chapter_title || ''}` : null;
    if (chapKey && (!curChapter || curChapter.key !== chapKey)) {
      curChapter = { key: chapKey, level: 'chapter', num: a.chapter_num, title: a.chapter_title || null, sections: [] };
      (curPart ? curPart.chapters : toc).push(curChapter);
      curSection = null;
    }
    // 節
    const secKey = a.section_num ? `${a.section_num}|${a.section_title || ''}` : null;
    if (secKey && (!curSection || curSection.key !== secKey)) {
      curSection = { key: secKey, level: 'section', num: a.section_num, title: a.section_title || null, articles: [] };
      (curChapter ? curChapter.sections : curPart ? curPart.chapters : toc).push(curSection);
    }
    // 条（目次用に最小情報のみ）
    const artEntry = { level: 'article', id: a.id, num: a.article_num, caption: a.article_caption || null };
    if (curSection) {
      curSection.articles.push(artEntry);
    } else if (curChapter) {
      curChapter.sections.push(artEntry);
    } else if (curPart) {
      curPart.chapters.push(artEntry);
    } else {
      toc.push(artEntry);
    }
  }
  return toc;
}

// ✅ 法令集 - フィルタ用メタ情報（ドメイン一覧・分類・法令種別）
//    GET /api/regulations/meta
app.get('/api/regulations/meta', requireAuth, requireRegulationsAccess, async (req, res) => {
  try {
    // distinct の category_labels は GIN 配列なので JS 側で集約する
    const { data: laws, error } = await supabase
      .from('regulations_law')
      .select('category_labels')
      .eq('is_current', true);
    if (error) throw error;

    // ユニークなカテゴリラベルを集約
    const labelSet = new Set();
    for (const row of laws || []) {
      for (const lbl of (row.category_labels || [])) {
        if (lbl) labelSet.add(lbl);
      }
    }
    const domains = [...labelSet].sort();

    const typeLabels = {
      Constitution: '憲法',
      Act: '法律',
      CabinetOrder: '政令',
      ImperialOrder: '勅令',
      MinisterialOrdinance: '省令',
      Rule: '規則',
    };

    res.json({
      domains,
      categories: REGULATIONS_CATEGORY_MAP,
      typeLabels,
      attribution: '出典：e-Gov法令検索（https://laws.e-gov.go.jp/）',
    });
  } catch (error) {
    console.error('Error (regulations meta):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 法令集 - 法令一覧
//    GET /api/regulations/laws?q=&category=&type=&core=&parentOnly=
//    返却: id, law_id, law_num, title, law_type, law_type_label, category_cd,
//           category_labels, relation_type, parent_law_id, is_core, is_current,
//           enforcement_date, article_count
app.get('/api/regulations/laws', requireAuth, requireRegulationsAccess, async (req, res) => {
  try {
    const { q, category, type: lawType, core, parentOnly } = req.query;

    let query = supabase
      .from('regulations_law')
      .select('id, law_id, law_num, title, law_type, law_type_label, category_cd, category_labels, relation_type, parent_law_id, is_core, is_current, enforcement_date, article_count')
      .eq('is_current', true);

    // 法令種別フィルタ
    if (lawType) query = query.eq('law_type', lawType);
    // コア法令のみ
    if (core === 'true' || core === '1') query = query.eq('is_core', true);
    // 本法のみ（施行令・施行規則を除く）
    if (parentOnly === 'true' || parentOnly === '1') query = query.eq('relation_type', 'self');
    // 法令名の部分一致（pg_trgm GIN 索引が効く）
    if (q) query = query.ilike('title', `%${q}%`);
    // 分類コードフィルタ（GIN 配列に含むか）
    if (category) query = query.contains('category_cd', [category]);

    query = query.order('title', { ascending: true });

    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error('Error (regulations laws list):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 法令集 - 法令詳細（子法令・目次・改正履歴を含む）
//    GET /api/regulations/laws/:id
app.get('/api/regulations/laws/:id', requireAuth, requireRegulationsAccess, async (req, res) => {
  try {
    const { id } = req.params;

    // 法令本体
    const { data: law, error: lErr } = await supabase
      .from('regulations_law')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (lErr) throw lErr;
    if (!law) return res.status(404).json({ error: '法令が見つかりません' });

    // 子法令（施行令・施行規則など）
    const { data: children, error: cErr } = await supabase
      .from('regulations_law')
      .select('id, law_id, title, law_type, law_type_label, relation_type, article_count, is_current')
      .eq('parent_law_id', id)
      .eq('is_current', true)
      .order('relation_type', { ascending: true });
    if (cErr) throw cErr;

    // 目次（条文の階層情報を使って構築）
    const { data: articles, error: aErr } = await supabase
      .from('regulations_article')
      .select('id, article_num, article_caption, part_num, part_title, chapter_num, chapter_title, section_num, section_title, division, sort_order')
      .eq('law_id', id)
      .order('sort_order', { ascending: true });
    if (aErr) throw aErr;
    const toc = buildTocTree(articles || []);

    // 改正履歴
    const { data: revisions, error: rErr } = await supabase
      .from('regulations_revision')
      .select('*')
      .eq('law_id', id)
      .order('enforcement_date', { ascending: false });
    if (rErr) throw rErr;

    res.json({ ...law, children: children || [], toc, revisions: revisions || [] });
  } catch (error) {
    console.error('Error (regulations law detail):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 法令集 - 条文一覧（sort_order 昇順、全カラム）
//    GET /api/regulations/laws/:id/articles
app.get('/api/regulations/laws/:id/articles', requireAuth, requireRegulationsAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('regulations_article')
      .select('*')
      .eq('law_id', id)
      .order('sort_order', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error('Error (regulations articles list):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 法令集 - 単一条文詳細（参照リンクを含む）
//    GET /api/regulations/articles/:id
app.get('/api/regulations/articles/:id', requireAuth, requireRegulationsAccess, async (req, res) => {
  try {
    const { id } = req.params;

    // 条文本体
    const { data: article, error: aErr } = await supabase
      .from('regulations_article')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (aErr) throw aErr;
    if (!article) return res.status(404).json({ error: '条文が見つかりません' });

    // この条文を参照元とする参照リンク（from_article_id = :id）
    const { data: refs, error: rErr } = await supabase
      .from('regulations_reference')
      .select('id, to_law_id, to_law_title, to_article_num, ref_text, ref_type')
      .eq('from_article_id', id);
    if (rErr) throw rErr;

    res.json({ ...article, references: refs || [] });
  } catch (error) {
    console.error('Error (regulations article detail):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 法令集 - 条文横断全文検索（pg_trgm GIN 索引が効く .ilike）
//    GET /api/regulations/search?q=&lawId=&limit=
//    返却: article_id, law_id, law_title, article_num, article_caption, snippet, division
app.get('/api/regulations/search', requireAuth, requireRegulationsAccess, async (req, res) => {
  try {
    const { q, lawId, limit: limitRaw } = req.query;
    if (!q || !String(q).trim()) return res.status(400).json({ error: 'クエリ q は必須です' });

    const limit = Math.min(Number(limitRaw) || 50, 200);
    const needle = String(q).trim();

    // content または article_caption に部分一致する条文を取得
    let query = supabase
      .from('regulations_article')
      .select('id, law_id, article_num, article_caption, content, division')
      .or(`content.ilike.%${needle}%,article_caption.ilike.%${needle}%`)
      .limit(limit);
    if (lawId) query = query.eq('law_id', lawId);

    const { data: articles, error: aErr } = await query;
    if (aErr) throw aErr;

    if (!articles || articles.length === 0) return res.json([]);

    // 法令タイトルを一括取得（一意の law_id セット）
    const lawIds = [...new Set(articles.map((a) => a.law_id))];
    const { data: laws, error: lErr } = await supabase
      .from('regulations_law')
      .select('id, title')
      .in('id', lawIds);
    if (lErr) throw lErr;
    const lawTitleMap = {};
    for (const l of laws || []) lawTitleMap[l.id] = l.title;

    // JS 側で snippet を生成（マッチ周辺 ±60 文字）
    const result = articles.map((a) => ({
      article_id: a.id,
      law_id: a.law_id,
      law_title: lawTitleMap[a.law_id] || null,
      article_num: a.article_num,
      article_caption: a.article_caption || null,
      snippet: extractSnippet(a.content, needle, 60),
      division: a.division,
    }));

    res.json(result);
  } catch (error) {
    console.error('Error (regulations search):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 法令集 - 改正履歴一覧（enforcement_date 降順）
//    GET /api/regulations/laws/:id/revisions
app.get('/api/regulations/laws/:id/revisions', requireAuth, requireRegulationsAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('regulations_revision')
      .select('*')
      .eq('law_id', id)
      .order('enforcement_date', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error('Error (regulations revisions):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 法令集 - ブックマーク（自分のもののみ操作可）
// ============================================================

// ✅ 法令集 - ブックマーク一覧（law title / article caption を join して返す）
//    GET /api/regulations/bookmarks
app.get('/api/regulations/bookmarks', requireAuth, requireRegulationsAccess, async (req, res) => {
  try {
    const email = String(req.user.email || '').toLowerCase();

    const { data, error } = await supabase
      .from('regulations_bookmark')
      .select('id, law_id, article_id, memo, color, created_at, updated_at')
      .eq('user_email', email)
      .order('created_at', { ascending: false });
    if (error) throw error;

    const bms = data || [];
    if (bms.length === 0) return res.json([]);

    // 法令タイトルを一括 join
    const lawIds = [...new Set(bms.map((b) => b.law_id))];
    const { data: laws } = await supabase
      .from('regulations_law')
      .select('id, title')
      .in('id', lawIds);
    const lawMap = {};
    for (const l of laws || []) lawMap[l.id] = l.title;

    // 条文見出しを一括 join（article_id が null のブックマークは法令単位）
    const artIds = bms.map((b) => b.article_id).filter(Boolean);
    const artMap = {};
    if (artIds.length > 0) {
      const { data: arts } = await supabase
        .from('regulations_article')
        .select('id, article_num, article_caption')
        .in('id', artIds);
      for (const a of arts || []) artMap[a.id] = { num: a.article_num, caption: a.article_caption };
    }

    const result = bms.map((b) => ({
      ...b,
      law_title: lawMap[b.law_id] || null,
      article_num: b.article_id ? (artMap[b.article_id]?.num || null) : null,
      article_caption: b.article_id ? (artMap[b.article_id]?.caption || null) : null,
    }));
    res.json(result);
  } catch (error) {
    console.error('Error (regulations bookmarks list):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 法令集 - ブックマーク作成・更新（upsert）
//    POST /api/regulations/bookmarks  { law_id, article_id?, memo?, color? }
//    UNIQUE(user_email, law_id, article_id) で upsert。
app.post('/api/regulations/bookmarks', requireAuth, requireRegulationsAccess, async (req, res) => {
  try {
    const email = String(req.user.email || '').toLowerCase();
    const b = req.body || {};

    if (!b.law_id) return res.status(400).json({ error: 'law_id は必須です' });

    // staff_id を email から解決（未登録なら null）
    const regRole = req.regRole; // requireRegulationsAccess で設定済み
    const staffId = regRole?.staffId || null;

    const lawId = Number(b.law_id);
    const articleId = b.article_id != null ? Number(b.article_id) : null;
    const row = {
      user_email: email,
      law_id: lawId,
      article_id: articleId,
      memo: b.memo || null,
      color: b.color || null,
      staff_id: staffId,
      updated_at: new Date().toISOString(),
    };

    // PostgreSQL の UNIQUE は NULL を重複とみなさないため（法令単位=article_id NULL）、
    // onConflict ではなく明示的に存在確認 → 更新／挿入する。
    let existsQuery = supabase
      .from('regulations_bookmark')
      .select('id')
      .eq('user_email', email)
      .eq('law_id', lawId);
    existsQuery = articleId != null
      ? existsQuery.eq('article_id', articleId)
      : existsQuery.is('article_id', null);
    const { data: existing, error: findErr } = await existsQuery.maybeSingle();
    if (findErr) throw findErr;

    let data, error;
    if (existing) {
      ({ data, error } = await supabase
        .from('regulations_bookmark')
        .update({ memo: row.memo, color: row.color, updated_at: row.updated_at })
        .eq('id', existing.id)
        .select('*')
        .single());
    } else {
      ({ data, error } = await supabase
        .from('regulations_bookmark')
        .insert(row)
        .select('*')
        .single());
    }
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Error (regulations bookmark upsert):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 法令集 - ブックマーク更新（memo / color のみ）
//    PUT /api/regulations/bookmarks/:id  { memo?, color? }
app.put('/api/regulations/bookmarks/:id', requireAuth, requireRegulationsAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const email = String(req.user.email || '').toLowerCase();
    const b = req.body || {};

    // 自分のブックマークか確認
    const { data: existing, error: exErr } = await supabase
      .from('regulations_bookmark')
      .select('id')
      .eq('id', id)
      .eq('user_email', email)
      .maybeSingle();
    if (exErr) throw exErr;
    if (!existing) return res.status(404).json({ error: 'ブックマークが見つかりません' });

    const payload = { updated_at: new Date().toISOString() };
    if ('memo' in b) payload.memo = b.memo || null;
    if ('color' in b) payload.color = b.color || null;

    const { data, error } = await supabase
      .from('regulations_bookmark')
      .update(payload)
      .eq('id', id)
      .eq('user_email', email)
      .select('*')
      .single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Error (regulations bookmark update):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 法令集 - ブックマーク削除（自分のもののみ）
//    DELETE /api/regulations/bookmarks/:id
app.delete('/api/regulations/bookmarks/:id', requireAuth, requireRegulationsAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const email = String(req.user.email || '').toLowerCase();

    const { data, error } = await supabase
      .from('regulations_bookmark')
      .delete()
      .eq('id', id)
      .eq('user_email', email)
      .select('id');
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: 'ブックマークが見つかりません' });
    res.json({ ok: true });
  } catch (error) {
    console.error('Error (regulations bookmark delete):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 法令集 - 同期スタブ（admin のみ。実際の同期は cron で実行）
//    POST /api/regulations/sync
//    本番では regulations/sync.js --core を cron（Render の Cron Job 等）で定期実行する。
//    このエンドポイントは「同期は cron で行われる」旨を返すスタブ。
//    オプションで spawn による即時起動を試みるが、失敗しても 500 にしない。
app.post('/api/regulations/sync', requireAuth, requireRegulationsAdmin, async (req, res) => {
  try {
    // spawn での即時起動を試みる（detach して API は即座に返す）
    let spawned = false;
    try {
      const { spawn } = await import('child_process');
      const child = spawn('node', ['regulations/sync.js', '--core'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      spawned = true;
    } catch (spawnErr) {
      console.warn('regulations sync spawn 失敗（無視）:', spawnErr.message);
    }
    res.json({
      ok: true,
      message: spawned
        ? '同期プロセスをバックグラウンドで起動しました（regulations/sync.js --core）'
        : '同期は Render の Cron Job（regulations/sync.js --core）で定期実行されます',
      note: 'e-Gov法令APIからのデータ取得は時間がかかるため、このエンドポイントでは即時完了を保証しません',
    });
  } catch (error) {
    console.error('Error (regulations sync):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 名刺管理 API（all: requireAuth + requireCardAccess）
// ============================================================

// ── 権限ミドルウェア（入札と同型。app_key='cards'）──────────────
async function resolveCardRole(email) {
  const perms = await resolvePermissions(email); // { role, staffId }
  if (perms.role === 'admin') return { role: 'admin', access: true, staffId: perms.staffId, globalAdmin: true };
  let level = null;
  if (perms.staffId) {
    const { data } = await supabase
      .from('staff_app_permissions')
      .select('access_level')
      .eq('staff_id', perms.staffId)
      .eq('app_key', 'cards')
      .maybeSingle();
    level = data?.access_level || null;
  }
  const role = level === 'admin' ? 'admin' : level ? 'member' : 'none';
  return { role, access: role !== 'none', staffId: perms.staffId, globalAdmin: false };
}

// 名刺管理のアクセス権（行があれば許可）
async function requireCardAccess(req, res, next) {
  try {
    const r = await resolveCardRole(req.user.email);
    if (!r.access) return res.status(403).json({ error: '名刺管理へのアクセス権がありません' });
    req.cardRole = r;
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// 名刺管理の管理者のみ許可（他人の名刺の編集・削除）。要 requireAuth 後段。
async function requireCardAdmin(req, res, next) {
  try {
    const r = await resolveCardRole(req.user.email);
    if (r.role !== 'admin') return res.status(403).json({ error: 'この操作は名刺管理の管理者のみ可能です' });
    req.cardRole = r;
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ── Gemini 名刺 OCR 関数（extractCertificate と同型）────────────
// 名刺画像を Gemini で解析し、各フィールドを構造化して返す。
async function extractBusinessCard(buffer, mimeType) {
  if (!GEMINI_API_KEY) {
    const e = new Error('GEMINI_API_KEY が未設定です。Render の環境変数に設定してください。');
    e.status = 503;
    throw e;
  }
  const prompt = [
    'これは日本のビジネス名刺の画像です。',
    '記載内容を読み取り、次の項目をJSONで返してください。',
    '- full_name: 氏名（姓名の間の空白は除いて返す。読めなければ空文字）',
    '- company: 会社名（読めなければ空文字）',
    '- department: 部署名（読めなければ空文字）',
    '- title: 役職名（読めなければ空文字）',
    '- phone: 電話番号（直通・代表。複数ある場合は最初の1つ。読めなければ空文字）',
    '- mobile: 携帯電話番号（読めなければ空文字）',
    '- email: メールアドレス（読めなければ空文字）',
    '- fax: FAX番号（読めなければ空文字）',
    '- postal_code: 郵便番号（ハイフン付きで返す。例: 123-4567。読めなければ空文字）',
    '- address: 住所（郵便番号は含めない。読めなければ空文字）',
    '- website: ウェブサイトURL（読めなければ空文字）',
    '- qualifications: 資格・肩書き（名刺に記載があれば。複数はカンマ区切り。なければ空文字）',
    '- note: その他の特記事項（なければ空文字）',
    '読み取れない項目は空文字にしてください。推測で埋めないでください。',
  ].join('\n');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: mimeType || 'image/jpeg', data: buffer.toString('base64') } },
      ],
    }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          full_name:      { type: 'STRING' },
          company:        { type: 'STRING' },
          department:     { type: 'STRING' },
          title:          { type: 'STRING' },
          phone:          { type: 'STRING' },
          mobile:         { type: 'STRING' },
          email:          { type: 'STRING' },
          fax:            { type: 'STRING' },
          postal_code:    { type: 'STRING' },
          address:        { type: 'STRING' },
          website:        { type: 'STRING' },
          qualifications: { type: 'STRING' },
          note:           { type: 'STRING' },
        },
        required: ['full_name', 'company'],
      },
    },
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text();
    const e = new Error(`Gemini API エラー (${resp.status}): ${t.slice(0, 300)}`);
    e.status = 502;
    throw e;
  }
  const json = await resp.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini から有効な応答が得られませんでした');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('Gemini 応答の解析に失敗しました'); }

  return {
    full_name:      (parsed.full_name      || '').trim(),
    company:        (parsed.company        || '').trim(),
    department:     (parsed.department     || '').trim(),
    title:          (parsed.title          || '').trim(),
    phone:          (parsed.phone          || '').trim(),
    mobile:         (parsed.mobile         || '').trim(),
    email:          (parsed.email          || '').trim(),
    fax:            (parsed.fax            || '').trim(),
    postal_code:    (parsed.postal_code    || '').trim(),
    address:        (parsed.address        || '').trim(),
    website:        (parsed.website        || '').trim(),
    qualifications: (parsed.qualifications || '').trim(),
    note:           (parsed.note           || '').trim(),
  };
}

// ── 名刺の向き自動補正（Gemini で正立判定 → sharp で回転）──────────
// 既存の一括補正と同じ思想: モデルは「正立(0°)」の判定は高信頼だが
// 90/270 の方向判定は不安定。そこで まず1回判定し、傾いていれば
// 0/90/180/270 を総当たりして「正立」と判定される向きを選ぶ。
// 判定不能（縦書きで透過映り込み等）の場合は無回転で返す（無害なフォールバック）。
async function judgeCardRotation(jpegBuffer) {
  const prompt = [
    'この画像は名刺の写真です。',
    '名刺には横書き名刺と縦書き名刺があり、どちらも「文字がきちんと読める状態」が正立です。',
    'ローマ字（社名ロゴ/氏名/住所のアルファベット）や数字が横倒し・上下逆なら、その分だけ回転が必要です。',
    '正立させるために時計回りに何度回転が必要かを 0/90/180/270 で答えてください。',
    '・そのまま読める→0 ／・頭を左に傾けると読める→90 ／・上下逆→180 ／・頭を右に傾けると読める→270',
    '出力はJSONのみ: {"rotate_cw":0,"confidence":0.95}',
  ].join('\n');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: 'image/jpeg', data: jpegBuffer.toString('base64') } }] }],
    generationConfig: {
      temperature: 0, responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', properties: { rotate_cw: { type: 'INTEGER' }, confidence: { type: 'NUMBER' } }, required: ['rotate_cw'] },
    },
  };
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error(`Gemini ${resp.status}`);
  const json = await resp.json();
  const p = JSON.parse(json?.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
  const valid = [0, 90, 180, 270];
  return { rotate_cw: valid.includes(Number(p.rotate_cw)) ? Number(p.rotate_cw) : 0, confidence: Number(p.confidence) || 0 };
}

// 入力画像を正立させて返す。{ buffer, mimeType }。補正不要/失敗時は EXIF 正規化のみ。
async function orientCardUpright(buffer, mimeType) {
  if (!GEMINI_API_KEY) return { buffer, mimeType: mimeType || 'image/jpeg' };
  try {
    // EXIF の向きを画素へ焼き込んだベース画像（以後の回転基準）
    const base = await sharp(buffer).rotate().toBuffer();
    const toSmall = (b, a) => sharp(b).rotate(a).resize({ width: 1100, height: 1100, fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();

    // まず現状を判定。正立(0°)なら即終了（最頻ケース＝Gemini呼び出し1回）
    const j0 = await judgeCardRotation(await sharp(base).resize({ width: 1100, height: 1100, fit: 'inside' }).jpeg({ quality: 85 }).toBuffer());
    if (j0.rotate_cw === 0) return { buffer: base, mimeType: 'image/jpeg' };

    // 傾いている → 90/180/270 を総当たりし「正立」と判定される向きを採用
    const cands = [90, 180, 270];
    const smalls = await Promise.all(cands.map((a) => toSmall(base, a)));
    const judged = await Promise.all(smalls.map((s) => judgeCardRotation(s).catch(() => ({ rotate_cw: -1, confidence: 0 }))));
    let best = null;
    cands.forEach((a, i) => { if (judged[i].rotate_cw === 0 && (!best || judged[i].confidence > best.conf)) best = { a, conf: judged[i].confidence }; });
    if (!best) return { buffer: base, mimeType: 'image/jpeg' }; // 正立向きを特定できず→無回転

    const rotated = await sharp(base).rotate(best.a).jpeg({ quality: 92 }).toBuffer();
    return { buffer: rotated, mimeType: 'image/jpeg', rotated: best.a };
  } catch (e) {
    console.error('orientCardUpright 失敗（無補正で続行）:', e.message);
    return { buffer, mimeType: mimeType || 'image/jpeg' };
  }
}

// ── Drive / Storage 保存ヘルパー（storeBidFile と同型）──────────
//   Drive: （DRIVE_FOLDER_ID）/名刺/<カテゴリ or '未分類'>/
//   未設定時は Supabase Storage バケット 'card-images' へフォールバック。
const CARD_BUCKET = 'card-images';

async function storeCardFile({ category, fileName, buffer, mimeType }) {
  if (driveConfigured()) {
    const categorySeg = sanitizeDriveSeg(category || '未分類');
    const folderId = await ensureFolderPath(['06.名刺', categorySeg], SHARED_DRIVE_ROOT_ID);
    const fileId = await driveUpload({ name: fileName, buffer, mimeType, folderId });
    return `drive:${fileId}`;
  }
  const path = `${Date.now()}-${uuidv4()}-${sanitizeDriveSeg(fileName)}`;
  const { error } = await supabase.storage.from(CARD_BUCKET).upload(path, buffer, { contentType: mimeType });
  if (error) throw error;
  return path;
}

// 名刺画像の一時表示URL（既定1時間）。
//   'drive:' 参照 → 短命JWT付き API プロキシURL（/api/card-file）。
//   それ以外      → Supabase 署名付きURL。
async function cardSignedUrl(ref, { expiresIn = 3600, size } = {}) {
  if (!ref) return null;
  if (String(ref).startsWith('drive:')) {
    const fileId = String(ref).slice('drive:'.length);
    // size を指定すると軽量サムネイルを返す（一覧・詳細とも小サイズ表示のため既定で使用）
    const token = jwt.sign({ fileId, kind: 'card', ...(size ? { size } : {}) }, JWT_SECRET, { expiresIn });
    const base = process.env.PUBLIC_API_URL || 'https://portal-api-hhlx.onrender.com';
    return `${base}/api/card-file?t=${encodeURIComponent(token)}`;
  }
  const { data } = await supabase.storage.from(CARD_BUCKET).createSignedUrl(ref, expiresIn);
  return data?.signedUrl || null;
}

// ── 名刺画像プロキシ（短命JWT認証）────────────────────────────
// 認証は requireAuth ではなく cardSignedUrl が発行する短命JWT（?t=）で行う（署名付きURL相当）。
app.get('/api/card-file', async (req, res) => {
  try {
    const token = req.query.t;
    if (!token) return res.status(400).send('missing token');
    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).send('invalid or expired token');
    }
    if (payload.kind !== 'card' || !payload.fileId) return res.status(400).send('bad token');
    const { buffer, contentType } = payload.size
      ? await driveThumbnail(payload.fileId, payload.size)
      : await driveDownload(payload.fileId);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(buffer);
  } catch (error) {
    console.error('Error (card-file proxy):', error.message);
    res.status(error.status || 500).send(error.message);
  }
});

// ✅ 名刺 - カテゴリ一覧取得（自分が使ったカテゴリ候補を返す）
//    GET /api/cards/categories
//    レスポンス: { categories: ["官公庁", "協力会社", ...] }（name 昇順）
app.get('/api/cards/categories', requireAuth, requireCardAccess, async (req, res) => {
  try {
    const email = String(req.user.email || '').toLowerCase();
    const { data, error } = await supabase
      .from('card_categories')
      .select('name')
      .eq('user_email', email)
      .order('name', { ascending: true });
    if (error) throw error;
    res.json({ categories: (data || []).map((r) => r.name) });
  } catch (error) {
    console.error('Error (cards categories):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 名刺 - マイカテゴリ候補一覧（自分が使った個人ラベルの distinct）
//    GET /api/cards/my-categories
//    レスポンス: { categories: ["重要", "要フォロー", ...] }（name 昇順）
//    ※ /api/cards/:id より前に定義すること（:id にマッチさせないため）
app.get('/api/cards/my-categories', requireAuth, requireCardAccess, async (req, res) => {
  try {
    const email = String(req.user.email || '').toLowerCase();
    const { data, error } = await supabase
      .from('card_personal_labels')
      .select('label')
      .eq('user_email', email);
    if (error) throw error;
    const names = [...new Set((data || []).map((r) => r.label).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'ja'));
    res.json({ categories: names });
  } catch (error) {
    console.error('Error (cards my-categories):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 名刺の全社カテゴリ（17分類）。カテゴリ提案の検証に使う。
const CARD_CATEGORIES = [
  '建設・土木', '設計・コンサル・測量', '専門工事・下請', '建設資材・商社',
  '機械・重機・レンタル', '電気・通信・設備', 'IT・システム', '官公庁・行政',
  '金融・保険', '運輸・物流', '教育・学校', '不動産',
  '士業（税理士・法務等）', '飲食・宿泊・サービス', '医療・福祉', '水産・漁業', 'その他',
];

// ✅ 名刺 - 会社名からカテゴリを提案
//    POST /api/cards/suggest-category   body: { company }
//    レスポンス: { category, source: 'existing'|'researched'|'none', industry? }
//    ・既存リストに同じ会社があれば、その最頻カテゴリを継承（リサーチしない）
//    ・新規会社なら Gemini + Google検索グラウンディングで業種を調べて17カテゴリ判定
//    ※ 提案は補助機能。失敗しても登録を妨げないよう常に 200 で返す。
//    ※ /api/cards/:id より前に定義すること（:id にマッチさせないため）。
app.post('/api/cards/suggest-category', requireAuth, requireCardAccess, async (req, res) => {
  const norm = (s) => String(s || '').trim().replace(/[\s　]+/g, ' ');
  try {
    const company = norm(req.body?.company);
    if (!company) return res.json({ category: null, source: 'none' });

    // 【1】既存会社チェック: 正規化一致するカードがあれば、その最頻カテゴリを継承
    const { data: rows, error: qErr } = await supabase
      .from('business_cards')
      .select('company, category')
      .eq('is_active', true);
    if (qErr) throw qErr;

    const matched = (rows || []).filter((r) => norm(r.company) === company);
    if (matched.length > 0) {
      const counts = new Map();
      for (const r of matched) {
        const c = (r.category || '').trim();
        if (c) counts.set(c, (counts.get(c) || 0) + 1);
      }
      if (counts.size > 0) {
        const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        return res.json({ category: top, source: 'existing' });
      }
      // 一致はするが全てカテゴリ空 → 新規扱いでリサーチへ
    }

    // 【2】新規会社 → Gemini + Google検索グラウンディングで業種を調べてカテゴリ判定
    if (!GEMINI_API_KEY) return res.json({ category: null, source: 'none' });

    const prompt = `日本の企業/組織「${company}」について、Google検索で実際の業種・事業内容を調べ、次の17カテゴリから最も適切なものを1つだけ選んでください。どれにも明確に当てはまらなければ「その他」を選んでください。

17カテゴリ: ${CARD_CATEGORIES.join('、')}

出力はJSONのみ（前後に説明文やマークダウンを付けない）: {"category":"<17カテゴリのいずれか>","industry":"<業種の一言>"}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const body = { contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }] };

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error('Error (suggest-category Gemini):', resp.status, errText.slice(0, 300));
      return res.json({ category: null, source: 'none' });
    }

    const json = await resp.json();
    const text = json?.candidates?.[0]?.content?.parts?.map((p) => p?.text || '').join('') || '';

    // ```json フェンスや前後テキストを除去して最初の { ... } を取り出す
    let parsed = null;
    try {
      const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start >= 0 && end > start) parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch (e) {
      parsed = null;
    }

    if (!parsed || !parsed.category) return res.json({ category: null, source: 'none' });

    const category = CARD_CATEGORIES.includes(parsed.category) ? parsed.category : 'その他';
    return res.json({ category, source: 'researched', industry: (parsed.industry || '').trim() || undefined });
  } catch (error) {
    console.error('Error (cards suggest-category):', error.message);
    return res.json({ category: null, source: 'none' });
  }
});

// ✅ 名刺 - 画像スキャン（OCR のみ。DB 保存しない）
//    POST /api/cards/scan
//    multipart/form-data: file（名刺画像）
app.post('/api/cards/scan', requireAuth, requireCardAccess, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file（名刺画像）が必要です' });
    if (req.file.size > 18 * 1024 * 1024) return res.status(400).json({ error: 'ファイルサイズが18MBを超えています' });
    // 向きを自動補正してから OCR（横倒し名刺の読み取り精度を確保）
    const oriented = await orientCardUpright(req.file.buffer, req.file.mimetype);
    const extracted = await extractBusinessCard(oriented.buffer, oriented.mimeType);
    res.json({ extracted });
  } catch (error) {
    console.error('Error (cards scan):', error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ✅ 名刺 - 一覧取得（?q=&scope= で絞り込み）
//    scope: 'mine'（自分のみ）| 'shared'（共有のみ）| 未指定/'all'（両方）
//    q: full_name / company / department / qualifications を ilike 部分一致
app.get('/api/cards', requireAuth, requireCardAccess, async (req, res) => {
  try {
    const { q, scope } = req.query;
    const email = String(req.user.email || '').toLowerCase();

    let query = supabase.from('business_cards').select('*').eq('is_active', true);

    if (scope === 'mine') {
      query = query.eq('owner_email', email);
    } else if (scope === 'shared') {
      query = query.eq('visibility', 'shared');
    } else {
      // 自分の名刺 または 共有名刺
      query = query.or(`owner_email.eq.${email},visibility.eq.shared`);
    }

    if (q) {
      const like = `%${q}%`;
      query = query.or(`full_name.ilike.${like},company.ilike.${like},department.ilike.${like},qualifications.ilike.${like}`);
    }

    query = query.order('created_at', { ascending: false });

    const { data, error } = await query;
    if (error) throw error;

    // 自分のマイカテゴリ（個人ラベル）をまとめて取得し card_id => label のマップに
    const myLabels = {};
    {
      const { data: labelRows } = await supabase
        .from('card_personal_labels')
        .select('card_id, label')
        .eq('user_email', email);
      for (const r of (labelRows || [])) myLabels[r.card_id] = r.label;
    }

    const rows = await Promise.all((data || []).map(async (r) => ({
      ...r,
      image_url: r.image_ref ? await cardSignedUrl(r.image_ref, { size: 600 }) : null,
      my_category: myLabels[r.id] || null,   // 本人だけに返す個人ラベル
    })));
    res.json(rows);
  } catch (error) {
    console.error('Error (cards list):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 名刺 - 1件取得（閲覧権限: 共有 or 自分の or admin）
app.get('/api/cards/:id', requireAuth, requireCardAccess, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('business_cards')
      .select('*')
      .eq('id', req.params.id)
      .eq('is_active', true)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: '名刺が見つかりません' });

    const email = String(req.user.email || '').toLowerCase();
    const isOwner = data.owner_email === email;
    const isShared = data.visibility === 'shared';
    const isAdmin = req.cardRole.role === 'admin';
    if (!isOwner && !isShared && !isAdmin) {
      return res.status(403).json({ error: 'この名刺を閲覧する権限がありません' });
    }

    // 自分のマイカテゴリ（個人ラベル）を付与（本人のみ）
    const { data: myLabel } = await supabase
      .from('card_personal_labels')
      .select('label')
      .eq('user_email', email)
      .eq('card_id', data.id)
      .maybeSingle();

    res.json({
      ...data,
      image_url: data.image_ref ? await cardSignedUrl(data.image_ref, { size: 600 }) : null,
      my_category: myLabel?.label || null,
    });
  } catch (error) {
    console.error('Error (cards get):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 名刺 - マイカテゴリ（個人ラベル）の設定・解除
//    PUT /api/cards/:id/my-category   body: { category: string }
//    閲覧できる名刺なら誰でも自分用ラベルを付けられる（所有者でなくてもよい）。
//    category が空文字なら解除。
app.put('/api/cards/:id/my-category', requireAuth, requireCardAccess, async (req, res) => {
  try {
    const email = String(req.user.email || '').toLowerCase();
    const cardId = req.params.id;

    // 閲覧権限チェック（共有 or 自分の or admin のみラベル付与可）
    const { data: card, error: cardErr } = await supabase
      .from('business_cards')
      .select('id, owner_email, visibility')
      .eq('id', cardId)
      .eq('is_active', true)
      .maybeSingle();
    if (cardErr) throw cardErr;
    if (!card) return res.status(404).json({ error: '名刺が見つかりません' });

    const isOwner = card.owner_email === email;
    const isShared = card.visibility === 'shared';
    const isAdmin = req.cardRole.role === 'admin';
    if (!isOwner && !isShared && !isAdmin) {
      return res.status(403).json({ error: 'この名刺にラベルを付ける権限がありません' });
    }

    const label = (req.body?.category || '').trim();

    if (!label) {
      // 解除
      const { error } = await supabase
        .from('card_personal_labels')
        .delete()
        .eq('user_email', email)
        .eq('card_id', cardId);
      if (error) throw error;
      return res.json({ my_category: null });
    }

    // 設定（upsert）
    const { error } = await supabase
      .from('card_personal_labels')
      .upsert(
        { user_email: email, card_id: cardId, label, updated_at: new Date().toISOString() },
        { onConflict: 'user_email,card_id' },
      );
    if (error) throw error;
    res.json({ my_category: label });
  } catch (error) {
    console.error('Error (cards set my-category):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 名刺 - 新規登録（画像アップロード対応）
app.post('/api/cards', requireAuth, requireCardAccess, upload.single('file'), async (req, res) => {
  try {
    const {
      full_name, company, department, title,
      phone, mobile, email: cardEmail, fax,
      postal_code, address, website, qualifications, note,
      visibility, category,
    } = req.body || {};

    const ownerEmail = String(req.user.email || '').toLowerCase();
    // デフォルトは 'shared'（未指定 or 不正値は shared 扱い。既存データは変更しない）
    const vis = visibility === 'private' ? 'private' : 'shared';
    const cat = (category || '').trim() || null;

    let image_ref = null;
    if (req.file) {
      if (req.file.size > 18 * 1024 * 1024) return res.status(400).json({ error: 'ファイルサイズが18MBを超えています' });
      // 保存前に向きを自動補正（正立画素で保存。回転時は JPEG に正規化）
      const oriented = await orientCardUpright(req.file.buffer, req.file.mimetype);
      const ext = oriented.mimeType === 'image/jpeg' ? 'jpg' : (req.file.originalname.split('.').pop() || 'jpg').toLowerCase();
      const fileName = `${Date.now()}-${uuidv4()}.${ext}`;
      image_ref = await storeCardFile({
        category: cat,
        fileName,
        buffer: oriented.buffer,
        mimeType: oriented.mimeType,
      });
    }

    const { data, error } = await supabase
      .from('business_cards')
      .insert([{
        full_name:      (full_name      || null),
        company:        (company        || null),
        department:     (department     || null),
        title:          (title          || null),
        phone:          (phone          || null),
        mobile:         (mobile         || null),
        email:          (cardEmail      || null),
        fax:            (fax            || null),
        postal_code:    (postal_code    || null),
        address:        (address        || null),
        website:        (website        || null),
        qualifications: (qualifications || null),
        note:           (note           || null),
        category:       cat,
        image_ref,
        visibility:     vis,
        owner_email:    ownerEmail,
      }])
      .select('*');
    if (error) throw error;

    // カテゴリが指定されていれば card_categories に upsert（候補として保存）
    if (cat) {
      await supabase
        .from('card_categories')
        .upsert({ user_email: ownerEmail, name: cat }, { onConflict: 'user_email,name' });
    }

    const row = data[0];
    res.json({ ...row, image_url: row.image_ref ? await cardSignedUrl(row.image_ref, { size: 600 }) : null });
  } catch (error) {
    console.error('Error (cards create):', error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ✅ 名刺 - 更新（自分の名刺 or admin のみ）
app.patch('/api/cards/:id', requireAuth, requireCardAccess, upload.single('file'), async (req, res) => {
  try {
    const { data: existing, error: fetchErr } = await supabase
      .from('business_cards')
      .select('*')
      .eq('id', req.params.id)
      .eq('is_active', true)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!existing) return res.status(404).json({ error: '名刺が見つかりません' });

    const email = String(req.user.email || '').toLowerCase();
    if (existing.owner_email !== email && req.cardRole.role !== 'admin') {
      return res.status(403).json({ error: 'この名刺を編集する権限がありません' });
    }

    const UPDATABLE = ['full_name', 'company', 'department', 'title', 'phone', 'mobile',
      'email', 'fax', 'postal_code', 'address', 'website', 'qualifications', 'note', 'visibility', 'category'];
    const patch = {};
    for (const key of UPDATABLE) {
      if (req.body && key in req.body) {
        if (key === 'visibility') {
          patch[key] = req.body[key] === 'private' ? 'private' : 'shared';
        } else if (key === 'category') {
          patch[key] = (req.body[key] || '').trim() || null;
        } else {
          patch[key] = req.body[key] || null;
        }
      }
    }

    if (req.file) {
      if (req.file.size > 18 * 1024 * 1024) return res.status(400).json({ error: 'ファイルサイズが18MBを超えています' });
      // 差し替え画像も保存前に向きを自動補正
      const oriented = await orientCardUpright(req.file.buffer, req.file.mimetype);
      const ext = oriented.mimeType === 'image/jpeg' ? 'jpg' : (req.file.originalname.split('.').pop() || 'jpg').toLowerCase();
      const fileName = `${Date.now()}-${uuidv4()}.${ext}`;
      // category はパッチ済みの値、なければ既存の値を使用
      const effectiveCategory = ('category' in patch ? patch.category : existing.category) || null;
      patch.image_ref = await storeCardFile({
        category: effectiveCategory,
        fileName,
        buffer: oriented.buffer,
        mimeType: oriented.mimeType,
      });
    }

    patch.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('business_cards')
      .update(patch)
      .eq('id', req.params.id)
      .select('*');
    if (error) throw error;

    // カテゴリが更新・指定されていれば card_categories に upsert
    const savedCategory = 'category' in patch ? patch.category : null;
    if (savedCategory) {
      const ownerEmailForCat = String(req.user.email || '').toLowerCase();
      await supabase
        .from('card_categories')
        .upsert({ user_email: ownerEmailForCat, name: savedCategory }, { onConflict: 'user_email,name' });
    }

    const row = data[0];
    res.json({ ...row, image_url: row.image_ref ? await cardSignedUrl(row.image_ref, { size: 600 }) : null });
  } catch (error) {
    console.error('Error (cards update):', error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ✅ 名刺 - 論理削除（自分の名刺 or admin のみ）
app.delete('/api/cards/:id', requireAuth, requireCardAccess, async (req, res) => {
  try {
    const { data: existing, error: fetchErr } = await supabase
      .from('business_cards')
      .select('id, owner_email')
      .eq('id', req.params.id)
      .eq('is_active', true)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!existing) return res.status(404).json({ error: '名刺が見つかりません' });

    const email = String(req.user.email || '').toLowerCase();
    if (existing.owner_email !== email && req.cardRole.role !== 'admin') {
      return res.status(403).json({ error: 'この名刺を削除する権限がありません' });
    }

    const { error } = await supabase
      .from('business_cards')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (error) throw error;

    res.json({ ok: true });
  } catch (error) {
    console.error('Error (cards delete):', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Portal API running on http://localhost:${PORT}`);
});
