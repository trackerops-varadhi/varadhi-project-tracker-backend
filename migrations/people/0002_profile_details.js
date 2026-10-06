/*
 * people — 0002 profile details
 * ---------------------------------------------------------------------------
 * The rest of the spreadsheet's "Employee Details" column on employee_profiles
 * (docs/Module-9-People-Plan.md §2.2): personal, identity, education and
 * experience fields, plus reporting_manager_id, which powers the Team
 * Directory and work-status escalation.
 *
 * Every column is nullable, so existing profiles stay valid and HR fills them
 * in over time.
 *
 * AADHAAR is never stored in plaintext: aadhaar_encrypted holds AES-256-GCM
 * ciphertext (platform/crypto, PII_ENCRYPTION_KEY) and aadhaar_last4 the four
 * digits shown masked. "Age" is not a column — it is derived from
 * date_of_birth on read, because a stored age goes stale silently.
 */

exports.shorthands = undefined

const T = { schema: 'people', name: 'employee_profiles' }

exports.up = (pgm) => {
  pgm.addColumns(T, {
    employee_code: { type: 'varchar(30)', unique: true },
    gender: {
      type: 'varchar(20)',
      check: "gender IN ('male','female','other','undisclosed')",
    },
    date_of_birth: { type: 'date' },
    marital_status: {
      type: 'varchar(20)',
      check: "marital_status IN ('single','married','other','undisclosed')",
    },
    // "Husband / Father name" on the sheet.
    guardian_name: { type: 'varchar(160)' },
    temporary_address: { type: 'text' },
    permanent_address: { type: 'text' },
    aadhaar_encrypted: { type: 'text' },
    aadhaar_last4: { type: 'char(4)' },
    education_qualification: { type: 'varchar(160)' },
    college_name: { type: 'varchar(200)' },
    year_of_completion: { type: 'smallint' },
    previous_company: { type: 'varchar(200)' },
    // Experience before joining, in months; rendered "3y 2m".
    total_experience_months: { type: 'integer' },
    // Bare uuid → identity.users. No cross-module FK.
    reporting_manager_id: { type: 'uuid' },
    updated_by: { type: 'uuid' },
  })
  pgm.addConstraint(T, 'employee_profiles_aadhaar_pair',
    'CHECK ((aadhaar_encrypted IS NULL) = (aadhaar_last4 IS NULL))')
  pgm.createIndex(T, 'reporting_manager_id', { name: 'idx_employee_profiles_manager' })
}

exports.down = (pgm) => {
  pgm.dropIndex(T, 'reporting_manager_id', { name: 'idx_employee_profiles_manager' })
  pgm.dropConstraint(T, 'employee_profiles_aadhaar_pair')
  pgm.dropColumns(T, [
    'employee_code', 'gender', 'date_of_birth', 'marital_status', 'guardian_name',
    'temporary_address', 'permanent_address', 'aadhaar_encrypted', 'aadhaar_last4',
    'education_qualification', 'college_name', 'year_of_completion', 'previous_company',
    'total_experience_months', 'reporting_manager_id', 'updated_by',
  ])
}
