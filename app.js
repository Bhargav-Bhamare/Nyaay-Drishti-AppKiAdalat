require("dotenv").config();
const express = require("express");
const app = express();
const mongoose = require("mongoose");
const path = require("path");
const methodOverride = require("method-override");
const ejsMate = require("ejs-mate");
const flash = require("connect-flash");
const passport = require("passport");
const LocalStrategy = require("passport-local");
const Lawyer = require("./model/lawyer.js");
const serverless = require("serverless-http");

//Router Requirement
const authRoutes     = require("./routes/authRoutes");
const dashboardRoutes  = require("./routes/dashboardRoutes");
const lawyerRouter     = require("./routes/lawyer.js");
const schedulerRoutes  = require("./routes/schedulerRoutes");
const { getVoiceReply, isConfigured } = require('./services/gnaniVoiceService');

const session = require("express-session");

//IMP Middlewares - MUST come before routes
app.engine("ejs",ejsMate);
app.set("view engine","ejs");
app.set("views", path.join(__dirname,"views"));
app.use(express.urlencoded({extended : true}));
app.use(express.json());
app.use(methodOverride("_method"));
app.use(express.static(path.join(__dirname,"/public")));

// Serverless-safe Database Connection Middleware
const connectDB = async (req, res, next) => {
  try {
    if (mongoose.connection.readyState === 1) {
      return next();
    }

    const dbUrl = process.env.MONGODB_URI || "mongodb://localhost:27017/NyaayDrishti";

    await mongoose.connect(dbUrl, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });

    console.log("DataBase Connection Successful!");
    next();
  } catch (err) {
    console.error("❌ Database Connection Error:", err);
    return res.status(500).json({
      error: "Database connection failed",
      details: err.message
    });
  }
};

// Fire this middleware on every request before hitting routes
app.use(connectDB);
//Session Configuration
app.use(
  session({
    name: "judicial-session",
    secret: process.env.SESSION_SECRET || "hackathon-secret-key",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 // 1 hour
    }
  })
);
app.use(flash());
//All related to Passport
app.use(passport.initialize());
app.use(passport.session());
passport.use(new LocalStrategy({ usernameField: 'email' }, Lawyer.authenticate()));
passport.serializeUser(Lawyer.serializeUser());
passport.deserializeUser(Lawyer.deserializeUser());

//Flash Related
app.use((req,res,next) =>{
    res.locals.success = req.flash("success");
    res.locals.error = req.flash("error");
    res.locals.currUser = req.user;
    next();
});

app.use(authRoutes);
app.use("/", lawyerRouter);
app.use(dashboardRoutes);
app.use("/api/scheduler", schedulerRoutes);

app.get("/",(req,res)=> {
    res.render("landing.ejs");
});

app.get("/lawyerDashboard", (req, res) =>{
  if (!req.user) {
    req.flash("error", "Please login to access the Lawyer Dashboard");
    return res.redirect('/login');
  }
  res.render("lawyer/lawyerDash.ejs");
});

app.get("/judgeDashboard",(req,res) =>{
    res.render("judge/judgeDash.ejs");
});

app.get("/cMasterDashboard",(req,res) =>{
    res.render("cMaster/cMasterDash.ejs");
});

app.get("/judgeLogin",(req,res) =>{
    res.render("auth/judgeLogin.ejs");
});

app.get("/cMasterLogin",(req,res) =>{
    res.render("auth/cMasterLogin.ejs");
});

app.get("/voice-status", (req, res) => {
  res.render("voiceStatus", {
    title: "Voice Case Status",
    subtitle: "Future-ready voice experience for citizens and advocates",
    samplePhrases: [
      "What is the status of my case?",
      "When is my next hearing?",
    ]
  });
});

app.post('/api/voice/assistant', async (req, res) => {
  try {
    const { textInput, transcript = '', language = 'en', targetVoice = null } = req.body || {};
    const inputText = textInput || transcript || '';
    const result = await getVoiceReply({ transcript: inputText, language, targetVoice });
    const audioBufferBase64 = Buffer.isBuffer(result.audioBuffer)
      ? result.audioBuffer.toString('base64')
      : (result.audioBuffer ? String(result.audioBuffer) : null);

    res.json({
      ok: true,
      configured: result.configured,
      provider: result.provider,
      transcript: result.transcript,
      reply: result.reply,
      textResponse: result.textResponse || result.reply || '',
      audioBuffer: audioBufferBase64,
      audioContentType: result.audioContentType || 'audio/mpeg',
      isMock: result.isMock ?? (result.provider === 'mock' || result.provider === 'mock-fallback'),
      success: result.success ?? true,
      note: isConfigured() ? 'Using configured voice backend.' : 'No GNANI credentials configured; using mock response.'
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const port = process.env.PORT || 8080;

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Listening to port ${port} Successfully!`);
  });
}

module.exports = serverless(app);