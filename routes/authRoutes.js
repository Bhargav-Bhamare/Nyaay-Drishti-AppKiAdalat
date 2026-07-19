const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");

// Lawyer login (GET only — POST is handled by passport in routes/lawyer.js)
router.get("/login", authController.getLogin);

// Judge / Court Master session-based login
// Mounted at /judicial-login to avoid conflicting with passport's POST /login
router.get("/judgeLogin",    (req, res) => res.render("auth/judgeLogin",  { error: [] }));
router.get("/cMasterLogin",  (req, res) => res.render("auth/cMasterLogin", { error: [] }));
router.post("/judicial-login", authController.login);

router.get("/signup", authController.getSignup);

router.post("/logout", authController.logout);

module.exports = router;
