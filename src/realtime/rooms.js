import { WebSocket } from "ws";

const rooms = new Map();

export const staffRoom = (restaurantId) => `r:${restaurantId}:staff`;

export const sessionRoom = (restaurantId, sessionId) =>
  `r:${restaurantId}:session:${sessionId}`;

export const join = (room, socket) => {
  let members = rooms.get(room);
  if (!members) {
    members = new Set();
    rooms.set(room, members);
  }
  if (!socket.rooms) socket.rooms = new Set();
  socket.rooms.add(room);
  members.add(socket);
};

export const leaveAll = (socket) => {
  for (const room of socket.rooms || []) {
    rooms.get(room)?.delete(socket);
    if (rooms.get(room)?.size === 0) rooms.delete(room);
  }
  socket.rooms = new Set();
};

const deliver = (socket, message) => {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
};

export const emit = (room, message) => {
  for (const socket of rooms.get(room) || []) {
    deliver(socket, message);
  }
};

export const emitRestaurant = (restaurantId, message) => {
  const prefix = `r:${restaurantId}:`;
  for (const room of rooms.keys()) {
    if (room.startsWith(prefix)) emit(room, message);
  }
};

export const resetRooms = () => {
  rooms.clear();
};
