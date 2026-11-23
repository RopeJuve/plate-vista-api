import test from "node:test";
import assert from "node:assert/strict";
import { ESLint } from "eslint";

const eslint = new ESLint();
// A path inside src/ so the repo's config applies; the file itself is never read.
const filePath = "src/lint-fixture.js";

const ruleIds = async (code) => {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.map((m) => m.ruleId);
};

test("lint: an import of our own module before a package import is an import-order error", async () => {
  const code = 'import { ErrorCodes } from "./shared/errors.js";\nimport mongoose from "mongoose";\n\nexport default [ErrorCodes, mongoose];\n';
  assert.deepEqual(await ruleIds(code), ["import-x/order"]);
});

test("lint: packages first, then our own modules, passes", async () => {
  const code = 'import mongoose from "mongoose";\n\nimport { ErrorCodes } from "./shared/errors.js";\n\nexport default [ErrorCodes, mongoose];\n';
  assert.deepEqual(await ruleIds(code), []);
});
