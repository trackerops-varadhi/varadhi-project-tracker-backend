require('dotenv').config()
const pool = require('./db')

const createTables = async () => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    console.log('🔄 Running migrations...')

    // Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255),
        role VARCHAR(50) DEFAULT 'employee' CHECK (role IN ('admin','manager','employee')),
        status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active','inactive','invited')),
        avatar VARCHAR(500),
        invite_token VARCHAR(255),
        reset_token VARCHAR(255),
        reset_token_expires TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `)

    // Projects table
    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active','on_hold','completed','archived')),
        manager_id UUID REFERENCES users(id) ON DELETE SET NULL,
        start_date DATE,
        end_date DATE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `)

    // Project members junction table
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_members (
        project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        joined_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (project_id, user_id)
      )
    `)

    // Tasks table
    await client.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(500) NOT NULL,
        description TEXT,
        status VARCHAR(50) DEFAULT 'todo' CHECK (status IN ('todo','in_progress','in_review','completed')),
        priority VARCHAR(50) DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
        type VARCHAR(50) DEFAULT 'feature' CHECK (type IN ('feature','bug','infra','research','design')),
        project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
        assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
        reporter_id UUID REFERENCES users(id) ON DELETE SET NULL,
        due_date DATE,
        estimated_hours DECIMAL(5,2),
        actual_hours DECIMAL(5,2),
        tags TEXT[],
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `)

    // Comments table
    await client.query(`
      CREATE TABLE IF NOT EXISTS comments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        content TEXT NOT NULL,
        task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
        author_id UUID REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `)

    // Documents table
    await client.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(500) NOT NULL,
        original_name VARCHAR(500),
        file_type VARCHAR(50),
        file_size BIGINT,
        url VARCHAR(1000),
        description TEXT,
        project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
        uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `)

    // Notifications table
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        type VARCHAR(100) NOT NULL,
        title VARCHAR(255) NOT NULL,
        message TEXT,
        is_read BOOLEAN DEFAULT FALSE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        link_to VARCHAR(500),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `)

    // Leave requests table
    await client.query(`
      CREATE TABLE IF NOT EXISTS leave_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        days INTEGER NOT NULL DEFAULT 1,
        type VARCHAR(30) NOT NULL DEFAULT 'annual',
        reason TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `)

    // Time logs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS time_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        hours NUMERIC(5,2) NOT NULL DEFAULT 0,
        note TEXT,
        check_in TIMESTAMP,
        check_out TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `)

    await client.query('COMMIT')
    console.log('✅ All tables created successfully!')
    process.exit(0)
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('❌ Migration failed:', err.message)
    process.exit(1)
  } finally {
    client.release()
  }
}

createTables()
