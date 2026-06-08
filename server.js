import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { randomUUID as uuidv4 } from 'crypto';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import nodemailer from 'nodemailer';

dotenv.config();

// ✅ multer: 写真アップロード用（メモリストレージ）
const upload = multer({ storage: multer.memoryStorage() });

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
    res.json({
      role: perms.role,        // 'admin' | 'member'
      staff_id: perms.staffId, // 本人のスタッフID（未登録なら null）
      email: req.user.email,
      name: req.user.name
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

    const apps = [
      { id: 1, name: '安全パトロール', url: safetyPatrolUrl, icon: '✅' },
      { id: 2, name: '社員管理', url: '#', icon: '👤', status: 'coming_soon' },
      { id: 3, name: 'メーラー', url: '#', icon: '📧', status: 'coming_soon' },
      { id: 4, name: 'ファイル管理', url: '#', icon: '📁', status: 'coming_soon' },
      { id: 5, name: '社員評価', url: '#', icon: '⭐', status: 'coming_soon' },
      { id: 6, name: '宿舎予約', url: '#', icon: '🛏️', status: 'coming_soon' }
    ];
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

// ✅ マスター管理は閲覧(GET)は全員可、登録/編集/削除は管理者のみ
app.use('/api/masters', async (req, res, next) => {
  if (req.method === 'GET') return next();
  return requireAdmin(req, res, next);
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

// ✅ 安全パトロール - 点検削除（管理者のみ）
app.delete('/api/inspections/:id', requireAdmin, async (req, res) => {
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
app.get('/api/masters/staff', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('staff_master')
      .select('*')
      .order('id', { ascending: true });
    if (error) throw error;
    res.json(data || []);
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

app.listen(PORT, () => {
  console.log(`✅ Portal API running on http://localhost:${PORT}`);
});
