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

const broadcast = (tableNum) => {
  console.log(Object.keys(connections));
  Object.keys(connections).forEach((id) => {
    const connection = connections[id];
    connection.send(
      JSON.stringify({
        type: "orderSuccess",
        tableNum,
        payload: users,
      })
    );
  });
};

const handleMessages = async (bytes, tableNum, userId) => {
  try {
    const message = JSON.parse(bytes.toString());
    const user = users[userId] ? users[userId] : users[tableNum];

    switch (message.type) {
      case "NEW_ORDER":
        await createOrderAction(message.payload, broadcast, user, tableNum);
        break;
      case "UPDATE_ORDER":
        await updateOrderAction(message.payload, broadcast, user, tableNum);
        break;
      case "CHANGE_STATUS":
        await changeStatusAction(message.payload, broadcast, user, tableNum);
        break;
      case "COMPLETE_ORDER":
        await changeStatusAction(
          { orderId: message.payload.orderId, status: "Completed" },
          broadcast,
          user,
          tableNum
        );
        break;
      case "DELETE_ORDER":
        await deleteOrderAction(message.payload, broadcast, user, tableNum);
      default:
        break;
    }
  } catch (err) {
    console.log(err);
    connections[tableNum].send(
      JSON.stringify({
        type: "orderError",
        message: "Failed to process order",
      })
    );
  }
};

const handleClose = (tableNum) => {
  delete connections[tableNum];
  delete users[tableNum];
  broadcast();
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
    } else {
      connections[userId] = connection;
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
      await handleMessages(message, tableNum, userId);
    });

    wss.on("close", () => handleClose(tableNum));
    return wss;
  });
};
