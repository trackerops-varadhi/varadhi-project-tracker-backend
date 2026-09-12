// Supabase client — object storage only.
//
// Platform-level for the same reason as db.js: it is a shared infrastructure
// client, not domain logic. Two modules use it (files, and defects for bug
// attachments), and both go through their own storage helper rather than
// touching this directly.
//
// Despite the historical filename this project has never used Cloudinary in a
// live code path; the dead config that used to sit here has been removed rather
// than carried forward again. `cloudinary` is not a dependency.
//
// NOTE: this uses the SERVICE ROLE key, which bypasses row-level security
// entirely. Nothing here may ever be reached from user-supplied input without
// the caller having already authorised the action.
//
// Only Storage is used — there are no `supabase.from(...)` queries anywhere.
// All relational data goes through platform/db.js.

const { createClient } = require('@supabase/supabase-js')
const WebSocket = require('ws')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    realtime: {
      transport: WebSocket,
    },
  }
)

module.exports = supabase
