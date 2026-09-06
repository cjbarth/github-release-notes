import eslint from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import { flatConfigs as importXConfigs } from "eslint-plugin-import-x";
import mochaPlugin from "eslint-plugin-mocha";
import pluginPromise from "eslint-plugin-promise";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";

export default defineConfig([
  globalIgnores(["coverage/**"]),
  eslint.configs.recommended,
  mochaPlugin.configs.recommended,
  importXConfigs.recommended,
  pluginPromise.configs["flat/recommended"],
  {
    files: ["**/*.{cjs,mjs,js}"],
    settings: {
      // import-x cannot statically resolve prettier's exports map.
      "import-x/ignore": ["prettier"],
    },
    languageOptions: {
      ecmaVersion: "latest",
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
      "import-x/no-unresolved": "error",
      "import-x/named": "off", //temp
      "import-x/default": "error",
      "import-x/namespace": "error",
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
