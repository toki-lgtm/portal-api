import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

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

// ✅ ユーザー情報取得
app.get('/api/user', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization required' });
  }

  // JWT トークンから user_id を抽出（後で実装）
  res.json({ message: 'User endpoint' });
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

    // 既存ユーザーを確認
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', userInfo.email)
      .single();

    // ユーザーを登録/更新
    const userId = existingUser?.id || uuidv4();
    const { data, error } = await supabase
      .from('users')
      .upsert([{
        id: userId,
        email: userInfo.email,
        full_name: userInfo.name,
        avatar_url: userInfo.picture
      }])
      .select()
      .single();

    if (error) throw error;

    res.json({
      id: data.id,
      email: data.email,
      name: data.full_name,
      avatar: data.avatar_url
    });
  } catch (error) {
    console.error('Auth error:', error.message, error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ ダッシュボード用：アプリ一覧
app.get('/api/apps', async (req, res) => {
  try {
    const apps = [
      { id: 1, name: '安全パトロール', url: process.env.SAFETY_PATROL_URL || '#', icon: '✅' },
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

app.listen(PORT, () => {
  console.log(`✅ Portal API running on http://localhost:${PORT}`);
});
