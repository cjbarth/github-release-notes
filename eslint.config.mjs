import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import importPlugin from "eslint-plugin-import";
import mochaPlugin from "eslint-plugin-mocha";
import pluginPromise from "eslint-plugin-promise";
// eslint-disable-next-line import/no-unresolved
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";

export default defineConfig([
  globalIgnores(["docs/**", "dist/**", "bin/**"]),
  js.configs.recommended,
  mochaPlugin.configs.flat.recommended,
  importPlugin.flatConfigs.recommended,
  pluginPromise.configs["flat/recommended"],
  {
    files: ["**/*.{cjs,mjs,js}"],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-undef": "error",
      "no-unreachable": 1,
      "no-empty": "error",
      "array-callback-return": "error",
      "no-var": "error",
      "prefer-const": "error",
      "no-template-curly-in-string": "error",
      "consistent-return": "error",
      "no-multiple-empty-lines": ["error", { max: 1, maxBOF: 0 }],
      "arrow-body-style": ["error", "as-needed"],
      "prefer-arrow-callback": ["error", { allowNamedFunctions: true }],
      "prefer-destructuring": ["error", { object: true, array: false }],
      "prefer-spread": "error",
      "prefer-rest-params": "error",
      "import/no-unresolved": "error",
      "import/named": "off", //temp
      "import/default": "error",
      "import/namespace": "error",
      "no-unused-vars": "off",
      "no-debugger": "error",
      strict: "error",
    },
  },
  {
    files: ["**/*.spec.js"],
    languageOptions: {
      globals: {
        ...globals.mocha,
      },
    },
    rules: {
      "prefer-arrow-callback": "off",
      "mocha/no-setup-in-describe": "off",
      "promise/no-callback-in-promise": "off",
      "promise/catch-or-return": "off",
      "promise/always-return": "off",
      "mocha/no-mocha-arrows": "off",
    },
    extends: [],
  },
  eslintConfigPrettier, // goes last
]);
