import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { randomUUID as uuidv4 } from 'crypto';
import jwt from 'jsonwebtoken';
import multer from 'multer';

dotenv.config();

// ✅ multer: 写真アップロード用（メモリストレージ）
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
const PORT = process.env.PORT || 3000;

// 認証設定
const JWT_SECRET = process.env.JWT_SECRET;
const ALLOWED_EMAIL_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN || 'nakahara131.co.jp';
const JWT_EXPIRES_IN = '12h';

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

// ✅ 以降の共有データAPIは全て認証必須（安全パトロールもBearerトークンを送る）
app.use('/api/inspections', requireAuth);
app.use('/api/masters', requireAuth);

// ✅ 安全パトロール - 点検一覧
app.get('/api/inspections', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('inspections')
      .select('*')
      .order('inspection_date', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error('Error:', error.message);
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

    const { data: inspectionData, error: inspectionError } = await supabase
      .from('inspections')
      .insert([{
        id: newId,
        inspection_id: resolvedInspectionId,
        project_id,
        inspector_id,
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
        due_date: d.due_date || null
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
        due_date: d.due_date || null
      }));

      const { data: detailData, error: detailError } = await supabase
        .from('inspection_details')
        .insert(detailRows)
        .select();

      if (detailError) throw detailError;

      return res.json({ ...inspection, inspection_details: detailData || [] });
    }

    res.json(inspection);
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 安全パトロール - 点検削除
app.delete('/api/inspections/:id', async (req, res) => {
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
      .order('created_at', { ascending: false });
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
    const { data, error } = await supabase
      .from('projects')
      .insert([{ id: id || uuidv4(), name, location, start_date, end_date, manager_id }])
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
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ マスター管理 - スタッフ作成
app.post('/api/masters/staff', async (req, res) => {
  try {
    const { id, name, email, role } = req.body;
    const { data, error } = await supabase
      .from('staff_master')
      .insert([{ id: id || uuidv4(), name, email, role }])
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
    const { name, email, role } = req.body;
    const { data, error } = await supabase
      .from('staff_master')
      .update({ name, email, role })
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
      .order('created_at', { ascending: false });
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
    const { data, error } = await supabase
      .from('inspection_master')
      .insert([{ id: id || uuidv4(), category, description }])
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

app.listen(PORT, () => {
  console.log(`✅ Portal API running on http://localhost:${PORT}`);
});
