import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      "**/.netlify/**",
      ".netlify/**",
      "netlify/functions/.netlify/**",
      "netlify/.netlify/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      sourceType: "module",
      globals: {
        ...globals.node,
        Netlify: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
        apiFetch: "readonly",
        checkAuth: "readonly",
        requireAuth: "readonly",
        showFlash: "readonly",
        escapeHtml: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-undef": "warn",
    },
  },
];
