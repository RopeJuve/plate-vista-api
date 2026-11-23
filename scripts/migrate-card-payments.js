// Usage: npm run migrate:card-payments [-- --dry-run]
import "../src/config/load-dotenv.js";
import { connectToDatabase, disconnectDatabase } from "../src/db/db.js";
import { migrateCardPayments } from "../src/db/migrateCardPayments.js";
import { logger } from "../src/shared/logger.js";

const dryRun = process.argv.includes("--dry-run");

try {
  await connectToDatabase();
  logger.info(await migrateCardPayments({ dryRun }), "card payment migration finished");
  await disconnectDatabase();
} catch (error) {
  logger.error({ err: error }, "card payment migration failed");
  process.exit(1);
}
