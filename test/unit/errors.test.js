import test from "node:test";
import assert from "node:assert/strict";
import { AppError, ErrorCodes, STATUS_BY_CODE } from "../../src/shared/errors.js";

test("AppError: a registered code keeps its code and takes its status from the table", () => {
  const error = new AppError("BILL_PAID", "The bill is paid");
  assert.equal(error.code, "BILL_PAID");
  assert.equal(error.status, 409);
  assert.equal(error.message, "The bill is paid");
});

test("AppError: an explicit status overrides the table", () => {
  const error = new AppError("VALIDATION", "Move its items first", 409);
  assert.equal(error.code, "VALIDATION");
  assert.equal(error.status, 409);
});

test("AppError: details are kept", () => {
  const error = new AppError("INVALID_TRANSITION", "nope", undefined, { from: "a", to: "b" });
  assert.equal(error.status, 409);
  assert.deepEqual(error.details, { from: "a", to: "b" });
});

test("AppError: an unregistered code throws a programmer error naming the code", () => {
  assert.throws(
    () => new AppError("NO_SUCH_CODE", "whatever"),
    (error) => !(error instanceof AppError) && /NO_SUCH_CODE/.test(error.message)
  );
});

test("AppError: an unregistered code throws even with an explicit status", () => {
  assert.throws(() => new AppError("NO_SUCH_CODE", "whatever", 409), /NO_SUCH_CODE/);
});

test("AppError: inherited object keys are not codes", () => {
  assert.throws(() => new AppError("toString", "whatever"), /toString/);
});

test("ErrorCodes: every code has an HTTP error status in the status table", () => {
  for (const [key, code] of Object.entries(ErrorCodes)) {
    assert.equal(code, key, `ErrorCodes.${key} is its own name`);
    const status = STATUS_BY_CODE[key];
    assert.ok(Number.isInteger(status) && status >= 400 && status <= 599, `${key} has status ${status}`);
  }
});

test("ErrorCodes: the status table has no code that is not registered", () => {
  for (const key of Object.keys(STATUS_BY_CODE)) {
    assert.ok(Object.hasOwn(ErrorCodes, key), `${key} is in ErrorCodes`);
  }
});

test("AppError: LATE_PAYMENT is registered as 409", () => {
  assert.equal(new AppError("LATE_PAYMENT", "late").status, 409);
});
