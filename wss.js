import { WebSocketServer, WebSocket } from "ws";
import url from "url";
import { v4 as uuidv4 } from "uuid";
import Employee from "./models/employee.modal.js";
import User from "./models/user.model.js";
import Table from "./models/table.model.js";
import {
  createOrderAction,
  updateOrderAction,
  changeStatusAction,
  deleteOrderAction,
} from "./actions/orderActions.js";

let connections = {};
let monitoringConnections = {};
let users = {};

const isOpen = (connection) =>
  connection && connection.readyState === WebSocket.OPEN;

const broadcast = async (tableNum, payload) => {
  Object.keys(connections).forEach((id) => {
    const connection = connections[id];
    if (isOpen(connection)) {
      connection.send(
        JSON.stringify({
          type: "orderSuccess",
          tableNum,
          payload,
          user: users[id],
        })
      );
    }
  });
  const allTables = await Table.find().populate({
    path: "orders",
    populate: {
      path: "menuItems.product",
      match: { _id: { $ne: null } },
    },
  });
  Object.keys(monitoringConnections).forEach((id) => {
    const connection = monitoringConnections[id];
    if (isOpen(connection)) {
      connection.send(
        JSON.stringify({
          type: "allTables",
          payload: allTables,
        })
      );
    }
  });
};

const handleMessages = async (bytes, connection, tableNum, userId, uuid) => {
  try {
    const message = JSON.parse(bytes.toString());
    const user = users[userId] ? users[userId] : users[uuid];

    switch (message.type) {
      case "newOrder":
        await createOrderAction(message.payload, broadcast, user, tableNum);
        break;
      case "updateOrder":
        await updateOrderAction(message.payload, broadcast, user, tableNum);
        break;
      case "changeStatus":
        await changeStatusAction(message.payload, broadcast, user, tableNum);
        break;
      case "completeOrder":
        await changeStatusAction(
          { orderId: message.payload.orderId, status: "Complete" },
          broadcast,
          user,
          tableNum
        );
        break;
      case "deleteOrder":
        await deleteOrderAction(message.payload, broadcast, user, tableNum);
        break;
      default:
        break;
    }
  } catch (err) {
    console.error(err);
    if (isOpen(connection)) {
      connection.send(
        JSON.stringify({
          type: "error",
          payload: "Invalid request",
        })
      );
    }
  }
};

const handleClose = (tableNum, uuid, userId) => {
  delete connections[userId || uuid];
  delete users[userId || uuid];
};

const isValidTableNum = (value) => /^\d+$/.test(value) && Number(value) > 0;

export const wsServer = async (server) => {
  const wss = new WebSocketServer({
    noServer: true,
    path: "/ws",
  });

  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (socket) => {
      wss.emit("connection", socket, request);
    });
  });

  wss.on("connection", async (connection, request) => {
    const uuid = uuidv4();
    const { tableNum: rawTableNum, userId } = url.parse(
      request.url,
      true
    ).query;

    if (rawTableNum !== undefined && !isValidTableNum(rawTableNum)) {
      connection.close(1008, "Invalid tableNum");
      return;
    }
    const tableNum = rawTableNum;

    try {
      if (!tableNum && userId) {
        monitoringConnections[uuid] = connection;
        const allTables = await Table.find().populate({
          path: "orders",
          populate: {
            path: "menuItems.product",
          },
        });
        connection.send(
          JSON.stringify({
            type: "allTables",
            payload: allTables,
          })
        );
      }

      if (!userId && tableNum) {
        connections[uuid] = connection;
        users[uuid] = {
          username: `Guest`,
          tableNum,
          state: {},
        };
      } else if (userId) {
        connections[userId] = connection;
        const userData = await User.findById(userId);
        const employeeData = await Employee.findById(userId);

        if (!userData && employeeData) {
          users[employeeData._id] = {
            employee: employeeData.employee,
            tableNum,
            state: {},
          };
        } else if (userData) {
          users[userData._id] = {
            username: userData.username,
            tableNum,
            state: {},
          };
        }
      }

      if (tableNum) {
        const table = await Table.findOne({ tableNumber: tableNum }).populate(
          {
            path: "orders",
            populate: {
              path: "menuItems.product",
              match: { _id: { $ne: null } },
            },
          }
        );
        broadcast(tableNum, table);
      }
    } catch (error) {
      console.error("Error establishing WS connection:", error);
      if (isOpen(connection)) {
        connection.close(1011, "Internal error");
      }
      return;
    }

    connection.on("message", async (message) => {
      await handleMessages(message, connection, tableNum, userId, uuid);
    });

    connection.on("close", () => {
      delete monitoringConnections[uuid];
      handleClose(tableNum, uuid, userId);
    });
  });

  return wss;
};
