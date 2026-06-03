-- ============================================
-- Supabase 数据库建表脚本
-- 在 Supabase SQL Editor 中执行
-- ============================================

-- 产品库存表
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  batch TEXT NOT NULL,
  expiry_date DATE NOT NULL,
  stock INTEGER DEFAULT 0,
  last_month_sales INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 医院回款表
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  hospital TEXT NOT NULL,
  cycle TEXT NOT NULL,
  next_date DATE NOT NULL,
  amount INTEGER DEFAULT 0,
  process TEXT DEFAULT '',
  contact TEXT DEFAULT '',
  role TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  paid BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 开启行级安全
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

-- RLS 策略：用户只能读写自己的数据
CREATE POLICY "products_own" ON products FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "payments_own" ON payments FOR ALL USING (auth.uid() = user_id);

-- 索引
CREATE INDEX idx_products_user ON products(user_id);
CREATE INDEX idx_payments_user ON payments(user_id);
