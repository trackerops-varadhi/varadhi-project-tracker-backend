# Database schema

<!-- GENERATED FILE — do not edit by hand.
     Regenerate with: npm run schema:doc
     Source: scripts/gen-schema-doc.js -->

Generated **2026-10-13 12:14 UTC** from the **development (Supabase)** database.

This file is generated from a live database, never read by the application, and nothing migrates from it. The authority for the schema remains `migrations/<module>/*.js`; this is the readable view of what those migrations have produced. If it disagrees with the database it is out of date — run `npm run schema:doc`.

**8 module schemas, 45 tables** — the schemas this backend owns.

Schemas this backend does not own are named at the end rather than expanded: documenting the platform's own `auth.users` beside our `identity.users` would invite exactly the wrong conclusion, since this backend issues its own tokens and never reads it.

## Migration state

Each module owns its tables and its own ledger, so "what version is the database at" has one answer per
module. This is the position the rest of this document was read at.

| Module | Ledger | Applied | At |
| --- | --- | --- | --- |
| `identity` | `identity.pgmigrations` | 4 | `0004_qc_role` |
| `work` | `work.pgmigrations` | 2 | `0002_task_story_fields` |
| `defects` | `defects.pgmigrations` | 1 | `0001_baseline` |
| `notify` | `notify.pgmigrations` | 1 | `0001_baseline` |
| `integrations` | `integrations.pgmigrations` | 1 | `0001_baseline` |
| `files` | `files.pgmigrations` | 1 | `0001_baseline` |
| `workforce` | `workforce.pgmigrations` | 3 | `0003_work_status` |
| `people` | `people.pgmigrations` | 3 | `0003_recruitment` |

---

## `identity`

### `identity.rate_limit_buckets`

3 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `bucket_key` 🔑 | text | no | — |
| `hits` | integer | no | 0 |
| `reset_at` | timestamptz | no | — |

Indexes:

- `idx_rate_limit_buckets_reset_at` — `identity.rate_limit_buckets USING btree (reset_at)`

### `identity.user_sessions`

13 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `user_id` | uuid | no | — |
| `browser` | varchar(100) | yes | — |
| `os` | varchar(100) | yes | — |
| `device_label` | varchar(200) | yes | — |
| `ip_address` | text | yes | — |
| `user_agent` | text | yes | — |
| `created_at` | timestamptz | no | now() |
| `last_active_at` | timestamptz | no | now() |
| `expires_at` | timestamptz | no | — |
| `revoked_at` | timestamptz | yes | — |
| `revoked_reason` | varchar(30) | yes | — |
| `revoked_by` | uuid | yes | — |

Constraints:

- **CHECK** `user_sessions_revoked_reason_check` — `CHECK (((revoked_reason)::text = ANY ((ARRAY['logout'::character varying, 'logout_all'::character varying, 'user_revoked'::character varying, 'admin_revoked'::character varying, 'password_change'::character varying, 'password_reset'::character varying, 'token_reuse'::character varying, 'account_deactivated'::character varying, 'inactivity'::character varying, 'expired'::character varying, 'migrated'::character varying])::text[])))`
- **FOREIGN KEY** `user_sessions_revoked_by_fkey` — `FOREIGN KEY (revoked_by) REFERENCES identity.users(id) ON DELETE SET NULL`
- **FOREIGN KEY** `user_sessions_user_id_fkey` — `FOREIGN KEY (user_id) REFERENCES identity.users(id) ON DELETE CASCADE`

Indexes:

- `idx_user_sessions_expiry` — `identity.user_sessions USING btree (expires_at)`
- `idx_user_sessions_user_active` — `identity.user_sessions USING btree (user_id, last_active_at DESC) WHERE (revoked_at IS NULL)`

### `identity.user_tokens`

13 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `user_id` | uuid | no | — |
| `token_type` | varchar(20) | no | — |
| `token_hash` | text | no | — |
| `session_id` | uuid | no | — |
| `refresh_family_id` | uuid | yes | — |
| `expires_at` | timestamptz | no | — |
| `revoked_at` | timestamptz | yes | — |
| `replaced_by_token_id` | uuid | yes | — |
| `user_agent` | text | yes | — |
| `ip_address` | text | yes | — |
| `created_at` | timestamptz | no | now() |
| `updated_at` | timestamptz | no | now() |

Constraints:

- **CHECK** `user_tokens_token_type_check` — `CHECK (((token_type)::text = ANY ((ARRAY['access'::character varying, 'refresh'::character varying])::text[])))`
- **FOREIGN KEY** `user_tokens_replaced_by_token_id_fkey` — `FOREIGN KEY (replaced_by_token_id) REFERENCES identity.user_tokens(id) ON DELETE SET NULL`
- **FOREIGN KEY** `user_tokens_user_id_fkey` — `FOREIGN KEY (user_id) REFERENCES identity.users(id) ON DELETE CASCADE`
- **UNIQUE** `user_tokens_token_hash_key` — `UNIQUE (token_hash)`

Indexes:

- `idx_user_tokens_active_lookup` — `identity.user_tokens USING btree (token_hash, token_type) WHERE (revoked_at IS NULL)`
- `idx_user_tokens_expiry` — `identity.user_tokens USING btree (expires_at)`
- `idx_user_tokens_session_id` — `identity.user_tokens USING btree (session_id)`
- `idx_user_tokens_user_id` — `identity.user_tokens USING btree (user_id)`

### `identity.users`

12 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `name` | varchar(255) | no | — |
| `email` | varchar(255) | no | — |
| `password` | varchar(255) | yes | — |
| `role` | varchar(50) | yes | 'employee'::character varying |
| `status` | varchar(50) | yes | 'active'::character varying |
| `avatar` | varchar(500) | yes | — |
| `invite_token` | varchar(255) | yes | — |
| `reset_token` | varchar(255) | yes | — |
| `reset_token_expires` | timestamp | yes | — |
| `created_at` | timestamp | yes | now() |
| `updated_at` | timestamp | yes | now() |

Constraints:

