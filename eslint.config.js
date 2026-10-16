import js from "@eslint/js"
import react from "eslint-plugin-react"
import reactHooks from "eslint-plugin-react-hooks"
import tseslint from "typescript-eslint"

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/*.gen.ts",
      "**/routeTree.gen.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      react,
      "react-hooks": reactHooks,
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    languageOptions: {
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      quotes: ["error", "double", { avoidEscape: true }],
      "react/react-in-jsx-scope": "off",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["apps/*/src/**/*.{ts,tsx,js,jsx}"],
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "JSXOpeningElement[name.name=/^(button|input|select|textarea)$/]",
          message:
            "Use the shared @conduit/ui control. Keep workflow state in the app.",
        },
        {
          selector:
            "JSXOpeningElement:has(> JSXAttribute[name.name='role'][value.value=/^(dialog|alertdialog|combobox|listbox|menu|menubar|tab|tablist)$/])",
          message:
            "Use @conduit/ui for shared keyboard, focus and overlay behavior.",
        },
      ],
    },
  },
]
