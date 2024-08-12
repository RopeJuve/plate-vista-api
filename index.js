import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import session from "express-session";
import connectToDatabase from "./db/db.js";
import passport from "passport";
import userRouter from "./routes/userRouter.js";
import authRouter from "./routes/authRouter.js";
import "./strategies/passport.js";
import menuItemRouter from "./routes/menuItemRouter.js";
dotenv.config();
const app = express();
const PORT = process.env.PORT || 8080;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cors());
app.use(express.json());

app.use(
  session({
    secret: process.env.SECRET,
    resave: false,
    saveUninitialized: false,
  })
);

app.get("/", (req, res) => {
  res.send("Plate Vista API");
});
app.use("/api/v1/users", userRouter);
app.use("/api/v1/auth", authRouter);

app.use('/api/v1/menu-items', menuItemRouter);

app.use(passport.initialize());
app.use(passport.session());

await connectToDatabase();
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
