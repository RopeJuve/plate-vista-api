import "./src/config/load-dotenv.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import app from "./src/app.js";

const isEntry =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntry) {
  const { start, registerSignals } = await import("./src/server.js");
  registerSignals();
  await start();
}

export default app;
