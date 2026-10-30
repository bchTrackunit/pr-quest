import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import { basename } from 'node:path';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

/** `as const` and `as unknown` don't hide a type, so they are allowed. */
function isAllowedTypeAssertion(typeAnnotation) {
  if (typeAnnotation.type === 'TSUnknownKeyword') {
    return true;
  }
  return (
    typeAnnotation.type === 'TSTypeReference' &&
    typeAnnotation.typeName.type === 'Identifier' &&
    typeAnnotation.typeName.name === 'const'
  );
}

const local = {
  rules: {
    'no-type-assertion': {
      meta: {
        type: 'suggestion',
        docs: { description: 'Disallow `as` and angle-bracket type assertions, which bypass type checking.' },
        messages: {
          asAssertion: 'Avoid using the `as` keyword for type casting. It bypasses type checking.',
          angleBracketAssertion: 'Avoid using angle bracket for type casting. It bypasses type checking.',
        },
        schema: [],
      },
      create(context) {
        return {
          TSAsExpression(node) {
            if (!isAllowedTypeAssertion(node.typeAnnotation)) {
              context.report({ node, messageId: 'asAssertion' });
            }
          },
          TSTypeAssertion(node) {
            if (!isAllowedTypeAssertion(node.typeAnnotation)) {
              context.report({ node, messageId: 'angleBracketAssertion' });
            }
          },
        };
      },
    },
    'no-barrel-files': {
      meta: {
        type: 'problem',
        docs: { description: 'Disallow index.ts barrel files; import from the module that defines the code.' },
        messages: {
          noBarrel: 'Barrel files are not allowed. Import from the module that defines the code instead.',
        },
        schema: [],
      },
      create(context) {
        return {
          Program(node) {
            const name = basename(context.filename);
            if (name === 'index.ts' || name === 'index.tsx') {
              context.report({ node, messageId: 'noBarrel' });
            }
          },
        };
      },
    },
  },
};

export default defineConfig([
  { ignores: ['dist/**', 'coverage/**', '.yarn/**'] },
  js.configs.recommended,
  {
    rules: {
      'constructor-super': 'error',
      'default-case': 'error',
      eqeqeq: ['error', 'always'],
      'no-caller': 'error',
      'no-console': 'error',
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'no-empty': 'error',
      'no-eval': 'error',
      'no-multiple-empty-lines': ['error', { max: 1 }],
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'react-dom/test-utils', message: "Please use 'act' from @testing-library/react instead." }],
        },
      ],
      'no-template-curly-in-string': 'error',
      'no-undef-init': 'error',
      'no-unreachable': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'prefer-spread': 'error',
      'prefer-template': 'error',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { local },
    rules: {
      'local/no-barrel-files': 'error',
      'local/no-type-assertion': 'warn',
      'no-restricted-syntax': [
        'warn',
        { selector: 'TSEnumDeclaration', message: 'Please use string literal union or objects instead of enums.' },
      ],
      '@typescript-eslint/array-type': ['error', { default: 'generic' }],
      '@typescript-eslint/await-thenable': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/dot-notation': 'error',
      '@typescript-eslint/explicit-member-accessibility': ['error', { accessibility: 'explicit' }],
      '@typescript-eslint/member-ordering': 'error',
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'interface', format: ['PascalCase'], custom: { regex: '^I[A-Z]', match: false } },
        { selector: 'typeParameter', format: ['PascalCase'], custom: { regex: '^(T|Keys?)[A-Z][a-zA-Z]+$', match: true } },
      ],
      '@typescript-eslint/no-empty-function': 'error',
      '@typescript-eslint/no-empty-object-type': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-inferrable-types': 'error',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-redeclare': 'error',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-restricted-types': [
        'error',
        {
          types: {
            'React.FC': { message: 'Please use props interface or type instead.' },
            FC: { message: 'Please use props interface or type instead.' },
          },
        },
      ],
      '@typescript-eslint/no-shadow': ['error', { hoist: 'all' }],
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-unused-expressions': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/strict-boolean-expressions': [
        'warn',
        { allowNullableBoolean: true, allowNullableString: true },
      ],
      '@typescript-eslint/unified-signatures': 'error',
    },
  },
  {
    files: ['src/ui/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/unsupported-syntax': 'error',
      'react-hooks/incompatible-library': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'no-restricted-globals': [
        'error',
        { name: 'localStorage', message: 'Use browserStorage() in src/ui/useBoardView.ts, the one storage access point.' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'window',
          property: 'localStorage',
          message: 'Use browserStorage() in src/ui/useBoardView.ts, the one storage access point.',
        },
      ],
    },
  },
  {
    files: ['src/**/*.test.{ts,tsx}'],
    rules: { 'no-restricted-properties': 'off' },
  },
]);
