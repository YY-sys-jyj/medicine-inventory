-- 用户角色和订阅表
CREATE TABLE IF NOT EXISTS user_roles (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'user',
  admin_level INTEGER,
  trial_ends_at TIMESTAMPTZ,
  paid_until TIMESTAMPTZ,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_read_own" ON user_roles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "admins_read_all" ON user_roles FOR SELECT USING (
  EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role IN ('super_admin','admin'))
);
CREATE POLICY "super_admin_insert" ON user_roles FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'super_admin')
);
CREATE POLICY "super_admin_delete" ON user_roles FOR DELETE USING (
  EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'super_admin')
);
