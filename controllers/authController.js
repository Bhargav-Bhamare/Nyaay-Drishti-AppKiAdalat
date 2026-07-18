const bcrypt = require("bcrypt");
const users = require("../data/tempusers");
const redirectByRole = require("../utils/redirectRole");

exports.getLogin = (req, res) => {
  res.render("auth/login");
};

exports.getSignup = (req, res) => {
  res.render("auth/signup");
};

exports.signup = async (req, res) => {
  const { username, email, password, role, mobile, BarCouncilRegistrationNumber } = req.body;

  if (!username || !email || !password) {
    return res.render("auth/signup", { error: "Name, email, and password are required" });
  }

  const existingUser = users.find(u => u.email === email);
  if (existingUser) {
    return res.render("auth/signup", { error: "User already exists" });
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  users.push({
    id: Date.now(),
    name: username,
    email,
    password: hashedPassword,
    role: role || "LAWYER",
    mobile,
    BarCouncilRegistrationNumber
  });

  res.redirect("/login");
};

exports.login = async (req, res) => {
  const { email, password } = req.body;

  // Determine which login page to render on failure based on role hint
  // The judge and court master forms both POST here; use a hidden field to know which view to re-render
  const fromView = req.body.fromView || 'judge'; // 'judge' | 'cmaster'
  const errorView = fromView === 'cmaster' ? 'auth/cMasterLogin' : 'auth/judgeLogin';
  const errorLocals = { error: ['Invalid credentials. Please try again.'] };

  if (!email || !password) {
    return res.render(errorView, errorLocals);
  }

  const user = users.find(u => u.email === email.toLowerCase().trim());
  if (!user) {
    return res.render(errorView, errorLocals);
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    return res.render(errorView, errorLocals);
  }

  // Set the session — isAuth and checkRole middlewares read req.session.user
  req.session.user = {
    id:   user.id,
    name: user.name,
    role: user.role,
  };

  redirectByRole(user.role, res);
};

exports.logout = (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
};
