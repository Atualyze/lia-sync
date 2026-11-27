import js from '@eslint/js';
import globals from 'globals';

// Regras de classe "bug" (variável indefinida, chave duplicada, auto-atribuição) falham o lint.
// As demais regras do conjunto recomendado ficam como aviso: há uma dívida histórica conhecida e
// o teto de avisos em `npm run lint:eslint` impede que ela cresça (reduza o teto ao limpar).
const legacyWarnings = {
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
  'no-empty': ['warn', { allowEmptyCatch: true }],
  'no-useless-assignment': 'warn',
  'no-useless-escape': 'warn',
  'no-control-regex': 'warn',
  'no-misleading-character-class': 'warn'
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
