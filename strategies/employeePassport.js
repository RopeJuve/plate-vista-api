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
          const employeeData = await Employee.findOne({ employee });
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

  passport.serializeUser((employeeData, done) => {
    done(null, employeeData._id);
  });

  passport.deserializeUser(async (id, done) => {
    try {
      const employeeData = await Employee.findById(id);
      if (!employeeData) throw new Error("employee not found");
      done(null, employeeData);
    } catch (error) {
      done(error, null);
    }
  });
}
