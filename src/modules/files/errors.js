// Shared error type for the files module. Carries the HTTP status the caller
// should see; anything without one is a genuine fault and becomes a 500.
class FilesError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

module.exports = { FilesError }
