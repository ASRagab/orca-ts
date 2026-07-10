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
        { "type": "model", "pattern": "src/model/*", "mode": "full" },
        { "type": "conversation", "pattern": "src/conversation/*", "mode": "full" },
        { "type": "flow", "pattern": "src/flow/*", "mode": "full" },
        { "type": "tools", "pattern": "src/tools/*", "mode": "full" },
        { "type": "backends", "pattern": "src/backends/*", "mode": "full" },
        { "type": "runner", "pattern": "src/runner/*", "mode": "full" },
        { "type": "cli", "pattern": "src/cli/*", "mode": "full" },
        { "type": "testing", "pattern": "src/test-utils/*", "mode": "full" }
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
