// Usage: npm run migrate:staff-logins -- [--check]
// --check only reports conflicts; without it the indexes are swapped when
// there are none.
import "../src/config/load-dotenv.js";
import { connectToDatabase, disconnectDatabase } from "../src/db/db.js";
import { migrateStaffLogins } from "../src/db/migrateStaffLogins.js";
import { logger } from "../src/shared/logger.js";

try {
  await connectToDatabase();
  const result = await migrateStaffLogins({ checkOnly: process.argv.includes("--check") });
  logger.info(result, result.applied ? "staff login migration applied" : "staff login migration not applied");
  await disconnectDatabase();
  if (result.conflicts.length > 0 || result.ownerConflicts.length > 0) process.exit(1);
} catch (error) {
  logger.error({ err: error }, "staff login migration failed");
  process.exit(1);
}
