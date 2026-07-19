const Lawyer = require("../model/lawyer.js");

module.exports.renderSignUp = (req,res) =>{
    res.render("auth/signup.ejs");
}

module.exports.registerLawyer = async (req, res, next) => {
  try {
    let { username, email, password, BarCouncilRegistrationNumber, mobile } = req.body;
    const normalizedEmail = String(email || '').toLowerCase().trim();
    const normalizedBarReg = Number(BarCouncilRegistrationNumber);

    if (!username || !normalizedEmail || !password || !normalizedBarReg) {
      req.flash('error', 'Please fill in all required fields.');
      return res.redirect('/signup');
    }

    const existing = await Lawyer.findOne({ email: normalizedEmail });
    if (existing) {
      req.flash('error', 'An advocate account already exists with this email.');
      return res.redirect('/signup');
    }

    const newUser = new Lawyer({
      email: normalizedEmail,
      username,
      mobile,
      BarCouncilRegistrationNumber: normalizedBarReg
    });

    const registeredUser = await Lawyer.register(newUser, password);
    console.log('[registerLawyer] registered user', registeredUser && registeredUser.email, registeredUser && registeredUser.username);
    req.login(registeredUser, (err) => {
      if (err) {
        console.error('[registerLawyer] Login after register failed:', err);
        req.flash('warning', 'Registered successfully but automatic login failed. Please login manually.');
        return res.redirect('/login');
      }

      console.log('[registerLawyer] login callback success for', registeredUser && registeredUser.email);
      req.flash('success', 'User registered successfully');
      return res.redirect('/lawyerDashboard');
    });
  } catch (e) {
    console.error('registerLawyer error:', e);
    req.flash('error', e.message || 'Unable to create advocate account.');
    res.redirect('/signup');
  }
};

module.exports.renderLogin = (req, res) => {
  res.render("auth/login.ejs");
};

module.exports.login = async (req, res) => {
  try {
    // req.user is populated by passport after successful authentication
    const lawyer = await Lawyer.findById(req.user._id);
    
    if (!lawyer) {
      req.flash("error", "Lawyer account not found. Please sign up first.");
      return res.redirect("/signup");
    }

    // Check if lawyer account is still active and valid
    if (!lawyer.email || !lawyer.BarCouncilRegistrationNumber) {
      req.flash("error", "Incomplete lawyer profile. Please update your profile.");
      return res.redirect("/profile");
    }

    req.flash("success", `Logged in successfully as ${lawyer.username}`);
    res.redirect("/lawyerDashboard");
  } catch (err) {
    console.error('Login error:', err);
    req.flash("error", "An error occurred during login");
    res.redirect("/login");
  }
};

module.exports.logout = (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.flash("success", "Logged out successfully");
    res.redirect("/");
  });
};