- **CHECK** `users_role_check` — `CHECK (((role)::text = ANY ((ARRAY['admin'::character varying, 'manager'::character varying, 'employee'::character varying, 'hr'::character varying, 'qc'::character varying])::text[])))`
- **CHECK** `users_status_check` — `CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('inactive'::character varying)::text, ('invited'::character varying)::text])))`
- **UNIQUE** `users_email_key` — `UNIQUE (email)`

---

## `work`

### `work.comments`

6 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `content` | text | no | — |
| `task_id` | uuid | yes | — |
| `author_id` | uuid | yes | — |
| `created_at` | timestamp | yes | now() |
| `updated_at` | timestamp | yes | now() |

Constraints:

- **FOREIGN KEY** `comments_task_id_fkey` — `FOREIGN KEY (task_id) REFERENCES work.tasks(id) ON DELETE CASCADE`

### `work.project_members`

3 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `project_id` 🔑 | uuid | no | — |
| `user_id` 🔑 | uuid | no | — |
| `joined_at` | timestamp | yes | now() |

Constraints:

- **FOREIGN KEY** `project_members_project_id_fkey` — `FOREIGN KEY (project_id) REFERENCES work.projects(id) ON DELETE CASCADE`

### `work.projects`

9 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `name` | varchar(255) | no | — |
| `description` | text | yes | — |
| `status` | varchar(50) | yes | 'active'::character varying |
| `manager_id` | uuid | yes | — |
| `start_date` | date | yes | — |
| `end_date` | date | yes | — |
| `created_at` | timestamp | yes | now() |
| `updated_at` | timestamp | yes | now() |

Constraints:

- **CHECK** `projects_status_check` — `CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('on_hold'::character varying)::text, ('completed'::character varying)::text, ('archived'::character varying)::text])))`

### `work.tasks`

18 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `title` | varchar(500) | no | — |
| `description` | text | yes | — |
| `status` | varchar(50) | yes | 'todo'::character varying |
| `priority` | varchar(50) | yes | 'medium'::character varying |
| `type` | varchar(50) | yes | 'feature'::character varying |
| `project_id` | uuid | yes | — |
| `assignee_id` | uuid | yes | — |
| `reporter_id` | uuid | yes | — |
| `due_date` | date | yes | — |
| `estimated_hours` | numeric(5,2) | yes | — |
| `actual_hours` | numeric(5,2) | yes | — |
| `tags` | text[] | yes | — |
| `created_at` | timestamp | yes | now() |
| `updated_at` | timestamp | yes | now() |
| `completed_at` | timestamp | yes | — |
| `user_story` | text | yes | — |
| `acceptance_criteria` | text | yes | — |

Constraints:

- **CHECK** `tasks_priority_check` — `CHECK (((priority)::text = ANY (ARRAY[('low'::character varying)::text, ('medium'::character varying)::text, ('high'::character varying)::text, ('critical'::character varying)::text])))`
- **CHECK** `tasks_status_check` — `CHECK (((status)::text = ANY (ARRAY[('todo'::character varying)::text, ('in_progress'::character varying)::text, ('in_review'::character varying)::text, ('completed'::character varying)::text])))`
- **CHECK** `tasks_type_check` — `CHECK (((type)::text = ANY (ARRAY[('feature'::character varying)::text, ('bug'::character varying)::text, ('infra'::character varying)::text, ('research'::character varying)::text, ('design'::character varying)::text])))`
- **FOREIGN KEY** `tasks_project_id_fkey` — `FOREIGN KEY (project_id) REFERENCES work.projects(id) ON DELETE CASCADE`

---

## `defects`

### `defects.bug_activity_logs`

9 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `bug_id` | uuid | no | — |
| `actor_id` | uuid | yes | — |
| `action` | varchar(40) | no | — |
| `field` | varchar(60) | yes | — |
| `old_value` | text | yes | — |
| `new_value` | text | yes | — |
| `detail` | jsonb | yes | — |
| `created_at` | timestamptz | no | now() |

Constraints:

- **FOREIGN KEY** `bug_activity_logs_bug_id_fkey` — `FOREIGN KEY (bug_id) REFERENCES defects.bugs(id) ON DELETE CASCADE`

Indexes:

- `idx_bug_activity_action` — `defects.bug_activity_logs USING btree (action)`
- `idx_bug_activity_bug` — `defects.bug_activity_logs USING btree (bug_id, created_at DESC)`

### `defects.bug_attachments`

10 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `bug_id` | uuid | no | — |
| `document_id` | uuid | yes | — |
| `file_name` | varchar(500) | no | — |
| `file_type` | varchar(50) | yes | — |
| `file_size` | bigint | yes | — |
| `url` | varchar(1000) | no | — |
| `storage_path` | varchar(1000) | yes | — |
| `uploaded_by` | uuid | yes | — |
| `created_at` | timestamptz | no | now() |

Constraints:

- **FOREIGN KEY** `bug_attachments_bug_id_fkey` — `FOREIGN KEY (bug_id) REFERENCES defects.bugs(id) ON DELETE CASCADE`

Indexes:

- `idx_bug_attachments_bug` — `defects.bug_attachments USING btree (bug_id, created_at DESC)`

### `defects.bug_comments`

7 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `bug_id` | uuid | no | — |
| `author_id` | uuid | yes | — |
| `content` | text | no | — |
| `edited` | boolean | no | false |
| `created_at` | timestamptz | no | now() |
| `updated_at` | timestamptz | no | now() |

Constraints:

- **FOREIGN KEY** `bug_comments_bug_id_fkey` — `FOREIGN KEY (bug_id) REFERENCES defects.bugs(id) ON DELETE CASCADE`

Indexes:

- `idx_bug_comments_bug` — `defects.bug_comments USING btree (bug_id, created_at)`

### `defects.bug_sla_rules`

9 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `severity` | varchar(20) | no | — |
| `response_minutes` | integer | no | — |
| `resolution_minutes` | integer | no | — |
| `at_risk_threshold` | numeric(3,2) | no | 0.75 |
| `description` | text | yes | — |
| `updated_by` | uuid | yes | — |
| `created_at` | timestamptz | no | now() |
| `updated_at` | timestamptz | no | now() |

