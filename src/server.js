import "./config/load-dotenv.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import app from "./app.js";
import { loadEnv } from "./config/env.js";
import { connectToDatabase, disconnectDatabase } from "./db/db.js";
import { attachWebSocket } from "./realtime/wsServer.js";
import { logger } from "./shared/logger.js";

let httpServer;
let sockets;
let shuttingDown = false;

export const start = async () => {
  shuttingDown = false;
  const env = loadEnv();
  await connectToDatabase();
  httpServer = app.listen(env.port, () => {
    logger.info({ port: env.port, target: env.DEPLOY_TARGET }, "server listening");
  });
  sockets = attachWebSocket(httpServer);
  return { httpServer, sockets };
};

export const shutdownResources = async ({ server, sockets: openSockets, disconnect, signal }) => {
  logger.info({ signal }, "shutting down");
  const closed = server
    ? new Promise((resolve) => {
        server.close(() => resolve());
      })
    : Promise.resolve();
  if (openSockets) {
    for (const client of openSockets.clients) {
      client.close(1001, "server shutting down");
    }
    openSockets.close();
  }
  await closed;
  if (disconnect) await disconnect();
};

export const shutdown = async (signal = "SIGTERM") => {
  if (shuttingDown) return;
  shuttingDown = true;
  const server = httpServer;
  const openSockets = sockets;
  httpServer = null;
  sockets = null;
  await shutdownResources({
    server,
    sockets: openSockets,
    disconnect: disconnectDatabase,
    signal,
  });
};

export const registerSignals = () => {
  process.on("SIGTERM", () => {
    shutdown("SIGTERM")
      .then(() => process.exit(0))
      .catch((error) => {
        logger.error({ err: error }, "shutdown failed");
        process.exit(1);
      });
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT")
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
};

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
});

const isDirect =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirect) {
  registerSignals();
  start().catch((error) => {
    logger.error({ err: error }, "failed to start");
    process.exit(1);
  });
}
