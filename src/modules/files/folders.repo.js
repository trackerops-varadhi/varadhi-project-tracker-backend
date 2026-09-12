// SQL for folders. This module owns the table.
//
// The `LEFT JOIN documents` in listFolders is kept: files owns both tables, so
// that join is within the module boundary and survives a schema split intact.
// The `LEFT JOIN users` that used to supply created_by_name is gone — that was
// lookup-only and is now identity.getUserCards().

const pool = require('../../platform/db').forSchema('files')

exports.listFolders = async () => {
  const { rows } = await pool.query(`
    SELECT f.id, f.name, f.created_at, f.created_by,
           COUNT(d.id)::int AS documents_count
      FROM folders f
      LEFT JOIN documents d ON d.folder_id = f.id
     GROUP BY f.id, f.name, f.created_at, f.created_by
     ORDER BY f.name ASC
  `)
  return rows
}

exports.folderExists = async (id) => {
  const { rows } = await pool.query('SELECT id FROM folders WHERE id = $1', [id])
  return Boolean(rows[0])
}

// Case-insensitive name collision check. `excludeId` lets rename skip the row
// being renamed, so saving a folder under its own name is not a conflict.
exports.findByName = async (name, excludeId = null) => {
  const { rows } = excludeId
    ? await pool.query(
        'SELECT id FROM folders WHERE LOWER(name) = LOWER($1) AND id != $2',
        [name, excludeId]
      )
    : await pool.query('SELECT id FROM folders WHERE LOWER(name) = LOWER($1)', [name])
  return rows[0] || null
}

exports.insertFolder = async ({ name, createdBy }) => {
  const { rows } = await pool.query(
    `INSERT INTO folders (name, created_by) VALUES ($1, $2)
     RETURNING id, name, created_at`,
    [name, createdBy]
  )
  return rows[0]
}

exports.renameFolder = async (id, name) => {
  const { rows } = await pool.query(
    `UPDATE folders SET name = $1, updated_at = NOW() WHERE id = $2
     RETURNING id, name`,
    [name, id]
  )
  return rows[0] || null
}

// Documents are NOT deleted with the folder — documents.folder_id is
// ON DELETE SET NULL, so they become unfiled rather than lost.
exports.deleteFolder = async (id) => {
  const { rows } = await pool.query('DELETE FROM folders WHERE id = $1 RETURNING id', [id])
  return rows[0] || null
}
