import js from "@eslint/js";
import boundaries from "eslint-plugin-boundaries";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    plugins: {
      boundaries
    },
    settings: {
      "boundaries/elements": [
        { "type": "model", "pattern": "src/model/*" },
        { "type": "conversation", "pattern": "src/conversation/*" },
        { "type": "flow", "pattern": "src/flow/*" },
        { "type": "tools", "pattern": "src/tools/*" },
        { "type": "backends", "pattern": "src/backends/*" },
        { "type": "runner", "pattern": "src/runner/*" },
        { "type": "cli", "pattern": "src/cli/*" },
        { "type": "testing", "pattern": "src/test-utils/*" }
      ]
    },
    rules: {
      "boundaries/element-types": [
        "error",
        {
          "default": "allow",
          "rules": [
            {
              "from": "model",
              "disallow": [
                "conversation",
                "flow",
                "tools",
                "backends",
                "runner",
                "cli",
                "testing"
              ]
            },
            {
              "from": "conversation",
              "disallow": [
                "flow",
                "tools",
                "backends",
                "runner",
                "cli"
              ]
            }
          ]
        }
      ]
    }
  },
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "openspec/**",
      "fixtures/**"
    ]
  }
);
