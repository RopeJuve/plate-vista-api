// Usage: npm run migrate:tickets
import "../src/config/load-dotenv.js";
import { connectToDatabase, disconnectDatabase } from "../src/db/db.js";
import { migrateTickets } from "../src/db/migrateTickets.js";
import { logger } from "../src/shared/logger.js";

try {
  await connectToDatabase();
  logger.info(await migrateTickets(), "ticket migration finished");
  await disconnectDatabase();
} catch (error) {
  logger.error({ err: error }, "ticket migration failed");
  process.exit(1);
}
