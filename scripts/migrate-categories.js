// Usage: npm run migrate:categories
import "../src/config/load-dotenv.js";
import { connectToDatabase, disconnectDatabase } from "../src/db/db.js";
import { migrateCategories } from "../src/db/migrateCategories.js";
import { logger } from "../src/shared/logger.js";

try {
  await connectToDatabase();
  logger.info(await migrateCategories(), "category migration finished");
  await disconnectDatabase();
} catch (error) {
  logger.error({ err: error }, "category migration failed");
  process.exit(1);
}
