import { WebSocketServer, WebSocket } from "ws";
import url from "url";
import { v4 as uuidv4 } from "uuid";
import User from "./models/user.model.js";
import Table from "./models/table.model.js";
import { verifyToken } from "./utils/index.js";
import {
  createOrderAction,
  updateOrderAction,
  changeStatusAction,
  deleteOrderAction,
} from "./actions/orderActions.js";

// uuid -> { connection, role, tableNum, identity, isMonitoring, isAlive }
const sockets = new Map();

const isOpen = (connection) =>
  connection && connection.readyState === WebSocket.OPEN;

const send = (connection, data) => {
  if (isOpen(connection)) {
    connection.send(JSON.stringify(data));
  }
};

const isValidTableNum = (value) =>
  typeof value === "string" && /^\d+$/.test(value) && Number(value) > 0;

const identityFor = async (auth) => {
  if (auth.role === "employee") {
    return { employeeId: auth.id, position: auth.position };
  }
  if (auth.userId) {
    const user = await User.findById(auth.userId);
    if (user) return { userId: user._id, username: user.username };
  }
  return { username: "Guest" };
};

const broadcast = async (tableNum, payload) => {
  for (const meta of sockets.values()) {
    if (meta.tableNum === String(tableNum) && isOpen(meta.connection)) {
      send(meta.connection, {
        type: "orderSuccess",
        tableNum,
        payload,
        user: meta.identity,
      });
    }
  }

  const allTables = await Table.find().populate({
    path: "orders",
    populate: {
      path: "menuItems.product",
      match: { _id: { $ne: null } },
    },
  });
  for (const meta of sockets.values()) {
    if (meta.isMonitoring && isOpen(meta.connection)) {
      send(meta.connection, { type: "allTables", payload: allTables });
    }
  }
};

const EMPLOYEE_ONLY_ACTIONS = new Set([
  "changeStatus",
  "completeOrder",
  "deleteOrder",
]);
const GUEST_ACTIONS = new Set(["newOrder", "updateOrder"]);

const handleMessages = async (bytes, meta) => {
  const { connection, role, tableNum } = meta;
  try {
    const message = JSON.parse(bytes.toString());

    if (role !== "employee" && EMPLOYEE_ONLY_ACTIONS.has(message.type)) {
      return send(connection, { type: "error", payload: "Forbidden" });
    }
    if (role !== "employee" && !GUEST_ACTIONS.has(message.type)) {
      return send(connection, { type: "error", payload: "Forbidden" });
    }

    switch (message.type) {
      case "newOrder":
        await createOrderAction(
          message.payload,
          broadcast,
          meta.identity,
          tableNum,
          connection
        );
        break;
      case "updateOrder":
        await updateOrderAction(
          message.payload,
          broadcast,
          meta.identity,
          tableNum,
          connection,
          role
        );
        break;
      case "changeStatus":
        await changeStatusAction(
          message.payload,
          broadcast,
          meta.identity,
          tableNum,
          connection
        );
        break;
      case "completeOrder":
        await changeStatusAction(
          { orderId: message.payload.orderId, status: "Complete" },
          broadcast,
          meta.identity,
          tableNum,
          connection
        );
        break;
      case "deleteOrder":
        await deleteOrderAction(
          message.payload,
          broadcast,
          meta.identity,
          tableNum,
          connection
        );
        break;
      default:
        break;
    }
  } catch (err) {
    console.error(err);
    send(connection, { type: "error", payload: "Invalid request" });
  }
};

export const wsServer = async (server) => {
  const wss = new WebSocketServer({
    noServer: true,
    path: "/ws",
  });

  server.on("upgrade", (request, socket, head) => {
    const { query } = url.parse(request.url, true);
    const token = query.token;

    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    let auth;
    try {
      auth = verifyToken(token);
    } catch (error) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    if (auth.role !== "employee" && auth.role !== "guest") {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    if (
      auth.role === "employee" &&
      query.tableNum !== undefined &&
      !isValidTableNum(query.tableNum)
    ) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (socket) => {
      wss.emit("connection", socket, request, auth);
    });
  });

  wss.on("connection", async (connection, request, auth) => {
    const uuid = uuidv4();
    const { query } = url.parse(request.url, true);

    // Guests are always scoped to the table embedded in their signed
    // token; employees may pick any table (or none, for monitoring).
    const tableNum =
      auth.role === "guest" ? auth.tableNum : query.tableNum || null;
    const isMonitoring = auth.role === "employee" && !tableNum;

    const identity = await identityFor(auth);
    const meta = {
      connection,
      role: auth.role,
      tableNum,
      identity,
      isMonitoring,
    };
    sockets.set(uuid, meta);

    try {
      if (isMonitoring) {
        const allTables = await Table.find().populate({
          path: "orders",
          populate: { path: "menuItems.product" },
        });
        send(connection, { type: "allTables", payload: allTables });
      } else if (tableNum) {
        const table = await Table.findOne({
          tableNumber: tableNum,
        }).populate({
          path: "orders",
          populate: {
            path: "menuItems.product",
            match: { _id: { $ne: null } },
          },
        });
        if (!table) {
          send(connection, { type: "error", payload: "Table not found" });
        } else {
          send(connection, { type: "orderSuccess", tableNum, payload: table });
        }
      }
    } catch (error) {
      console.error("Error establishing WS connection:", error);
    }

    connection.isAlive = true;
    connection.on("pong", () => {
      connection.isAlive = true;
    });

    connection.on("message", async (message) => {
      await handleMessages(message, meta);
    });

    connection.on("close", () => {
      sockets.delete(uuid);
    });
  });

  const heartbeat = setInterval(() => {
    for (const [uuid, meta] of sockets.entries()) {
      const { connection } = meta;
      if (connection.isAlive === false) {
        sockets.delete(uuid);
        connection.terminate();
        continue;
      }
      connection.isAlive = false;
      connection.ping();
    }
  }, 30000);

  wss.on("close", () => clearInterval(heartbeat));

  return wss;
};
