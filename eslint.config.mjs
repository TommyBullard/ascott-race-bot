/**
 * ESLint flat config (ESLint 9+).
 *
 * `eslint-config-next` v16 ships a native ESLint 9 flat config, so we consume it
 * directly (its default export is a flat-config array). Previously this file
 * bridged it through `FlatCompat`/`@eslint/eslintrc`, but that legacy path runs
 * the flat config through the eslintrc schema validator, which crashes while
 * `JSON.stringify`-ing the plugin graph ("Converting circular structure to
 * JSON ... 'react' closes the circle"). Importing the flat config natively keeps
 * the same linting behaviour without that bridge. `eslint-config-prettier` is
 * applied last to switch off rules that conflict with Prettier formatting.
 */
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import prettier from 'eslint-config-prettier';

const eslintConfig = [
  ...nextCoreWebVitals,
  prettier,
  {
    ignores: ['.next/**', 'node_modules/**', 'references/**'],
  },
];

export default eslintConfig;
