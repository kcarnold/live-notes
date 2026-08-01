
import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'macos-audio-feeder/.build'] },
  {
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      //...tseslint.configs.strictTypeChecked,
      //...tseslint.configs.stylisticTypeChecked,
    ],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: { react: { version: '19.1' } },
    plugins: {
      react,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...react.configs.recommended.rules,
      ...react.configs['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
  {
    // Backend TS files (server.ts, nlp.ts, live-audio/*) aren't part of any tsconfig project;
    // disable type-aware rules and clear the project setting to avoid parse errors.
    // TODO: sometime we should type-check these too.
    files: ['*.ts', 'live-audio/**/*.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: {
        project: false,
      },
    },
  },
  {
    // These same backend files are executed by `node server.ts` (see package.json), which
    // runs TypeScript in *strip-only* mode: it erases types but never generates code. A
    // constructor parameter property needs desugaring, not erasure, so Node rejects the
    // file outright and the server dies at import with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
    // Nothing else catches this — tsc, vitest (esbuild) and eslint all accept it happily —
    // so a green CI can still ship a server that won't boot. Hence a lint rule.
    // Test files are exempt: they only ever run under vitest, which transpiles fully.
    files: ['*.ts', 'live-audio/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/parameter-properties': ['error', { prefer: 'class-property' }],
    },
  },
)
