import test from "node:test";
import assert from "node:assert/strict";
import { join, resetRooms, roomSize, staffRoom } from "../../src/realtime/rooms.js";
import { HEARTBEAT_INTERVAL_MS, sweepDeadSockets } from "../../src/realtime/wsServer.js";

test("a killed client is removed from rooms within two 30s sweeps", () => {
  assert.equal(HEARTBEAT_INTERVAL_MS, 30_000);
  resetRooms();
  const socket = {
    isAlive: true,
    readyState: 1,
    ping() {
      this.pinged = (this.pinged || 0) + 1;
    },
    terminate() {
      this.terminated = true;
    },
    close() {},
    send() {},
  };
  const room = staffRoom("restaurant");
  join(room, socket);

  sweepDeadSockets([socket]);
  assert.equal(socket.pinged, 1);
  assert.equal(socket.terminated, undefined);
  assert.equal(roomSize(room), 1);

  sweepDeadSockets([socket]);
  assert.equal(socket.terminated, true);
  assert.equal(roomSize(room), 0);
  resetRooms();
});
