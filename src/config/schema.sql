-- ─── Varadhi Tracker — PostgreSQL Schema ──────────────────────────────────────
-- Run this file once to set up your database
-- Command: psql -U your_user -d varadhi_db -f src/config/schema.sql

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password      VARCHAR(255),
  role          VARCHAR(20) NOT NULL DEFAULT 'employee'
                CHECK (role IN ('admin', 'manager', 'employee')),
  status        VARCHAR(20) NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'inactive', 'invited')),
  avatar        TEXT,
  invite_token  VARCHAR(255),
  reset_token   VARCHAR(255),
  reset_expires TIMESTAMP,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);

-- ─── Projects ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name           VARCHAR(200) NOT NULL,
  description    TEXT,
  status         VARCHAR(20) NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'on_hold', 'completed', 'archived')),
  manager_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  start_date     DATE,
  end_date       DATE,
  created_at     TIMESTAMP DEFAULT NOW(),
  updated_at     TIMESTAMP DEFAULT NOW()
);

-- ─── Project Members ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_members (
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  joined_at  TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (project_id, user_id)
);

-- ─── Tasks ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title            VARCHAR(300) NOT NULL,
  description      TEXT,
  status           VARCHAR(20) NOT NULL DEFAULT 'todo'
                   CHECK (status IN ('todo', 'in_progress', 'in_review', 'completed')),
  priority         VARCHAR(20) NOT NULL DEFAULT 'medium'
                   CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  type             VARCHAR(20) NOT NULL DEFAULT 'feature'
                   CHECK (type IN ('feature', 'bug', 'infra', 'research', 'design')),
  project_id       UUID REFERENCES projects(id) ON DELETE CASCADE,
  assignee_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  reporter_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  due_date         DATE,
  estimated_hours  NUMERIC(5,2),
  actual_hours     NUMERIC(5,2),
  tags             TEXT[],
  created_at       TIMESTAMP DEFAULT NOW(),
  updated_at       TIMESTAMP DEFAULT NOW()
);

-- ─── Comments ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comments (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  content    TEXT NOT NULL,
  task_id    UUID REFERENCES tasks(id) ON DELETE CASCADE,
  author_id  UUID REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ─── Documents ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS documents (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name             VARCHAR(300) NOT NULL,
  original_name    VARCHAR(300) NOT NULL,
  file_type        VARCHAR(20),
  file_size        BIGINT,
  url              TEXT NOT NULL,
  public_id        TEXT,
  description      TEXT,
  project_id       UUID REFERENCES projects(id) ON DELETE SET NULL,
  uploaded_by_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMP DEFAULT NOW()
);

-- ─── Notifications ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type       VARCHAR(50) NOT NULL,
  title      VARCHAR(200) NOT NULL,
  message    TEXT NOT NULL,
  is_read    BOOLEAN DEFAULT FALSE,
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  link_to    VARCHAR(300),
  created_at TIMESTAMP DEFAULT NOW()
);

-- ─── Leave Requests ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leave_requests (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date   DATE NOT NULL,
  days       INTEGER NOT NULL DEFAULT 1,
  type       VARCHAR(30) NOT NULL DEFAULT 'annual',
  reason     TEXT NOT NULL,
  status     VARCHAR(20) NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMP DEFAULT NOW()
);

-- ─── Time Logs ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS time_logs (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  date       DATE NOT NULL,
  hours      NUMERIC(5,2) NOT NULL DEFAULT 0,
  note       TEXT,
  check_in   TIMESTAMP,
  check_out  TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ─── Indexes for performance ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_tasks_project_id    ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_id   ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status        ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_comments_task_id    ON comments(task_id);
CREATE INDEX IF NOT EXISTS idx_documents_project   ON documents(project_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user  ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read  ON notifications(user_id, is_read);

-- ─── Updated_at trigger ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER update_projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER update_tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── Seed: Default Admin User ──────────────────────────────────────────────────
-- Password: admin123 (bcrypt hash)
INSERT INTO users (name, email, password, role, status)
VALUES (
  'Admin User',
  'admin@varadhi.com',
  '$2a$10$rQnX3vGgMkGpZMlEe1xpT.6U2SkBrPzpzh3Xw8YQ8xFhkzFVjX6.i',
  'admin',
  'active'
) ON CONFLICT (email) DO NOTHING;
