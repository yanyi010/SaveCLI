import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-console': 'off',
      'prefer-const': 'error',
      'eqeqeq': ['error', 'smart'],
    },
  },
  {
    // Plain-JS launcher: Node globals, no TS rules.
    files: ['bin/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
)
