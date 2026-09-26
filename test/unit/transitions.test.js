import test from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_TRANSITIONS, ORDER_STATUSES, assertTransition } from "../../src/modules/ordering/order.transitions.js";
import { AppError } from "../../src/shared/errors.js";

test("every order status has an explicit transition list", () => {
  for (const status of ORDER_STATUSES) {
    assert.ok(Array.isArray(ALLOWED_TRANSITIONS[status]), status);
  }
});

test("transition table accepts only the legal edges", () => {
  for (const from of ORDER_STATUSES) {
    for (const to of ORDER_STATUSES) {
      const allowed = ALLOWED_TRANSITIONS[from].includes(to);
      if (allowed) {
        assert.doesNotThrow(() => assertTransition(from, to), `${from} → ${to}`);
      } else {
        assert.throws(
          () => assertTransition(from, to),
          (error) => error instanceof AppError && error.code === "INVALID_TRANSITION",
          `${from} → ${to} should be rejected`
        );
      }
    }
  }
});
