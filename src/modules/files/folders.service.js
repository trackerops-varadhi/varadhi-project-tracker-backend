// Folder business logic: name validation, collision checks, display enrichment.

const repo = require('./folders.repo')
const identity = require('../identity')
const { FilesError } = require('./errors')

exports.list = async () => {
  const rows = await repo.listFolders()

  // One batched identity call for the page, replacing the LEFT JOIN users that
  // supplied created_by_name.
  const cards = await identity.getUserCards(rows.map((r) => r.created_by))

  return rows.map((f) => ({
    id: f.id,
    name: f.name,
    createdAt: f.created_at,
    // Legacy shape: a bare name string (or null), not a user object.
    createdBy: cards.get(f.created_by)?.name || null,
    documentsCount: f.documents_count,
  }))
}

const requireName = (name) => {
  if (!name || !String(name).trim()) throw new FilesError('Folder name is required.')
  return String(name).trim()
}

exports.create = async (currentUser, { name }) => {
  const trimmed = requireName(name)

  if (await repo.findByName(trimmed)) {
    throw new FilesError('A folder with this name already exists.')
  }

  const f = await repo.insertFolder({ name: trimmed, createdBy: currentUser.id })
  return { id: f.id, name: f.name, createdAt: f.created_at, documentsCount: 0 }
}

exports.rename = async (id, { name }) => {
  const trimmed = requireName(name)

  if (await repo.findByName(trimmed, id)) {
    throw new FilesError('A folder with this name already exists.')
  }

  const row = await repo.renameFolder(id, trimmed)
  if (!row) throw new FilesError('Folder not found.', 404)

  // Legacy shape: the raw { id, name } row, deliberately not camelCased and
  // deliberately without createdAt/documentsCount. The Documents page reads
  // only these two fields back after a rename.
  return row
}

exports.remove = async (id) => {
  const row = await repo.deleteFolder(id)
  if (!row) throw new FilesError('Folder not found.', 404)
  // Documents are kept: documents.folder_id is ON DELETE SET NULL, so they
  // become unfiled rather than being deleted with the folder.
  return { id }
}
