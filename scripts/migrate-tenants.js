import "../src/config/load-dotenv.js";
import { connectToDatabase, disconnectDatabase } from "../src/db/db.js";
import { migrateTenants } from "../src/db/migrateTenants.js";
import { logger } from "../src/shared/logger.js";

try {
  await connectToDatabase();
  const restaurant = await migrateTenants();
  logger.info({ restaurantId: String(restaurant._id) }, "tenant migration finished");
  await disconnectDatabase();
} catch (error) {
  logger.error({ err: error }, "tenant migration failed");
  process.exit(1);
}
