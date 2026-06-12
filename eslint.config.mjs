/**
 * ESLint flat config (ESLint 9+).
 *
 * Next 16 deprecated `next lint`, and `eslint-config-next` v16 requires ESLint
 * 9's flat config. This bridges the existing shareable configs
 * (`next/core-web-vitals` + `prettier`, previously in `.eslintrc.json`) into the
 * flat format via `FlatCompat`, so linting behaviour is unchanged.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const __dirname = dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  ...compat.extends('next/core-web-vitals', 'prettier'),
  {
    ignores: ['.next/**', 'node_modules/**'],
  },
];

export default eslintConfig;
