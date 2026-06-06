-- Supabase auth.users と連携するユーザー情報テーブル
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL UNIQUE,
  full_name VARCHAR(255),
  department VARCHAR(255),
  role VARCHAR(50) DEFAULT 'user', -- user, manager, admin
  avatar_url TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- アプリ権限管理テーブル
CREATE TABLE IF NOT EXISTS public.app_permissions (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
  app_name VARCHAR(100), -- 'safety-patrol', 'employee-management', など
  access_level VARCHAR(50) DEFAULT 'user', -- user, manager, admin
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, app_name)
);

-- 部門・組織構造
CREATE TABLE IF NOT EXISTS public.departments (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  parent_id INTEGER REFERENCES public.departments(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- RLS ポリシー
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;

-- ユーザーは自分の情報のみ読み取り可能
CREATE POLICY "users_read_own" ON public.users
  FOR SELECT USING (id = auth.uid());

-- 管理者はすべてのユーザー情報を読み取り可能
CREATE POLICY "users_read_admin" ON public.users
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- アプリ権限情報は自分のもののみ読み取り可能
CREATE POLICY "app_permissions_read_own" ON public.app_permissions
  FOR SELECT USING (user_id = auth.uid());

-- 部門情報は全員読み取り可能
CREATE POLICY "departments_read_all" ON public.departments
  FOR SELECT USING (TRUE);
