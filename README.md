# Varadhi Tracker — Backend API

Node.js + Express + PostgreSQL REST API

## 🚀 Local Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Setup environment

```bash
cp .env.example .env
# Edit .env with your database credentials
```

### 3. Create database

```bash
# In PostgreSQL:
createdb varadhi_db
```

### 4. Run migrations

```bash
npm run migrate
```

node-pg-migrate is the only migration system: one directory per module under
`migrations/`, one version ledger per schema. See `migrations/README.md`.

### 5. Seed with test data

```bash
npm run db:seed
```

### 6. Start development server

```bash
npm run dev
```

API runs at: http://localhost:5000

## 🔑 Test Accounts (after seeding)

| Role     | Email                | Password    |
| -------- | -------------------- | ----------- |
| Admin    | admin@varadhi.com    | password123 |
| Manager  | jagdish@varadhi.com  | password123 |
| Employee | Employee@varadhi.com | password123 |

## 📡 API Endpoints

### Auth

| Method | Endpoint                  | Description      |
| ------ | ------------------------- | ---------------- |
| POST   | /api/auth/register        | Register user    |
| POST   | /api/auth/login           | Login            |
| POST   | /api/auth/logout          | Logout           |
| GET    | /api/auth/me              | Get current user |
| POST   | /api/auth/forgot-password | Forgot password  |
| POST   | /api/auth/reset-password  | Reset password   |
| PUT    | /api/auth/change-password | Change password  |

### Projects

| Method | Endpoint                       | Description       |
| ------ | ------------------------------ | ----------------- |
| GET    | /api/projects                  | Get all projects  |
| POST   | /api/projects                  | Create project    |
| GET    | /api/projects/:id              | Get project       |
| PUT    | /api/projects/:id              | Update project    |
| PATCH  | /api/projects/:id/archive      | Archive project   |
| DELETE | /api/projects/:id              | Delete project    |
| GET    | /api/projects/:id/tasks        | Get project tasks |
| POST   | /api/projects/:id/members      | Add member        |
| DELETE | /api/projects/:id/members/:uid | Remove member     |

### Tasks

| Method | Endpoint                     | Description    |
| ------ | ---------------------------- | -------------- |
| GET    | /api/tasks                   | Get all tasks  |
| POST   | /api/tasks                   | Create task    |
| GET    | /api/tasks/:id               | Get task       |
| PUT    | /api/tasks/:id               | Update task    |
| PATCH  | /api/tasks/:id/status        | Update status  |
| DELETE | /api/tasks/:id               | Delete task    |
| POST   | /api/tasks/:id/comments      | Add comment    |
| DELETE | /api/tasks/:id/comments/:cid | Delete comment |

### Users

| Method | Endpoint                  | Description     |
| ------ | ------------------------- | --------------- |
| GET    | /api/users                | Get all users   |
| GET    | /api/users/:id            | Get user        |
| PUT    | /api/users/profile        | Update profile  |
| POST   | /api/users/invite         | Invite user     |
| PATCH  | /api/users/:id/role       | Change role     |
| PATCH  | /api/users/:id/deactivate | Deactivate user |

### Dashboard

| Method | Endpoint                    | Description  |
| ------ | --------------------------- | ------------ |
| GET    | /api/dashboard/stats        | Get stats    |
| GET    | /api/dashboard/activity     | Get activity |
| GET    | /api/dashboard/burndown/:id | Get burndown |

### Documents

| Method | Endpoint              | Description  |
| ------ | --------------------- | ------------ |
| GET    | /api/documents        | Get all docs |
| POST   | /api/documents/upload | Upload file  |
| DELETE | /api/documents/:id    | Delete doc   |

## 🚀 Deploy to Render

1. Push code to GitHub
2. Go to render.com → New → Web Service
3. Connect your GitHub repo
4. Render auto-detects render.yaml
5. Add environment variables
6. Deploy!