Constraints:

- **CHECK** `bug_sla_rules_at_risk_threshold_check` — `CHECK (((at_risk_threshold > (0)::numeric) AND (at_risk_threshold < (1)::numeric)))`
- **CHECK** `bug_sla_rules_resolution_minutes_check` — `CHECK ((resolution_minutes > 0))`
- **CHECK** `bug_sla_rules_response_minutes_check` — `CHECK ((response_minutes > 0))`
- **CHECK** `bug_sla_rules_severity_check` — `CHECK (((severity)::text = ANY ((ARRAY['critical'::character varying, 'high'::character varying, 'medium'::character varying, 'low'::character varying])::text[])))`
- **UNIQUE** `bug_sla_rules_severity_key` — `UNIQUE (severity)`

### `defects.bugs`

29 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `bug_number` | integer | no | auto |
| `title` | varchar(500) | no | — |
| `description` | text | no | — |
| `status` | varchar(30) | no | 'open'::character varying |
| `severity` | varchar(20) | no | 'medium'::character varying |
| `priority` | varchar(10) | no | 'p2'::character varying |
| `environment` | varchar(30) | no | 'production'::character varying |
| `project_id` | uuid | yes | — |
| `assignee_id` | uuid | yes | — |
| `reporter_id` | uuid | yes | — |
| `linked_task_id` | uuid | yes | — |
| `duplicate_of_id` | uuid | yes | — |
| `resolution` | text | yes | — |
| `root_cause` | text | yes | — |
| `steps_to_reproduce` | text | yes | — |
| `sla_rule_id` | uuid | yes | — |
| `sla_started_at` | timestamptz | no | now() |
| `sla_response_due_at` | timestamptz | yes | — |
| `sla_resolution_due_at` | timestamptz | yes | — |
| `first_response_at` | timestamptz | yes | — |
| `resolved_at` | timestamptz | yes | — |
| `closed_at` | timestamptz | yes | — |
| `sla_breached` | boolean | no | false |
| `sla_breached_at` | timestamptz | yes | — |
| `sla_at_risk_notified_at` | timestamptz | yes | — |
| `reopen_count` | integer | no | 0 |
| `created_at` | timestamptz | no | now() |
| `updated_at` | timestamptz | no | now() |

Constraints:

- **CHECK** `bugs_duplicate_not_self` — `CHECK (((duplicate_of_id IS NULL) OR (duplicate_of_id <> id)))`
- **CHECK** `bugs_environment_check` — `CHECK (((environment)::text = ANY ((ARRAY['production'::character varying, 'staging'::character varying, 'qa'::character varying, 'development'::character varying, 'local'::character varying])::text[])))`
- **CHECK** `bugs_priority_check` — `CHECK (((priority)::text = ANY ((ARRAY['p0'::character varying, 'p1'::character varying, 'p2'::character varying, 'p3'::character varying])::text[])))`
- **CHECK** `bugs_severity_check` — `CHECK (((severity)::text = ANY ((ARRAY['critical'::character varying, 'high'::character varying, 'medium'::character varying, 'low'::character varying])::text[])))`
- **CHECK** `bugs_status_check` — `CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'assigned'::character varying, 'in_progress'::character varying, 'fixed'::character varying, 'qa_verification'::character varying, 'closed'::character varying, 'reopened'::character varying, 'duplicate'::character varying, 'rejected'::character varying, 'wont_fix'::character varying, 'deferred'::character varying])::text[])))`
- **FOREIGN KEY** `bugs_duplicate_of_id_fkey` — `FOREIGN KEY (duplicate_of_id) REFERENCES defects.bugs(id) ON DELETE SET NULL`
- **FOREIGN KEY** `bugs_sla_rule_id_fkey` — `FOREIGN KEY (sla_rule_id) REFERENCES defects.bug_sla_rules(id) ON DELETE SET NULL`
- **UNIQUE** `bugs_bug_number_key` — `UNIQUE (bug_number)`

Indexes:

- `idx_bugs_assignee` — `defects.bugs USING btree (assignee_id)`
- `idx_bugs_created` — `defects.bugs USING btree (created_at DESC)`
- `idx_bugs_environment` — `defects.bugs USING btree (environment)`
- `idx_bugs_linked_task` — `defects.bugs USING btree (linked_task_id)`
- `idx_bugs_priority` — `defects.bugs USING btree (priority)`
- `idx_bugs_project` — `defects.bugs USING btree (project_id)`
- `idx_bugs_reporter` — `defects.bugs USING btree (reporter_id)`
- `idx_bugs_search` — `defects.bugs USING gin (to_tsvector('english'::regconfig, (((title)::text || ' '::text) || COALESCE(description, ''::text))))`
- `idx_bugs_severity` — `defects.bugs USING btree (severity)`
- `idx_bugs_sla_open` — `defects.bugs USING btree (sla_resolution_due_at) WHERE ((status)::text <> ALL ((ARRAY['closed'::character varying, 'duplicate'::character varying, 'rejected'::character varying, 'wont_fix'::character varying, 'deferred'::character varying])::text[]))`
- `idx_bugs_status` — `defects.bugs USING btree (status)`

---

## `notify`

### `notify.notification_action_log`

10 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `notification_id` | uuid | yes | — |
| `user_id` | uuid | yes | — |
| `action` | varchar(32) | no | — |
| `source` | varchar(20) | yes | — |
| `outcome` | varchar(32) | no | — |
| `resource_type` | varchar(32) | yes | — |
| `resource_id` | uuid | yes | — |
| `detail` | jsonb | yes | — |
| `created_at` | timestamp | yes | now() |

Constraints:

- **FOREIGN KEY** `notification_action_log_notification_id_fkey` — `FOREIGN KEY (notification_id) REFERENCES notify.notifications(id) ON DELETE SET NULL`

Indexes:

- `idx_action_log_notification` — `notify.notification_action_log USING btree (notification_id)`
- `idx_action_log_user_created` — `notify.notification_action_log USING btree (user_id, created_at DESC)`

### `notify.notification_logs`

