import test from "node:test";
import assert from "node:assert/strict";
import { backoffMs } from "../../src/modules/tse/signing.service.js";

test("signing backoff doubles from 30 s and is capped at 30 min", () => {
  const minutes = (ms) => ms / 60_000;
  assert.deepEqual(
    Array.from({ length: 9 }, (_, i) => minutes(backoffMs(i + 1))),
    [0.5, 1, 2, 4, 8, 16, 30, 30, 30]
  );
  assert.equal(backoffMs(20), 30 * 60_000);
});
