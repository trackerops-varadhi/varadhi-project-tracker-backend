/**
 * Which service owns which module schema.
 * ---------------------------------------------------------------------------
 *
 * ONE DEFINITION, TWO READERS
 * `platform/db.js` uses it to pick the credential a module's pool connects
 * with, and `scripts/gen-db-roles.js` uses it to generate that role's grants.
 * Written twice, the two would disagree eventually, and the symptom would be a
 * permission error in production rather than a failing check.
 *
 * WHY FIVE, NOT NINE
 * Measured from the dependency graph, not chosen (`npm run modules:graph`):
 *
 *   core          identity <-> notify <-> work is the remaining dependency
 *                 cycle — mutually reachable, so they cannot be separated.
 *                 `insights` belongs here too but owns no schema: it aggregates
 *                 core's data through its siblings' interfaces and never opens
 *                 a pool, which is why it does not appear below.
 *   hr            people -> workforce only, and workforce's single inbound edge
 *                 is people. Splitting them buys a network hop per HR screen.
 *   defects       zero inbound edges.
 *   files         inbound from defects and hr only.
 *   integrations  zero inbound, and slow outbound I/O to Google/Microsoft/Teams.
 *
 * See docs/MICROSERVICES-TARGET.md for the whole target shape.
 *
 * THIS IS USEFUL TODAY, AS A MONOLITH
 * One process runs all nine modules, so it holds every credential — but each
 * POOL is confined to its own service's schemas. The `work` pool cannot read a
 * `people` table even if code asked it to: that is `42501 permission denied`
 * from Postgres rather than a convention tested by `npm run test:isolation`.
 * After an extraction the same map means each service is given only its own
 * credential, and nothing else changes.
 */

/** service -> the module schemas it owns. */
const SERVICES = Object.freeze({
  core: Object.freeze(['identity', 'notify', 'work']),
  hr: Object.freeze(['people', 'workforce']),
  defects: Object.freeze(['defects']),
  files: Object.freeze(['files']),
  integrations: Object.freeze(['integrations']),
})

const SERVICE_NAMES = Object.freeze(Object.keys(SERVICES))

/** Every schema any service owns, in service order. */
const ALL_SCHEMAS = Object.freeze(SERVICE_NAMES.flatMap((s) => [...SERVICES[s]]))

const schemaToService = new Map(
  SERVICE_NAMES.flatMap((service) => SERVICES[service].map((schema) => [schema, service]))
)

/**
 * The service that owns a schema, or null.
 * Null rather than a throw: db.js falls back to the shared credential, which is
 * what keeps a new schema working before anyone has given it a role.
 */
const serviceOf = (schema) => schemaToService.get(schema) || null

/**
 * The env var holding one service's connection string.
 * `DATABASE_URL_CORE`, `DATABASE_URL_HR`, ... — absent means "use DATABASE_URL",
 * so adding this file changed nothing until the variables exist.
 */
const envVarFor = (service) => `DATABASE_URL_${String(service).toUpperCase()}`

/** The Postgres role name for a service. Matches gen-db-roles.js exactly. */
const roleFor = (service) => `svc_${service}`

module.exports = { SERVICES, SERVICE_NAMES, ALL_SCHEMAS, serviceOf, envVarFor, roleFor }
