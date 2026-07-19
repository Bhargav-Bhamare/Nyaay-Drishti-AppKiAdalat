const bcrypt = require("bcrypt");
const tempUsers = require("../data/tempusers");
const redirectByRole = require("../utils/redirectRole");

exports.getLogin = (req, res) => {
  res.render("auth/login");
};

exports.getSignup = (req, res) => {
  res.render("auth/signup");
};

exports.login = async (req, res) => {
  const { email, password } = req.body;

  // Determine which login page to render on failure based on role hint
  // The judge and court master forms both POST here; use a hidden field to know which view to re-render
  const fromView = req.body.fromView || 'judge'; // 'judge' | 'cmaster'
  const errorView = fromView === 'cmaster' ? 'auth/cMasterLogin' : 'auth/judgeLogin';
  const errorLocals = { error: ['Invalid credentials. Please try again.'] };
  const normalizedEmail = email ? email.toLowerCase().trim() : '';

  if (!email || !password) {
    return res.render(errorView, errorLocals);
  }

  try {
    const user = tempUsers.find((u) => u.email === normalizedEmail);
    if (!user) {
      return res.render(errorView, errorLocals);
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.render(errorView, errorLocals);
    }

    req.session.user = {
      id: user.id,
      name: user.name,
      role: user.role,
    };

    redirectByRole(user.role, res);
  } catch (err) {
    console.error('authController login error:', err);
    return res.render(errorView, errorLocals);
  }
};

exports.logout = (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
};
