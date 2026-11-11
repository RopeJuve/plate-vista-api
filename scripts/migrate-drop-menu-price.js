// Usage: npm run migrate:drop-menu-price [-- --dry-run]
import "../src/config/load-dotenv.js";
import { connectToDatabase, disconnectDatabase } from "../src/db/db.js";
import { migrateDropMenuPrice } from "../src/db/migrateDropMenuPrice.js";
import { logger } from "../src/shared/logger.js";

const dryRun = process.argv.includes("--dry-run");

try {
  await connectToDatabase();
  logger.info(await migrateDropMenuPrice({ dryRun }), "menu price migration finished");
  await disconnectDatabase();
} catch (error) {
  logger.error({ err: error }, "menu price migration failed");
  process.exit(1);
}
