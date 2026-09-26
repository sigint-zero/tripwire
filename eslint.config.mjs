import js from "@eslint/js";
import pluginQuery from "@tanstack/eslint-plugin-query";
import pluginRouter from "@tanstack/eslint-plugin-router";
import prettier from "eslint-config-prettier";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["**/dist/"]),

  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // vite.config.ts is checked by its own tsconfig, not the app's.
          allowDefaultProject: [
            "packages/web/vite.config.ts",
            "packages/server/vitest.config.ts",
          ],
          defaultProject: "packages/web/tsconfig.node.json",
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.{js,mjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // The dashboard runs in the browser; everything else runs in Node.
  {
    files: ["packages/web/src/**/*.{ts,tsx}"],
    extends: [
      reactHooks.configs.flat.recommended,
      jsxA11y.flatConfigs.recommended,
      pluginQuery.configs["flat/recommended"],
      pluginRouter.configs["flat/recommended"],
    ],
    languageOptions: { globals: globals.browser },
    rules: {
      // TanStack Router redirects by throwing redirect(), a Response.
      "@typescript-eslint/only-throw-error": [
        "error",
        {
          allow: [
            {
              from: "package",
              package: "@tanstack/router-core",
              name: "Redirect",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.{ts,mjs}"],
    ignores: ["packages/web/src/**"],
    languageOptions: { globals: globals.node },
  },

  prettier,
);
