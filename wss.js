import { WebSocketServer } from "ws";
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

const broadcast = async (tableNum, payload) => {
  console.log(Object.keys(connections));
  Object.keys(connections).forEach((id) => {
    const connection = connections[id];
    console.log(`connection from broadcast: ${connection}`);
    connection.send(
      JSON.stringify({
        type: "orderSuccess",
        tableNum,
        payload,
        user: users[id],
      })
    );
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
    connection.send(
      JSON.stringify({
        type: "allTables",
        payload: allTables,
      })
    );
  });
};

const handleMessages = async (bytes, tableNum, userId, uuid) => {
  try {
    const message = JSON.parse(bytes.toString());
    const user = users[userId] ? users[userId] : users[uuid];
    console.log(message.type);

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
          { orderId: message.payload.orderId, status: "Completed" },
          broadcast,
          user,
          tableNum
        );
        break;
      case "deleteOrder":
        await deleteOrderAction(message.payload, broadcast, user, tableNum);
      default:
        break;
    }
  } catch (err) {
    console.log(err);
    connections[uuid || userId].send(
      JSON.stringify({
        type: "error",
        payload: "Invalid request",
      })
    );
  }
};

const handleClose = (tableNum, uuid, userId) => {
  delete connections[userId || uuid];
  delete users[userId || uuid];
  console.log(tableNum);
  console.log(`User: ${users[userId || uuid]} has disconnected`);
  console.log(`connection: ${connections[userId || uuid]} has disconnected`);
};

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
    console.log("Client connected");
    const uuid = uuidv4();
    const { tableNum, userId } = url.parse(request.url, true).query;

    if (!tableNum && !userId) {
      console.log("Connected without table number");
      monitoringConnections[uuid] = connection;
      try {
        const allTables = await Table.find().populate({
          path: "orders",
          populate: {
            path: "menuItems.product",
            match: { _id: { $ne: null } },
          },
        });
        connection.send(
          JSON.stringify({
            type: "allTables",
            payload: allTables,
          })
        );
      } catch (error) {
        console.error("Error fetching all tables:", error);
        connection.send(
          JSON.stringify({
            type: "error",
            payload: "Failed to fetch tables",
          })
        );
      }
    }

    if (!userId && tableNum) {
      connections[uuid] = connection;
      users[uuid] = {
        username: `Guest`,
        tableNum: tableNum ? tableNum : '',
        state: {},
      };
      console.log(`User: ${users[uuid].username}`);
      console.log(`connection: ${connections[uuid]}`);
    } else {
      connections[userId] = connection;
      console.log(`connection: ${connections[userId]}`);
      try {
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
      } catch (error) {
        console.error("Error fetching user or employee data:", error);
      }
    }
    console.log(users);
    if (tableNum) {
      console.log(`Table number: ${tableNum}`);
      const table = await Table.findOne({ tableNumber: tableNum }).populate({
        path: "orders",
        populate: {
          path: "menuItems.product",
          match: { _id: { $ne: null } },
        },
      });
      broadcast(tableNum, table);
    }

    connection.on("message", async (message) => {
      await handleMessages(message, tableNum, userId, uuid);
    });

    connection.on("close", () => {
      if (monitoringConnections[uuid]) {
        delete monitoringConnections[uuid];
        console.log(
          `Monitoring connection with UUID: ${uuid} has been removed.`
        );
      }
      handleClose(tableNum, uuid, userId);
    });
    return wss;
  });
};