9 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `user_id` | uuid | yes | — |
| `type` | varchar(100) | yes | — |
| `title` | varchar(255) | yes | — |
| `priority` | varchar(20) | yes | — |
| `status` | varchar(20) | no | — |
| `channels` | jsonb | yes | — |
| `error_message` | text | yes | — |
| `created_at` | timestamp | yes | now() |

Indexes:

- `idx_notification_logs_created` — `notify.notification_logs USING btree (created_at)`
- `idx_notification_logs_user` — `notify.notification_logs USING btree (user_id)`
- `idx_notification_logs_user_created` — `notify.notification_logs USING btree (user_id, created_at DESC)`

### `notify.notification_preferences`

24 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `user_id` | uuid | yes | — |
| `push_enabled` | boolean | yes | true |
| `email_enabled` | boolean | yes | false |
| `quiet_hours_start` | time | yes | '22:00:00'::time without time zone |
| `quiet_hours_end` | time | yes | '07:00:00'::time without time zone |
| `created_at` | timestamp | yes | now() |
| `updated_at` | timestamp | yes | now() |
| `quiet_hours_enabled` | boolean | yes | true |
| `task_assigned` | boolean | yes | true |
| `task_status_changed` | boolean | yes | true |
| `comment_added` | boolean | yes | true |
| `due_date_reminder` | boolean | yes | true |
| `project_updates` | boolean | yes | true |
| `task_reassigned` | boolean | yes | true |
| `due_date_changed` | boolean | yes | true |
| `priority_changed` | boolean | yes | true |
| `mentions` | boolean | yes | true |
| `review_requests` | boolean | yes | true |
| `approvals` | boolean | yes | true |
| `overdue` | boolean | yes | true |
| `documents` | boolean | yes | true |
| `system_notifications` | boolean | yes | true |
| `reminder_lead_days` | integer | yes | — |

Constraints:

- **UNIQUE** `notification_preferences_user_id_key` — `UNIQUE (user_id)`

### `notify.notification_snoozes`

6 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `notification_id` | uuid | yes | — |
| `user_id` | uuid | yes | — |
| `wake_at` | timestamp | no | — |
| `delivered_at` | timestamp | yes | — |
| `created_at` | timestamp | yes | now() |

Constraints:

- **FOREIGN KEY** `notification_snoozes_notification_id_fkey` — `FOREIGN KEY (notification_id) REFERENCES notify.notifications(id) ON DELETE CASCADE`

Indexes:

- `idx_snoozes_due` — `notify.notification_snoozes USING btree (wake_at) WHERE (delivered_at IS NULL)`

### `notify.notifications`

15 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `type` | varchar(100) | no | — |
| `title` | varchar(255) | no | — |
| `message` | text | yes | — |
| `is_read` | boolean | yes | false |
| `user_id` | uuid | yes | — |
| `link_to` | varchar(500) | yes | — |
| `created_at` | timestamp | yes | now() |
| `priority` | varchar(20) | yes | 'normal'::character varying |
| `read_at` | timestamp | yes | — |
| `actions` | jsonb | yes | — |
| `action_taken` | varchar(32) | yes | — |
| `actioned_at` | timestamp | yes | — |
| `action_result` | jsonb | yes | — |
| `action_source` | varchar(20) | yes | — |

Indexes:

- `idx_notifications_dedupe` — `notify.notifications USING btree (user_id, type, created_at DESC)`
- `idx_notifications_user_created` — `notify.notifications USING btree (user_id, created_at DESC)`
- `idx_notifications_user_unread` — `notify.notifications USING btree (user_id) WHERE (is_read = false)`

### `notify.push_delivery_retries`

13 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `notification_id` | uuid | yes | — |
| `user_id` | uuid | yes | — |
| `subscription_id` | uuid | yes | — |
| `payload` | jsonb | no | — |
| `send_options` | jsonb | yes | — |
| `attempts` | integer | no | 0 |
| `next_attempt_at` | timestamptz | no | now() |
| `last_error` | text | yes | — |
| `last_status` | integer | yes | — |
| `status` | varchar(16) | no | 'pending'::character varying |
| `created_at` | timestamptz | no | now() |
| `updated_at` | timestamptz | no | now() |

Constraints:

- **FOREIGN KEY** `push_delivery_retries_notification_id_fkey` — `FOREIGN KEY (notification_id) REFERENCES notify.notifications(id) ON DELETE CASCADE`

Indexes:

- `idx_push_retries_due` — `notify.push_delivery_retries USING btree (next_attempt_at) WHERE ((status)::text = 'pending'::text)`
- `idx_push_retries_unique` — `notify.push_delivery_retries USING btree (notification_id, subscription_id)`
- `idx_push_retries_user` — `notify.push_delivery_retries USING btree (user_id)`

### `notify.push_subscriptions`

7 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `user_id` | uuid | yes | — |
| `endpoint` | text | no | — |
| `p256dh` | text | no | — |
| `auth` | text | no | — |
| `user_agent` | text | yes | — |
| `created_at` | timestamp | yes | now() |

Constraints:

- **UNIQUE** `push_subscriptions_endpoint_key` — `UNIQUE (endpoint)`

Indexes:

- `idx_push_subscriptions_user` — `notify.push_subscriptions USING btree (user_id)`

---

## `integrations`

### `integrations.calendar_connections`

14 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `user_id` | uuid | no | — |
| `provider` | varchar(20) | no | — |
| `account_email` | varchar(255) | yes | — |
| `calendar_id` | varchar(255) | yes | — |
| `access_token` | text | yes | — |
| `refresh_token` | text | yes | — |
| `token_expires_at` | timestamptz | yes | — |
| `sync_token` | text | yes | — |
| `status` | varchar(20) | no | 'connected'::character varying |
| `last_synced_at` | timestamptz | yes | — |
| `last_error` | text | yes | — |
| `created_at` | timestamptz | yes | now() |
| `updated_at` | timestamptz | yes | now() |

Constraints:

