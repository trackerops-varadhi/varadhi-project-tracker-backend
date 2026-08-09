-- ─── Varadhi Tracker — PostgreSQL Schema ──────────────────────────────────────
-- Run this file once to set up your database
-- Command: psql -U your_user -d varadhi_db -f src/config/schema.sql

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

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
-- Widths and nullability match migrate.js. `message` is nullable and `priority`
-- / `read_at` are present because notification-engine.js#writeInApp inserts
-- priority and notifications.controller.js#markAsRead writes read_at.
CREATE TABLE IF NOT EXISTS notifications (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type          VARCHAR(100) NOT NULL,
  title         VARCHAR(255) NOT NULL,
  message       TEXT,
  is_read       BOOLEAN DEFAULT FALSE,
  read_at       TIMESTAMP,
  user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
  link_to       VARCHAR(500),
  priority      VARCHAR(20) DEFAULT 'normal',
  -- Module 2: actionable notifications. `actions` is a snapshot of the buttons
  -- offered at creation time, not derived from `type` on read.
  actions       JSONB,
  action_taken  VARCHAR(32),
  actioned_at   TIMESTAMP,
  action_result JSONB,
  action_source VARCHAR(20),
  created_at    TIMESTAMP DEFAULT NOW()
);

-- ─── Notification Action Log (audit) ───────────────────────────────────────────
-- ON DELETE SET NULL, not CASCADE: deleteNotification hard-deletes rows and a
-- cascading audit log would erase the evidence it exists to preserve.
CREATE TABLE IF NOT EXISTS notification_action_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  notification_id UUID REFERENCES notifications(id) ON DELETE SET NULL,
  user_id         UUID REFERENCES users(id)         ON DELETE SET NULL,
  action          VARCHAR(32) NOT NULL,
  source          VARCHAR(20),
  outcome         VARCHAR(32) NOT NULL,
  resource_type   VARCHAR(32),
  resource_id     UUID,
  detail          JSONB,
  created_at      TIMESTAMP DEFAULT NOW()
);

-- ─── Notification Snoozes ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_snoozes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  notification_id UUID REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id)         ON DELETE CASCADE,
  wake_at         TIMESTAMP NOT NULL,
  delivered_at    TIMESTAMP,
  created_at      TIMESTAMP DEFAULT NOW()
);

-- ─── Notification Preferences ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_preferences (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id              UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  push_enabled         BOOLEAN DEFAULT TRUE,
  email_enabled        BOOLEAN DEFAULT FALSE,
  quiet_hours_enabled  BOOLEAN DEFAULT TRUE,
  quiet_hours_start    TIME DEFAULT '22:00',
  quiet_hours_end      TIME DEFAULT '07:00',
  task_assigned        BOOLEAN DEFAULT TRUE,
  task_status_changed  BOOLEAN DEFAULT TRUE,
  comment_added        BOOLEAN DEFAULT TRUE,
  due_date_reminder    BOOLEAN DEFAULT TRUE,
  project_updates      BOOLEAN DEFAULT TRUE,
  task_reassigned      BOOLEAN DEFAULT TRUE,
  due_date_changed     BOOLEAN DEFAULT TRUE,
  priority_changed     BOOLEAN DEFAULT TRUE,
  mentions             BOOLEAN DEFAULT TRUE,
  review_requests      BOOLEAN DEFAULT TRUE,
  approvals            BOOLEAN DEFAULT TRUE,
  overdue              BOOLEAN DEFAULT TRUE,
  documents            BOOLEAN DEFAULT TRUE,
  system_notifications BOOLEAN DEFAULT TRUE,
  reminder_lead_days   INTEGER,
  created_at           TIMESTAMP DEFAULT NOW(),
  updated_at           TIMESTAMP DEFAULT NOW()
);

-- ─── Push Subscriptions ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT UNIQUE NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  user_agent TEXT,
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
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread  ON notifications(user_id) WHERE is_read = false;
-- Serves notification-engine.js#isDuplicate, which runs on every dispatch.
CREATE INDEX IF NOT EXISTS idx_notifications_dedupe       ON notifications(user_id, type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user    ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_action_log_notification    ON notification_action_log(notification_id);
CREATE INDEX IF NOT EXISTS idx_action_log_user_created    ON notification_action_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_snoozes_due                ON notification_snoozes(wake_at) WHERE delivered_at IS NULL;

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
