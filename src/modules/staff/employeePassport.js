import { Strategy as LocalStrategy } from "passport-local";
import { comparePassword } from "../../shared/auth.js";
import Employee from "./employee.model.js";

export default function employeePassport(passport) {
  passport.use(
    "employee-local",
    new LocalStrategy(
      { usernameField: "employee", passwordField: "password" },
      async (employee, password, done) => {
        try {
          if (typeof employee !== "string" || typeof password !== "string") {
            return done(null, false, { message: "Invalid credentials" });
          }
          const employeeData = await Employee.findOne({ employee })
            .setOptions({ skipTenant: true })
            .select("+password");
          if (!employeeData) return done(null, false, { message: "employee not found" });
          const isPasswordMatch = await comparePassword(password, employeeData.password);
          if (!isPasswordMatch) return done(null, false, { message: "Wrong password" });
          return done(null, employeeData);
        } catch (error) {
          return done(error);
        }
      }
    )
  );
}
