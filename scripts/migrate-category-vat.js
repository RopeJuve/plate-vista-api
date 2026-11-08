// Usage: npm run migrate:category-vat [-- --dry-run]
import "../src/config/load-dotenv.js";
import { connectToDatabase, disconnectDatabase } from "../src/db/db.js";
import { migrateCategoryVat } from "../src/db/migrateCategoryVat.js";
import { logger } from "../src/shared/logger.js";

const dryRun = process.argv.includes("--dry-run");

try {
  await connectToDatabase();
  logger.info(await migrateCategoryVat({ dryRun }), "category VAT migration finished");
  await disconnectDatabase();
} catch (error) {
  logger.error({ err: error }, "category VAT migration failed");
  process.exit(1);
}
