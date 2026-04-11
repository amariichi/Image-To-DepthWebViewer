import js from "@eslint/js";
import globals from "globals";

const webxrGlobals = {
  DecompressionStream: "readonly",
  OffscreenCanvas: "readonly",
  XRInputSourceEvent: "readonly",
  XRReferenceSpace: "readonly",
  XRWebGLLayer: "readonly",
};

export default [
  {
    ignores: ["node_modules/**", "third_party/**"],
  },
  js.configs.recommended,
  {
    files: ["webapp/src/**/*.js"],
    languageOptions: {
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...webxrGlobals,
      },
    },
    rules: {
      "no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
    },
  },
  {
    files: ["scripts/check-js.mjs", "eslint.config.js"],
    languageOptions: {
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
  },
];
