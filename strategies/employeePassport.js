import { Strategy as LocalStrategy } from "passport-local";
import { comparePassword } from "../utils/index.js";
import Employee from "../models/employee.modal.js";

export default function (passport) {
  passport.use(
    "employee-local",
    new LocalStrategy(
      {
        usernameField: "employee",
        passwordField: "password",
      },
      async (employee, password, done) => {
        try {
          if (typeof employee !== "string" || typeof password !== "string") {
            return done(null, false, { message: "Invalid credentials" });
          }
          const employeeData = await Employee.findOne({ employee }).select(
            "+password"
          );
          if (!employeeData)
            return done(null, false, { message: "employee not found" });
          const isPasswordMatch = await comparePassword(
            password,
            employeeData.password
          );
          if (!isPasswordMatch)
            return done(null, false, { message: "Wrong password" });
          done(null, employeeData);
        } catch (error) {
          console.log(error, error.message);
          done(error, null);
        }
      }
    )
  );
}
