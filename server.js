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

dotenv.config();

// ✅ multer: 写真アップロード用（メモリストレージ）
const upload = multer({ storage: multer.memoryStorage() });

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
      { id: 3, key: 'mailer', name: 'メーラー', url: '#', icon: '📧', status: 'coming_soon' },
      { id: 4, key: 'file-manager', name: 'ファイル管理', url: '#', icon: '📁', status: 'coming_soon' },
      { id: 5, key: 'evaluation', name: '社員評価', url: '#', icon: '⭐', status: 'coming_soon' },
      { id: 6, key: 'dormitory', name: '宿舎予約', url: '#', icon: '🛏️', status: 'coming_soon' }
    ];

    // 権限フィルタ: グローバル管理者は全件。それ以外は app_permissions に行があるアプリのみ。
    // coming_soon（プレースホルダ）は誰にでも表示する。
    const perms = await resolvePermissions(req.user.email);
    const appPerms = await resolveAppPermissions(perms.staffId);
    const apps = allApps.filter((a) => {
      if (a.status === 'coming_soon') return true;
      if (perms.role === 'admin') return true;
      return !!appPerms[a.key];
    });
    res.json(apps);
  } catch (error) {
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
const APP_KEYS = ['safety-patrol', 'employee-list', 'announcements', 'mailer', 'file-manager', 'evaluation', 'dormitory'];

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
  if (perms.role === 'admin') return { access: true, staffId: perms.staffId, globalAdmin: true };
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
  return { access: !!level, staffId: perms.staffId, globalAdmin: false };
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

// 非公開バケットの画像を一時表示するための署名付きURL（既定1時間）
async function certSignedUrl(path, expiresIn = 3600) {
  if (!path) return null;
  const { data } = await supabase.storage.from(CERT_BUCKET).createSignedUrl(path, expiresIn);
  return data?.signedUrl || null;
}

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

    // 2) 原本画像を非公開バケットへ保存
    await ensureCertBucket();
    const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase();
    const path = `${req.params.id}/${Date.now()}-${uuidv4()}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from(CERT_BUCKET)
      .upload(path, req.file.buffer, { contentType: req.file.mimetype });
    if (upErr) throw upErr;

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
      supabase.from('staff_master').select('id, name, birth_date'),
    ]);

    // 3) ページ配列を再構成してレコード配列を得る。
    //    社員名簿に該当しない人（台帳未登録）は取り込まない方針のため、ここで除外する。
    const allRecords = reconcileCertPages(pages, staff || [], masters || []);
    const records = allRecords.filter((r) => r.matched_staff_id != null);

    // 4) 証書ページがある（_page_index が設定されている）レコードを Storage に保存
    await ensureCertBucket();
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
        const storagePath = `inbox/${ts}-${uuidv4()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from(CERT_BUCKET)
          .upload(storagePath, uploadBuffer, { contentType: uploadMimeType });
        if (upErr) throw upErr;

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
    '- bid_date: 入札書の提出日・入札日（提出に期間がある場合は締切日）（YYYY-MM-DD）',
    '- opening_date: 開札日（YYYY-MM-DD）',
    '- budget_price: 予定価格（円。半角数字のみ。公表されている場合のみ。非公表・記載なしは空文字）',
    '- summary: 工事概要を1〜2文で（任意）',
    '日付が和暦（令和・平成等）の場合は西暦に変換してください。',
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
          bid_date: { type: 'STRING' },
          opening_date: { type: 'STRING' },
          budget_price: { type: 'STRING' },
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
    bid_date: cleanIsoDate(p.bid_date),
    opening_date: cleanIsoDate(p.opening_date),
    budget_price: digitsOrNull(p.budget_price),
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
  'notice_date', 'question_due', 'bid_date', 'opening_date',
  'budget_price', 'our_estimate', 'awarded_price', 'awarded_company',
  'staff_id', 'note',
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
app.put('/api/bids/:id', requireAuth, requireBidAccess, async (req, res) => {
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

// ✅ 入札 - 論理削除
app.delete('/api/bids/:id', requireAuth, requireBidAccess, async (req, res) => {
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

// ✅ 入札 - 資料アップロード（multer → Supabase Storage）
app.post('/api/bids/:id/documents', requireAuth, requireBidAccess, upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'file フィールドが必要です' });

    const originalName = decodeUploadName(req.file.originalname); // 日本語ファイル名の文字化け補正
    const ext = (originalName.split('.').pop() || 'bin').toLowerCase();
    const path = `${id}/${Date.now()}-${uuidv4()}.${ext}`;

    const { error: upErr } = await supabase.storage
      .from(BID_BUCKET)
      .upload(path, req.file.buffer, { contentType: req.file.mimetype });
    if (upErr) throw upErr;

    const { data, error } = await supabase
      .from('bid_documents')
      .insert([{
        bid_id: id,
        file_name: originalName,
        storage_path: path,
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
    res.status(500).json({ error: error.message });
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
app.delete('/api/bids/:id/documents/:docId', requireAuth, requireBidAccess, async (req, res) => {
  try {
    const { docId } = req.params;
    const { data: doc } = await supabase
      .from('bid_documents')
      .select('storage_path')
      .eq('id', docId)
      .maybeSingle();
    if (doc?.storage_path) {
      await supabase.storage.from(BID_BUCKET).remove([doc.storage_path]);
    }
    const { error } = await supabase.from('bid_documents').delete().eq('id', docId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) {
    console.error('Error (bid doc delete):', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Portal API running on http://localhost:${PORT}`);
});
