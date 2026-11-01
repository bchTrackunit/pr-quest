import { basename } from 'node:path';

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

export default {
  meta: { name: 'local' },
  rules: {
    'no-type-assertion': {
      meta: {
        type: 'suggestion',
        docs: {
          description:
            'Disallow `as` and angle-bracket type assertions, which bypass type checking.',
        },
        messages: {
          asAssertion: 'Avoid using the `as` keyword for type casting. It bypasses type checking.',
          angleBracketAssertion:
            'Avoid using angle bracket for type casting. It bypasses type checking.',
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
        docs: {
          description:
            'Disallow index.ts barrel files; import from the module that defines the code.',
        },
        messages: {
          noBarrel:
            'Barrel files are not allowed. Import from the module that defines the code instead.',
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
    'no-enum': {
      meta: {
        type: 'suggestion',
        docs: { description: 'Disallow TypeScript enums.' },
        messages: {
          noEnum: 'Please use string literal union or objects instead of enums.',
        },
        schema: [],
      },
      create(context) {
        return {
          TSEnumDeclaration(node) {
            context.report({ node, messageId: 'noEnum' });
          },
        };
      },
    },
  },
};
