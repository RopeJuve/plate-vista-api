import js from "@eslint/js";
import importX from "eslint-plugin-import-x";
import globals from "globals";

export default [
  // .claude/ holds vendored agent-skill scripts; .sandcastle/ is TypeScript run by tsx; public/ is static.
  { ignores: ["node_modules/**", ".claude/**", ".sandcastle/**", "public/**"] },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    plugins: { "import-x": importX },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true }],
      // Packages first, then our own modules.
      "import-x/order": ["error", { groups: [["builtin", "external"], ["parent", "sibling", "index"]] }],
    },
  },
];
