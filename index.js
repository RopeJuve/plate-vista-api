import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import session from "express-session";
import connectToDatabase from "./db/db.js";
import passport from "passport";
import userPassport from "./strategies/userPassport.js";
import employeePassport from "./strategies/employeePassport.js";
import {
  userRouter,
  authRouter,
  menuItemRouter,
  orderRouter,
  employeeRouter,
  tableRouter,
  statisticsRouter,
} from "./routes/index.js";

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

userPassport(passport);
employeePassport(passport);

app.get("/", (req, res) => {
  res.send("Plate Vista API");
});

app.use("/api/v1/employee", employeeRouter);
app.use("/api/v1/users", userRouter);
app.use("/api/v1/auth", authRouter);

app.use("/api/v1/menu-items", menuItemRouter);
app.use("/api/v1/orders", orderRouter);
app.use("/api/v1/table", tableRouter);

app.use("/api/v1/statistics", statisticsRouter);

app.use(passport.initialize());
app.use(passport.session());

await connectToDatabase();
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
