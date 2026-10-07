// /api/people — employee directory, own profile, team directory, dashboard.
// Gates follow docs/Module-9-People-Plan.md §3.2 and §4.4. Static paths are
// declared before any /:userId path.

const router = require('express').Router()
const { protect, restrictTo } = require('../../middleware/auth.middleware')
const { handler } = require('./http')
const service = require('./employees.service')
const dashboard = require('./dashboard.service')

const HR = ['admin', 'hr']
const HR_AND_MANAGERS = ['admin', 'manager', 'hr']

router.use(protect)

router.get('/dashboard', restrictTo(...HR_AND_MANAGERS),
  handler(() => dashboard.getDashboard(), { where: 'dashboard', fallback: 'Failed to load HR dashboard.' }))

// Role workspaces: the Team Directory is part of the HR workspace (and
// admin's), not the manager or employee ones. Still PII-free by construction
// (employees.service#getTeamDirectory).
router.get('/team', restrictTo(...HR),
  handler(() => service.getTeamDirectory(), { where: 'team', fallback: 'Failed to load the team directory.' }))

router.get('/me',
  handler((req) => service.getMe(req.user), { where: 'getMe', fallback: 'Failed to load your profile.' }))
// Any authenticated user — their own two addresses, nothing else.
router.patch('/me',
  handler((req) => service.updateMyAddresses(req.user, req.body),
    { where: 'updateMe', fallback: 'Failed to update your profile.', message: 'Profile updated.' }))

router.get('/products', restrictTo(...HR_AND_MANAGERS),
  handler(() => service.listProducts(), { where: 'products', fallback: 'Failed to load products.' }))

// The list is the PII-free summary DTO, which is why managers may read it.
router.get('/employees', restrictTo(...HR_AND_MANAGERS),
  handler((req) => service.listEmployees(req.query), { where: 'listEmployees', fallback: 'Failed to load employees.' }))
router.get('/employees/eligible-users', restrictTo(...HR),
  handler(() => service.listEligibleUsers(), { where: 'eligibleUsers', fallback: 'Failed to load users.' }))
router.post('/employees', restrictTo(...HR),
  handler((req) => service.createEmployee(req.user, req.body),
    { where: 'createEmployee', fallback: 'Failed to add employee.', status: 201, message: 'Employee added successfully.' }))

// admin/hr, or the person themselves — enforced in the service.
router.get('/employees/:userId',
  handler((req) => service.getEmployee(req.user, req.params.userId), { where: 'getEmployee', fallback: 'Failed to load employee.' }))
router.put('/employees/:userId', restrictTo(...HR),
  handler((req) => service.updateEmployee(req.user, req.params.userId, req.body),
    { where: 'updateEmployee', fallback: 'Failed to update employee.', message: 'Employee updated.' }))
router.get('/employees/:userId/aadhaar', restrictTo(...HR),
  handler((req) => service.revealAadhaar(req.user, req.params.userId), { where: 'revealAadhaar', fallback: 'Failed to load Aadhaar.' }))

module.exports = router
