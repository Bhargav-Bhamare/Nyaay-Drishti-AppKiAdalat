const express = require("express");
const router = express.Router();
const isAuth = require("../middlewares/isAuth");
const checkRole = require("../middlewares/checkRole");
const dashboardController = require("../controllers/dashboardController");

router.get(
  "/judge/dashboard",
  isAuth,
  checkRole("JUDGE"),
  (req, res) => {
    res.render("judge/judgeDash");
  }
);

router.get(
  "/lawyer/dashboard",
  isAuth,
  checkRole("LAWYER"),
  (req, res) => {
    res.render("lawyer/lawyerDash");
  }
);

router.get(
  "/courtmaster/dashboard",
  isAuth,
  checkRole("COURTMASTER"),
  (req, res) => {
    res.render("cMaster/cMasterDash");
  }
);

// ── Daily Cause List ──────────────────────────────────────────────────────────
// ?availableMinutes=300  (default 300 min = 5 hours)
// ?aiEnhanced=true       (opt-in LLM augmentation)
router.get(
  "/api/dashboard/daily-cause-list",
  isAuth,
  checkRole("JUDGE", "COURTMASTER"),
  dashboardController.getDailyCauseList
);

// ── Case Priority Detail (modal / detail view) ────────────────────────────────
router.get(
  "/api/dashboard/case-priority/:caseId",
  isAuth,
  checkRole("JUDGE", "COURTMASTER"),
  dashboardController.getCasePriorityDetails
);

// ── Lawyer-facing endpoints ───────────────────────────────────────────────────
router.get(
  "/api/dashboard/lawyer",
  isAuth,
  checkRole("LAWYER"),
  dashboardController.getLawyerDashboardData
);

router.get(
  "/api/dashboard/lawyer/cases",
  isAuth,
  checkRole("LAWYER"),
  dashboardController.getLawyerCases
);

router.get(
  "/api/dashboard/lawyer/notifications",
  isAuth,
  checkRole("LAWYER"),
  dashboardController.getNotifications
);

router.get(
  "/api/dashboard/lawyer/defects",
  isAuth,
  checkRole("LAWYER"),
  dashboardController.getDefects
);

router.post(
  "/api/dashboard/lawyer/file-case",
  isAuth,
  checkRole("LAWYER"),
  dashboardController.fileNewCase
);

router.put(
  "/api/dashboard/lawyer/profile",
  isAuth,
  checkRole("LAWYER"),
  dashboardController.updateLawyerProfile
);

module.exports = router;
