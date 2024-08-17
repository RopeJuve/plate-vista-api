import { WebSocketServer, WebSocket } from "ws";
import Order from "./models/orders.model.js";
import url from "url";
import MenuItem from "./models/menuItem.model.js";
import { calculateTotal } from "./utils/index.js";

let connections = {};
let users = {};


/* const handleMessages = (bytes, tableNum) => {
  const message = JSON.parse(bytes.toString());


}; */

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
  wss.on("connection", (connection, request) => {
    console.log("Client connected");
    const { tableNum, user } = url.parse(request.url, true).query;
    if(!user){
      users[tableNum] = 'Gest';
    } else {
      users[tableNum] = user;
    }
    console.log(`User: ${users[tableNum]}`);
    console.log(`Table number: ${tableNum}`);
    connections[tableNum] = connection;

    connection.on("message", async (message) => {
      console.log(`Received message => ${message}`);
      try {
        const data = JSON.parse(message);
        if (data.type === "order") {
          const { menuItems, quantity } = data.payload;
          const totalPrice = await calculateTotal(menuItems, MenuItem);
          const order = new Order({
            menuItems,
            quantity,
            totalPrice,
          });
          const savedOrder = await order.save();
          console.log(`Order saved => ${savedOrder}`);
          connection.send(
            JSON.stringify({
              type: "orderSuccess",
              order: savedOrder,
            })
          );
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              const message= JSON.parse(message);
              client.send(JSON.parse(message)); 
            }
          });
        }
      } catch (err) {
        console.log(err);
        connection.send(
          JSON.stringify({
            type: "orderError",
            message: "Failed to process order",
          })
        );
      }
    });
  });

  wss.on("close", () => {
    console.log("Client disconnected");
  });
  return wss;
};
