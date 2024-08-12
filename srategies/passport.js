import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { comparePassword } from "../utils/index.js";
import User from "../models/user.model.js";

passport.use(
  new LocalStrategy(async (username, password, done) => {
    try {
      const user = await User.findOne({ username });
      if (!user) return done(null, false, { message: "User not found" });
      const isPasswordMatch = await comparePassword(password, user.password);
      if (!isPasswordMatch)
        return done(null, false, { message: "Wrong password" });
      done(null, user);
    } catch (error) {
      console.log(error, error.message);
      done(error, null);
    }
  })
);
