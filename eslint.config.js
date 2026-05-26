import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.tsbuildinfo",
      "**/build/**",
      "apps/web/public/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "no-console": ["error", { allow: ["error", "warn"] }],
      complexity: ["error", 10],
      "max-depth": ["error", 4],
      "max-lines-per-function": ["error", { max: 120, skipBlankLines: true, skipComments: true }],
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/scripts/**"],
    rules: {
      "no-console": "off",
      "max-lines-per-function": "off",
      complexity: "off",
    },
  },
  {
    files: ["apps/server/src/migrate.ts", "apps/server/src/index.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["**/*.config.js", "**/*.config.ts"],
    rules: {
      "max-lines-per-function": "off",
    },
  },
);
