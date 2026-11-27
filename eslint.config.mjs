import js from '@eslint/js';
import globals from 'globals';

// Regras de classe "bug" (variável indefinida, chave duplicada, auto-atribuição) falham o lint.
// As demais regras do conjunto recomendado também falham o lint (dívida histórica zerada).
const legacyWarnings = {
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-useless-assignment': 'error',
  'no-useless-escape': 'error',
  'no-control-regex': 'error',
  'no-misleading-character-class': 'error'
};

export default [
  { ignores: ['node_modules/**', 'dist/**', 'data/**', 'public/vendor/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.mjs', 'scripts/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: { ecmaVersion: 2025, sourceType: 'module', globals: { ...globals.node } },
    rules: legacyWarnings
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 2025, sourceType: 'script', globals: { ...globals.browser } },
    rules: legacyWarnings
  }
];
