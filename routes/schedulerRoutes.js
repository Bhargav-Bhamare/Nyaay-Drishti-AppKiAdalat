'use strict';

/**
 * routes/schedulerRoutes.js
 *
 * Mounted at: /api/scheduler
 *
 * All routes are protected by the existing isAuth middleware.
 * Role-gating is applied per endpoint:
 *   - evaluate       : JUDGE, COURTMASTER (read scheduling data for one case)
 *   - evaluate-batch : JUDGE, COURTMASTER (generate the full daily cause list)
 */

const express   = require('express');
const router    = express.Router();
const isAuth    = require('../middlewares/isAuth');
const checkRole = require('../middlewares/checkRole');
const {
  evaluateCase,
  evaluateBatch,
} = require('../controllers/schedulerController');

// POST /api/scheduler/evaluate
// Accepts a single case JSON body and returns AI + rule-based scheduling metadata
router.post(
  '/evaluate',
  isAuth,
  checkRole('JUDGE', 'COURTMASTER'),
  evaluateCase,
);

// POST /api/scheduler/evaluate-batch
// Accepts { cases: [...] } or empty body (pulls from DB) → returns sorted cause list
router.post(
  '/evaluate-batch',
  isAuth,
  checkRole('JUDGE', 'COURTMASTER'),
  evaluateBatch,
);

module.exports = router;
