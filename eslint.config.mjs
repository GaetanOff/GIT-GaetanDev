import js from '@eslint/js'
import svelte from 'eslint-plugin-svelte'
import globals from 'globals'
import ts from 'typescript-eslint'
import svelteConfig from './svelte.config.mjs'

export default ts.config(
  { ignores: ['out/', 'release/', 'node_modules/', 'build/'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // Empty catch blocks carry a comment saying why the error does not matter.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Sets and Maps in state are replaced, never mutated in place, so plain ones are right here.
      'svelte/prefer-svelte-reactivity': 'off',
      // Keys go on lists whose items move; static lists (menus, settings, shortcuts) need none.
      'svelte/require-each-key': 'off',
      // {' '} keeps an empty line of a <pre> one line high.
      'svelte/no-useless-mustaches': 'off',
    },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: { parserOptions: { parser: ts.parser, extraFileExtensions: ['.svelte'], svelteConfig } },
  },
  {
    // Build scripts run as CommonJS.
    files: ['scripts/**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      // The Svelte plugin's version of this rule crashes on CommonJS files; they hold no Svelte code.
      'svelte/no-inner-declarations': 'off',
    },
  },
)