- **CHECK** `calendar_connections_provider_check` — `CHECK (((provider)::text = ANY ((ARRAY['google'::character varying, 'outlook'::character varying])::text[])))`
- **CHECK** `calendar_connections_status_check` — `CHECK (((status)::text = ANY ((ARRAY['connected'::character varying, 'disconnected'::character varying, 'error'::character varying, 'paused'::character varying])::text[])))`
- **UNIQUE** `calendar_connections_user_provider_key` — `UNIQUE (user_id, provider)`

Indexes:

- `idx_calendar_connections_active` — `integrations.calendar_connections USING btree (status, last_synced_at) WHERE ((status)::text = 'connected'::text)`
- `idx_calendar_connections_user` — `integrations.calendar_connections USING btree (user_id)`

### `integrations.calendar_event_links`

14 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `connection_id` | uuid | no | — |
| `source_type` | varchar(20) | no | — |
| `source_id` | uuid | no | — |
| `provider_event_id` | varchar(512) | yes | — |
| `content_hash` | varchar(64) | yes | — |
| `remote_etag` | varchar(512) | yes | — |
| `recurrence_rule` | text | yes | — |
| `state` | varchar(20) | no | 'pending'::character varying |
| `last_pushed_at` | timestamptz | yes | — |
| `last_pulled_at` | timestamptz | yes | — |
| `last_error` | text | yes | — |
| `created_at` | timestamptz | yes | now() |
| `updated_at` | timestamptz | yes | now() |

Constraints:

- **CHECK** `calendar_event_links_source_type_check` — `CHECK (((source_type)::text = ANY ((ARRAY['task'::character varying, 'milestone'::character varying, 'meeting'::character varying, 'reminder'::character varying])::text[])))`
- **CHECK** `calendar_event_links_state_check` — `CHECK (((state)::text = ANY ((ARRAY['pending'::character varying, 'synced'::character varying, 'dirty'::character varying, 'deleted'::character varying, 'error'::character varying])::text[])))`
- **FOREIGN KEY** `calendar_event_links_connection_id_fkey` — `FOREIGN KEY (connection_id) REFERENCES integrations.calendar_connections(id) ON DELETE CASCADE`
- **UNIQUE** `calendar_event_links_source_key` — `UNIQUE (connection_id, source_type, source_id)`

Indexes:

- `idx_calendar_links_pending` — `integrations.calendar_event_links USING btree (connection_id, state) WHERE ((state)::text = ANY ((ARRAY['pending'::character varying, 'dirty'::character varying])::text[]))`
- `idx_calendar_links_provider_event` — `integrations.calendar_event_links USING btree (connection_id, provider_event_id) WHERE (provider_event_id IS NOT NULL)`
- `idx_calendar_links_source` — `integrations.calendar_event_links USING btree (source_type, source_id)`

### `integrations.calendar_sync_conflicts`

11 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `link_id` | uuid | no | — |
| `connection_id` | uuid | no | — |
| `conflict_type` | varchar(20) | no | 'update'::character varying |
| `field` | varchar(64) | yes | — |
| `tracker_value` | text | yes | — |
| `provider_value` | text | yes | — |
| `resolution` | varchar(20) | yes | — |
| `resolved_by` | uuid | yes | — |
| `resolved_at` | timestamptz | yes | — |
| `detected_at` | timestamptz | yes | now() |

Constraints:

- **CHECK** `calendar_sync_conflicts_conflict_type_check` — `CHECK (((conflict_type)::text = ANY ((ARRAY['update'::character varying, 'time'::character varying, 'deletion'::character varying])::text[])))`
- **CHECK** `calendar_sync_conflicts_resolution_check` — `CHECK (((resolution)::text = ANY ((ARRAY['use_tracker'::character varying, 'use_calendar'::character varying, 'keep_both'::character varying, 'reschedule'::character varying, 'delete_everywhere'::character varying, 'keep_event'::character varying])::text[])))`
- **FOREIGN KEY** `calendar_sync_conflicts_connection_id_fkey` — `FOREIGN KEY (connection_id) REFERENCES integrations.calendar_connections(id) ON DELETE CASCADE`
- **FOREIGN KEY** `calendar_sync_conflicts_link_id_fkey` — `FOREIGN KEY (link_id) REFERENCES integrations.calendar_event_links(id) ON DELETE CASCADE`

Indexes:

- `idx_calendar_conflicts_unresolved` — `integrations.calendar_sync_conflicts USING btree (connection_id, detected_at DESC) WHERE (resolved_at IS NULL)`

### `integrations.calendar_sync_settings`

14 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `connection_id` | uuid | no | — |
| `sync_direction` | varchar(20) | no | 'two_way'::character varying |
| `sync_tasks` | boolean | no | true |
| `sync_meetings` | boolean | no | true |
| `sync_milestones` | boolean | no | true |
| `sync_reminders` | boolean | no | true |
| `default_calendar` | varchar(20) | yes | 'google'::character varying |
| `time_zone` | varchar(64) | no | 'Asia/Kolkata'::character varying |
| `due_time_of_day` | varchar(5) | no | '09:00'::character varying |
| `conflict_policy` | varchar(20) | no | 'tracker_wins'::character varying |
| `project_scope` | uuid[] | yes | — |
| `created_at` | timestamptz | yes | now() |
| `updated_at` | timestamptz | yes | now() |

Constraints:

- **CHECK** `calendar_sync_settings_conflict_policy_check` — `CHECK (((conflict_policy)::text = ANY ((ARRAY['tracker_wins'::character varying, 'calendar_wins'::character varying, 'manual'::character varying])::text[])))`
- **CHECK** `calendar_sync_settings_sync_direction_check` — `CHECK (((sync_direction)::text = ANY ((ARRAY['two_way'::character varying, 'to_calendar'::character varying, 'from_calendar'::character varying])::text[])))`
- **FOREIGN KEY** `calendar_sync_settings_connection_id_fkey` — `FOREIGN KEY (connection_id) REFERENCES integrations.calendar_connections(id) ON DELETE CASCADE`
- **UNIQUE** `calendar_sync_settings_connection_key` — `UNIQUE (connection_id)`

### `integrations.teams_delivery_log`

