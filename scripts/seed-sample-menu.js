// Development and demos only. Usage: npm run seed:sample-menu -- --slug <restaurant-slug>
import "../src/config/load-dotenv.js";
import { connectToDatabase, disconnectDatabase } from "../src/db/db.js";
import { seedSampleMenu } from "../src/db/seedSampleMenu.js";
import { logger } from "../src/shared/logger.js";

const index = process.argv.indexOf("--slug");
const slug = index === -1 ? undefined : process.argv[index + 1];
if (!slug) {
  console.error("Usage: npm run seed:sample-menu -- --slug <restaurant-slug>");
  process.exit(1);
}

try {
  await connectToDatabase();
  logger.info({ slug, ...(await seedSampleMenu(slug)) }, "sample menu seeded");
  await disconnectDatabase();
} catch (error) {
  logger.error({ err: error }, "sample menu seeding failed");
  process.exit(1);
}
