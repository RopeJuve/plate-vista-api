import { WebSocketServer } from "ws";
import url from "url";
import { v4 as uuidv4 } from "uuid";
import Employee from "./models/employee.modal.js";
import User from "./models/user.model.js";
import {
  createOrderAction,
  updateOrderAction,
  changeStatusAction,
  deleteOrderAction,
} from "./actions/orderActions.js";

let connections = {};
let users = {};

const broadcast = (tableNum, payload) => {
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
    Object.keys(connections).forEach((id) => {
      connections[id].send(
        JSON.stringify({
          type: "error",
          payload: "Invalid request",
        })
      );
    });
  }
};

const handleClose = (tableNum, uuid, userId) => {
  let connectionRemoved = false;

  if (uuid && connections[uuid]) {
    delete connections[uuid];
    delete users[uuid];
    connectionRemoved = true;
    console.log(`Connection with UUID: ${uuid} has been removed.`);
  }

  if (userId && connections[userId]) {
    delete connections[userId];
    delete users[userId];
    connectionRemoved = true;
    console.log(`Connection with User ID: ${userId} has been removed.`);
  }

  if (connectionRemoved) {
    broadcast(tableNum);
  } else {
    console.log(`No connections found for UUID: ${uuid} or User ID: ${userId}`);
  }
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

    if (!userId) {
      connections[uuid] = connection;
      users[uuid] = {
        username: `Guest`,
        state: {},
      };
      console.log(`User: ${users[uuid].username}`);
      console.log(`connection: ${connections[uuid]}`);
    } else {
      connections[userId] = connection;
      console.log(`connection: ${connections[userId]}`);
      const userData = await User.findById(userId);
      const employeeData = await Employee.findById(userId);
      if (!userData) {
        users[employeeData._id] = {
          employee: employeeData.employee,
          state: {},
        };
      } else {
        users[userData._id] = {
          username: userData.username,
          state: {},
        };
      }
    }
    console.log(users);
    console.log(`Table number: ${tableNum}`);
    connection.on("message", async (message) => {
      await handleMessages(message, tableNum, userId, uuid);
    });

    wss.on("close", () => handleClose(tableNum, uuid, userId));
    return wss;
  });
};
