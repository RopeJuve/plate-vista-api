import { Strategy as LocalStrategy } from "passport-local";
import { comparePassword } from "../../shared/auth.js";
import User from "./user.model.js";

export default function userPassport(passport) {
  passport.use(
    "user-local",
    new LocalStrategy(async (username, password, done) => {
      try {
        if (typeof username !== "string" || typeof password !== "string") {
          return done(null, false, { message: "Invalid credentials" });
        }
        const user = await User.findOne({ username }).select("+password");
        if (!user) return done(null, false, { message: "User not found" });
        const isPasswordMatch = await comparePassword(password, user.password);
        if (!isPasswordMatch) return done(null, false, { message: "Wrong password" });
        return done(null, user);
      } catch (error) {
        return done(error);
      }
    })
  );
}
