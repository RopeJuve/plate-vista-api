import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import {
  emitRestaurant,
  join,
  resetRooms,
  sessionRoom,
  staffRoom,
} from "../../src/realtime/rooms.js";

const fakeSocket = () => ({
  readyState: WebSocket.OPEN,
  sent: [],
  send(data) {
    this.sent.push(JSON.parse(data));
  },
});

test("an event in restaurant A never reaches a socket of restaurant B", () => {
  resetRooms();
  const guestA = fakeSocket();
  const staffA = fakeSocket();
  const guestB = fakeSocket();
  const staffB = fakeSocket();
  join(sessionRoom("a", "s1"), guestA);
  join(staffRoom("a"), staffA);
  join(sessionRoom("b", "s1"), guestB);
  join(staffRoom("b"), staffB);

  emitRestaurant("a", { type: "event", event: "order.created", data: { orderId: "1" } });

  assert.equal(guestA.sent.length, 1);
  assert.equal(staffA.sent.length, 1);
  assert.equal(guestB.sent.length, 0);
  assert.equal(staffB.sent.length, 0);
  resetRooms();
});
