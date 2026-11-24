import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores([
    "dist",
    "coverage",
    ".old",
    ".v2-extras",
    "public",
    "src/routeTree.gen.ts",
  ]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      "react-refresh/only-export-components": [
        "error",
        {
          allowConstantExport: true,
          allowExportNames: ["useTheme"],
        },
      ],
    },
  },
  {
    // File routes co-export `Route` with their component; this rule only guards Fast Refresh.
    files: ["src/routes/**/*.{ts,tsx}"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
  {
    // TanStack Virtual returns functions the React Compiler will not memoize.
    files: [
      "src/components/metric-evidence-people.tsx",
      "src/components/metric-evidence-table.tsx",
      "src/components/portal/usage-table.tsx",
    ],
    rules: {
      "react-hooks/incompatible-library": "off",
    },
  },
  {
    files: ["src/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Literal[value=/(^|[\\s:])text-\\[[0-9.]+(px|rem)\\]/]",
          message:
            "Hand-set text size. Use a role from src/lib/type-scale.ts, or add one there if none fits.",
        },
        {
          selector:
            "Literal[value=/(^|[\\s:])text-(muted-)?foreground\\/[0-9]/]",
          message:
            "Fractional text grey. There are two: text-foreground and text-muted-foreground.",
        },
        {
          selector:
            "Literal[value=/(^|[\\s:])text-((slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]|(black|white)\\b)/]",
          message:
            "Raw palette colour. Good/bad is text-success and text-destructive; text-warning is attention without a verdict.",
        },
      ],
    },
  },
]);
