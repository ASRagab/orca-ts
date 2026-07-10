import js from "@eslint/js";
import boundaries from "eslint-plugin-boundaries";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "openspec/**",
      "fixtures/**",
      "website/.astro/**",
      "website/dist/**",
      ".orca/**",
      "skills/**/assets/templates/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    extends: [tseslint.configs.disableTypeChecked]
  },
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
      "boundaries/dependency-nodes": ["import"],
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
      "boundaries/dependencies": [
        "error",
        {
          "default": "allow",
          "rules": [
            {
              "from": { "type": "model" },
              "disallow": [
                {
                  "to": {
                    "type": [
                      "conversation",
                      "flow",
                      "tools",
                      "backends",
                      "runner",
                      "cli",
                      "testing"
                    ]
                  }
                }
              ]
            },
            {
              "from": { "type": "conversation" },
              "disallow": [
                {
                  "to": {
                    "type": ["flow", "tools", "backends", "runner", "cli"]
                  }
                }
              ]
            }
          ]
        }
      ]
    }
  }
);