12 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `webhook_id` | uuid | no | — |
| `event_type` | varchar(100) | yes | — |
| `card_kind` | varchar(40) | yes | — |
| `status` | varchar(16) | no | 'pending'::character varying |
| `http_status` | integer | yes | — |
| `attempts` | integer | no | 0 |
| `next_attempt_at` | timestamptz | yes | — |
| `payload` | jsonb | yes | — |
| `error` | text | yes | — |
| `created_at` | timestamptz | yes | now() |
| `updated_at` | timestamptz | yes | now() |

Constraints:

- **CHECK** `teams_delivery_log_status_check` — `CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'sent'::character varying, 'failed'::character varying, 'exhausted'::character varying, 'dropped'::character varying])::text[])))`
- **FOREIGN KEY** `teams_delivery_log_webhook_id_fkey` — `FOREIGN KEY (webhook_id) REFERENCES integrations.teams_webhooks(id) ON DELETE CASCADE`

Indexes:

- `idx_teams_delivery_due` — `integrations.teams_delivery_log USING btree (next_attempt_at) WHERE ((status)::text = 'pending'::text)`
- `idx_teams_delivery_webhook_created` — `integrations.teams_delivery_log USING btree (webhook_id, created_at DESC)`

### `integrations.teams_webhooks`

15 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `project_id` | uuid | yes | — |
| `name` | varchar(120) | yes | — |
| `webhook_url` | text | no | — |
| `url_hint` | varchar(255) | no | — |
| `event_types` | text[] | no | ARRAY['task_assigned'::text, 'task_… |
| `enabled` | boolean | no | true |
| `summary_digest` | varchar(20) | no | 'off'::character varying |
| `failure_count` | integer | no | 0 |
| `disabled_reason` | text | yes | — |
| `last_success_at` | timestamptz | yes | — |
| `last_failure_at` | timestamptz | yes | — |
| `created_by` | uuid | yes | — |
| `created_at` | timestamptz | yes | now() |
| `updated_at` | timestamptz | yes | now() |

Constraints:

- **CHECK** `teams_webhooks_summary_digest_check` — `CHECK (((summary_digest)::text = ANY ((ARRAY['off'::character varying, 'daily'::character varying, 'weekly'::character varying])::text[])))`
- **UNIQUE** `teams_webhooks_project_hint_key` — `UNIQUE (project_id, url_hint)`

Indexes:

- `idx_teams_webhooks_project_enabled` — `integrations.teams_webhooks USING btree (project_id) WHERE (enabled = true)`

---

## `files`

### `files.documents`

12 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `name` | varchar(500) | no | — |
| `original_name` | varchar(500) | yes | — |
| `file_type` | varchar(50) | yes | — |
| `file_size` | bigint | yes | — |
| `url` | varchar(1000) | yes | — |
| `description` | text | yes | — |
| `project_id` | uuid | yes | — |
| `uploaded_by` | uuid | yes | — |
| `created_at` | timestamp | yes | now() |
| `cloudinary_public_id` | varchar(255) | yes | — |
| `folder_id` | uuid | yes | — |

Constraints:

- **FOREIGN KEY** `documents_folder_id_fkey` — `FOREIGN KEY (folder_id) REFERENCES files.folders(id) ON DELETE SET NULL`

Indexes:

- `idx_documents_folder` — `files.documents USING btree (folder_id)`
- `idx_documents_folder_id` — `files.documents USING btree (folder_id)`

### `files.folders`

5 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `name` | varchar(255) | no | — |
| `created_by` | uuid | yes | — |
| `created_at` | timestamp | yes | now() |
| `updated_at` | timestamp | yes | now() |

Constraints:

- **UNIQUE** `folders_name_unique` — `UNIQUE (name)`

---

## `workforce`

### `workforce.daily_work_status`

8 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `user_id` | uuid | no | — |
| `date` | date | no | — |
| `summary` | text | no | — |
| `blockers` | text | yes | — |
| `tomorrow_plan` | text | yes | — |
| `submitted_at` | timestamptz | no | now() |
| `updated_at` | timestamptz | no | now() |

Constraints:

- **UNIQUE** `daily_work_status_user_date_key` — `UNIQUE (user_id, date)`

Indexes:

- `idx_daily_work_status_date` — `workforce.daily_work_status USING btree (date)`

### `workforce.leave_balances`

9 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `user_id` | uuid | no | — |
| `year` | smallint | no | — |
| `leave_type` | varchar(30) | no | — |
| `entitled` | numeric(5,1) | no | 0 |
| `carried_forward` | numeric(5,1) | no | 0 |
| `updated_by` | uuid | yes | — |
| `created_at` | timestamptz | no | now() |
| `updated_at` | timestamptz | no | now() |

Constraints:

- **CHECK** `leave_balances_non_negative` — `CHECK (((entitled >= (0)::numeric) AND (carried_forward >= (0)::numeric)))`
- **UNIQUE** `leave_balances_user_year_type_key` — `UNIQUE (user_id, year, leave_type)`

### `workforce.leave_requests`

16 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `user_id` | uuid | yes | — |
| `start_date` | date | no | — |
| `end_date` | date | no | — |
| `days` | numeric(5,1) | no | 1 |
| `type` | varchar(30) | no | 'annual'::character varying |
| `reason` | text | no | — |
| `status` | varchar(20) | no | 'pending'::character varying |
| `created_at` | timestamp | yes | now() |
| `day_type` | varchar(10) | no | 'full_day'::character varying |
| `planning_type` | varchar(12) | no | 'planned'::character varying |
| `notice_days` | integer | yes | — |
| `is_late_notice` | boolean | no | false |
| `approver_id` | uuid | yes | — |
| `approved_at` | timestamptz | yes | — |
| `cancelled_at` | timestamptz | yes | — |

Constraints:

- **CHECK** `leave_requests_day_type_check` — `CHECK (((day_type)::text = ANY ((ARRAY['full_day'::character varying, 'half_day'::character varying])::text[])))`
- **CHECK** `leave_requests_planning_type_check` — `CHECK (((planning_type)::text = ANY ((ARRAY['planned'::character varying, 'unplanned'::character varying])::text[])))`
- **CHECK** `leave_requests_status_check` — `CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'approved'::character varying, 'rejected'::character varying, 'cancelled'::character varying])::text[])))`

Indexes:

- `idx_leave_requests_dates` — `workforce.leave_requests USING btree (start_date, end_date)`
- `idx_leave_requests_status` — `workforce.leave_requests USING btree (status)`
- `idx_leave_requests_user_start` — `workforce.leave_requests USING btree (user_id, start_date DESC)`

### `workforce.time_logs`

10 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `user_id` | uuid | yes | — |
| `project_id` | uuid | yes | — |
| `date` | date | no | — |
| `hours` | numeric(5,2) | no | 0 |
| `note` | text | yes | — |
| `check_in` | timestamp | yes | — |
| `check_out` | timestamp | yes | — |
| `created_at` | timestamp | yes | now() |
| `attendance_status` | varchar(16) | yes | — |

Constraints:

- **CHECK** `time_logs_attendance_status_check` — `CHECK (((attendance_status)::text = ANY ((ARRAY['present'::character varying, 'wfh'::character varying, 'half_day'::character varying, 'on_leave'::character varying, 'absent'::character varying])::text[])))`

Indexes:

- `idx_time_logs_project` — `workforce.time_logs USING btree (project_id)`
- `idx_time_logs_user_date` — `workforce.time_logs USING btree (user_id, date DESC)`

---

## `people`

### `people.candidate_resumes`

8 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `candidate_id` | uuid | no | — |
| `file_name` | varchar(255) | no | — |
| `file_type` | varchar(20) | yes | — |
| `file_size` | bigint | yes | — |
| `storage_path` | varchar(500) | no | — |
| `uploaded_by` | uuid | yes | — |
| `created_at` | timestamptz | no | now() |

Constraints:

- **FOREIGN KEY** `candidate_resumes_candidate_id_fkey` — `FOREIGN KEY (candidate_id) REFERENCES people.candidates(id) ON DELETE CASCADE`

Indexes:

- `idx_candidate_resumes_candidate` — `people.candidate_resumes USING btree (candidate_id)`

### `people.candidates`

17 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `full_name` | varchar(160) | no | — |
| `applied_for` | varchar(120) | no | — |
| `status` | varchar(24) | no | 'applied'::character varying |
| `created_by` | uuid | yes | — |
| `created_at` | timestamptz | no | now() |
| `updated_at` | timestamptz | no | now() |
| `email` | varchar(255) | yes | — |
| `phone` | varchar(20) | yes | — |
| `source` | varchar(30) | yes | — |
| `product` | varchar(120) | yes | — |
| `current_company` | varchar(200) | yes | — |
| `total_experience_months` | integer | yes | — |
| `notice_period_days` | integer | yes | — |
| `expected_shift` | varchar(60) | yes | — |
| `notes` | text | yes | — |
| `converted_user_id` | uuid | yes | — |

Constraints:

- **CHECK** `candidates_source_check` — `CHECK (((source)::text = ANY ((ARRAY['referral'::character varying, 'naukri'::character varying, 'linkedin'::character varying, 'walk_in'::character varying, 'campus'::character varying, 'other'::character varying])::text[])))`
- **CHECK** `candidates_status_check` — `CHECK (((status)::text = ANY ((ARRAY['applied'::character varying, 'screening'::character varying, 'interview_scheduled'::character varying, 'interviewed'::character varying, 'selected'::character varying, 'hold'::character varying, 'rejected'::character varying, 'offered'::character varying, 'joined'::character varying, 'declined'::character varying])::text[])))`

Indexes:

- `idx_candidates_email` — `people.candidates USING btree (email)`
- `idx_candidates_status` — `people.candidates USING btree (status)`

### `people.employee_exits`

14 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `user_id` | uuid | no | — |
| `exit_type` | varchar(20) | no | 'resignation'::character varying |
| `designation` | varchar(120) | yes | — |
| `product` | varchar(120) | yes | — |
| `resignation_date` | date | no | — |
| `last_working_date` | date | no | — |
| `reason_category` | varchar(40) | no | — |
| `reason_detail` | text | yes | — |
| `exit_feedback` | text | yes | — |
| `tenure_months` | integer | yes | — |
| `recorded_by` | uuid | yes | — |
| `created_at` | timestamptz | no | now() |
| `updated_at` | timestamptz | no | now() |

Constraints:

- **CHECK** `employee_exits_dates_order` — `CHECK ((last_working_date >= resignation_date))`
- **CHECK** `employee_exits_exit_type_check` — `CHECK (((exit_type)::text = ANY ((ARRAY['resignation'::character varying, 'termination'::character varying, 'absconded'::character varying, 'contract_end'::character varying])::text[])))`
- **CHECK** `employee_exits_reason_category_check` — `CHECK (((reason_category)::text = ANY ((ARRAY['better_opportunity'::character varying, 'compensation'::character varying, 'relocation'::character varying, 'higher_studies'::character varying, 'personal'::character varying, 'health'::character varying, 'work_environment'::character varying, 'performance'::character varying, 'other'::character varying])::text[])))`

Indexes:

- `idx_employee_exits_reason` — `people.employee_exits USING btree (reason_category)`
- `idx_employee_exits_resignation_date` — `people.employee_exits USING btree (resignation_date DESC)`
- `idx_employee_exits_user` — `people.employee_exits USING btree (user_id)`

### `people.employee_profiles`

26 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `user_id` | uuid | no | — |
| `date_of_joining` | date | yes | — |
| `designation` | varchar(120) | no | — |
| `shift` | varchar(60) | yes | — |
| `product` | varchar(120) | yes | — |
| `core_skills` | text[] | no | '{}'::text[] |
| `created_by` | uuid | yes | — |
| `created_at` | timestamptz | no | now() |
| `updated_at` | timestamptz | no | now() |
| `employee_code` | varchar(30) | yes | — |
| `gender` | varchar(20) | yes | — |
| `date_of_birth` | date | yes | — |
| `marital_status` | varchar(20) | yes | — |
| `guardian_name` | varchar(160) | yes | — |
| `temporary_address` | text | yes | — |
| `permanent_address` | text | yes | — |
| `aadhaar_encrypted` | text | yes | — |
| `aadhaar_last4` | char(4) | yes | — |
| `education_qualification` | varchar(160) | yes | — |
| `college_name` | varchar(200) | yes | — |
| `year_of_completion` | smallint | yes | — |
| `previous_company` | varchar(200) | yes | — |
| `total_experience_months` | integer | yes | — |
| `reporting_manager_id` | uuid | yes | — |
| `updated_by` | uuid | yes | — |

Constraints:

- **CHECK** `employee_profiles_aadhaar_pair` — `CHECK (((aadhaar_encrypted IS NULL) = (aadhaar_last4 IS NULL)))`
- **CHECK** `employee_profiles_gender_check` — `CHECK (((gender)::text = ANY ((ARRAY['male'::character varying, 'female'::character varying, 'other'::character varying, 'undisclosed'::character varying])::text[])))`
- **CHECK** `employee_profiles_marital_status_check` — `CHECK (((marital_status)::text = ANY ((ARRAY['single'::character varying, 'married'::character varying, 'other'::character varying, 'undisclosed'::character varying])::text[])))`
- **UNIQUE** `employee_profiles_employee_code_key` — `UNIQUE (employee_code)`
- **UNIQUE** `employee_profiles_user_id_key` — `UNIQUE (user_id)`

Indexes:

- `idx_employee_profiles_doj` — `people.employee_profiles USING btree (date_of_joining)`
- `idx_employee_profiles_manager` — `people.employee_profiles USING btree (reporting_manager_id)`

### `people.interviews`

16 columns

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` 🔑 | uuid | no | gen_random_uuid() |
| `candidate_id` | uuid | no | — |
| `round_number` | smallint | no | 1 |
| `interview_date` | date | no | — |
| `outcome` | varchar(20) | yes | — |
| `not_selected_reason` | text | yes | — |
| `feedback` | text | yes | — |
| `candidate_expectations` | text | yes | — |
| `created_by` | uuid | yes | — |
| `created_at` | timestamptz | no | now() |
| `updated_at` | timestamptz | no | now() |
| `interview_type` | varchar(24) | yes | — |
| `start_time` | time | yes | — |
| `interviewer_id` | uuid | yes | — |
| `status` | varchar(20) | no | 'scheduled'::character varying |
| `rating` | smallint | yes | — |

Constraints:

- **CHECK** `interviews_interview_type_check` — `CHECK (((interview_type)::text = ANY ((ARRAY['telephonic'::character varying, 'technical'::character varying, 'hr'::character varying, 'managerial'::character varying, 'final'::character varying])::text[])))`
- **CHECK** `interviews_outcome_check` — `CHECK (((outcome)::text = ANY ((ARRAY['selected'::character varying, 'hold'::character varying, 'rejected'::character varying, 'next_round'::character varying])::text[])))`
- **CHECK** `interviews_rating_check` — `CHECK (((rating >= 1) AND (rating <= 5)))`
- **CHECK** `interviews_status_check` — `CHECK (((status)::text = ANY ((ARRAY['scheduled'::character varying, 'completed'::character varying, 'no_show'::character varying, 'cancelled'::character varying])::text[])))`
- **FOREIGN KEY** `interviews_candidate_id_fkey` — `FOREIGN KEY (candidate_id) REFERENCES people.candidates(id) ON DELETE CASCADE`

Indexes:

- `idx_interviews_candidate` — `people.interviews USING btree (candidate_id)`
- `idx_interviews_date` — `people.interviews USING btree (interview_date DESC)`
- `idx_interviews_interviewer` — `people.interviews USING btree (interviewer_id)`
- `idx_interviews_status` — `people.interviews USING btree (status)`

---

## `public` — not on any search_path

`public` was removed from every pool's `search_path` on 2026-10-05, after a pre-split deployment ran the
legacy provisioner and left empty copies of the module tables here — at which point a stray cross-module
query resolved against an empty shadow instead of raising. Nothing in this schema is visible to the
application.

**Listed by name only, on purpose.** Expanding a shadow would print a second, plausible-looking definition
of nearly every table in the system, and a reader could lift columns from one without ever knowing.

Legacy Prisma-era tables — expected, untouched, on the leave-list in `migrate-schema-split.js`: **7** (`ActivityLog`, `Document`, `Project`, `ProjectMember`, `Task`, `User`, `_prisma_migrations`).

> **29 table(s) in `public` that nothing should have created.**
>
> `bug_activity_logs`, `bug_attachments`, `bug_comments`, `bug_sla_rules`, `bugs`, `calendar_connections`, `calendar_event_links`, `calendar_sync_conflicts`, `calendar_sync_settings`, `comments`, `documents`, `folders`, `leave_requests`, `notification_action_log`, `notification_logs`, `notification_preferences`, `notification_snoozes`, `notifications`, `project_members`, `projects`, `push_delivery_retries`, `push_subscriptions`, `tasks`, `teams_delivery_log`, `teams_webhooks`, `time_logs`, `user_sessions`, `user_tokens`, `users`
>
> Each one means some process wrote to `public`. This is the tripwire the production verification
> scripts check — see `docs/production-verify.sql`. On dev these are the 29 shadows from 2026-10-05;
> `npm run test:isolation` reports them as warnings on every run.

---

## Schemas this backend does not own

Platform schemas belonging to the hosting provider, plus the extension sandbox. No migration in this
repository touches any of them, and `extensions` is the only one on a pool's `search_path`.

| Schema | Tables |
| --- | --- |
| `auth` | 27 |
| `extensions` | 0 |
| `graphql` | 0 |
| `graphql_public` | 0 |
| `pgbouncer` | 0 |
| `realtime` | 2 |
| `storage` | 8 |
| `vault` | 1 |

---

Generated by `scripts/gen-schema-doc.js`. See `migrations/README.md` for how migrations are organised and
`docs/ARCHITECTURE.md` for where each module lives.
