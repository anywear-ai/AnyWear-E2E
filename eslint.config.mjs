import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'playwright-report/**', 'test-results/**', 'blob-report/**', 'AnyWear-Service/**', '.infra-source/**', '.e2e-inputs/**'],
  },
  {
    files: ['**/*.mjs'],
    extends: [eslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
  },
  {
    files: ['**/*.ts'],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
);
