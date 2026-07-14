const express = require("express");
const app = express();
const mongoose = require("mongoose");
const path = require("path");
const methodOverride = require("method-override");
const ejsMate = require("ejs-mate");
const flash = require("connect-flash");
const passport = require("passport");
const LocalStrategy = require("passport-local");




const session = require("express-session");

//IMP Middlewares - MUST come before routes
app.engine("ejs",ejsMate);
app.set("view engine","ejs");
app.set("views", path.join(__dirname,"views"));
app.use(express.urlencoded({extended : true}));
app.use(express.json());
app.use(methodOverride("_method"));
app.use(express.static(path.join(__dirname,"/public")));

//Establishing Connection
main()
.then(() => console.log("DataBase Connection Successful!"))
.catch(err => console.log(err));


async function main() {
  await mongoose.connect("mongodb://localhost:27017/NyaayDrishti");
};

//All related to Passport
app.use(passport.initialize());
app.use(passport.session());


//Flash Related
app.use((req,res,next) =>{
    res.locals.success = req.flash("success");
    res.locals.error = req.flash("error");
    res.locals.currUser = req.user;
    next();
});



app.get("/",(req,res)=> {
    res.render("landing.ejs");
});


app.listen(8080,()=>{
    console.log("Listening to port Successfully!");
});