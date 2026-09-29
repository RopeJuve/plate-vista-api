import mongoose from "mongoose";
import Employee from "../modules/staff/employee.model.js";

const normalizedName = (name) => String(name || "").trim().toLowerCase();

// Names the new per-restaurant index would reject: same restaurant, same name
// ignoring case and surrounding spaces.
const findNameConflicts = (employees) => {
  const groups = new Map();
  for (const employee of employees) {
    const key = `${employee.restaurantId}|${normalizedName(employee.employee)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(employee);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      restaurantId: String(group[0].restaurantId),
      name: normalizedName(group[0].employee),
      employees: group.map((employee) => employee.employee),
    }));
};

// Owners log in with email alone, so each needs one, used by no other owner.
const findOwnerConflicts = (employees) => {
  const owners = employees.filter((employee) => employee.role === "owner");
  const conflicts = owners
    .filter((owner) => !owner.email)
    .map((owner) => ({ employeeId: String(owner._id), problem: "owner has no email" }));
  const byEmail = new Map();
  for (const owner of owners.filter((candidate) => candidate.email)) {
    const email = String(owner.email).trim().toLowerCase();
    byEmail.set(email, [...(byEmail.get(email) || []), String(owner._id)]);
  }
  for (const [email, ids] of byEmail) {
    if (ids.length > 1) conflicts.push({ email, employeeIds: ids, problem: "email shared by owners" });
  }
  return conflicts;
};

// Moves staff login from globally unique names to names unique per restaurant.
// Changes nothing while conflicts remain, so an index build can never fail
// half way and leave logins unprotected, as the old unique indexes did.
export const migrateStaffLogins = async ({ checkOnly = false } = {}) => {
  const collection = mongoose.connection.db.collection("employees");
  const employees = await collection.find({}).toArray();
  const conflicts = findNameConflicts(employees);
  const ownerConflicts = findOwnerConflicts(employees);
  if (checkOnly || conflicts.length > 0 || ownerConflicts.length > 0) {
    return { applied: false, conflicts, ownerConflicts };
  }

  const cleanups = employees
    .map((employee) => {
      const set = {};
      const name = String(employee.employee || "").trim();
      if (name !== employee.employee) set.employee = name;
      if (employee.email) {
        const email = String(employee.email).trim().toLowerCase();
        if (email !== employee.email) set.email = email;
      }
      return Object.keys(set).length > 0
        ? { updateOne: { filter: { _id: employee._id }, update: { $set: set } } }
        : null;
    })
    .filter(Boolean);
  if (cleanups.length > 0) await collection.bulkWrite(cleanups);

  // Drops employee_1 and email_1 (not in the schema) and builds the new ones.
  await Employee.syncIndexes();
  return { applied: true, conflicts, ownerConflicts, cleaned: cleanups.length };
};
