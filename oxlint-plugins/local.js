import { basename, dirname, relative, resolve } from 'node:path';

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

/**
 * Where a file under `src/` sits: `shared`, `platform`, `app` or one feature, and which runtime
 * (`server`, `ui`) it belongs to. Returns undefined for files outside `src/`.
 */
function locate(path, cwd) {
  const rel = relative(cwd, path).split('\\').join('/');
  if (!rel.startsWith('src/')) {
    return undefined;
  }
  const [, top, second, third] = rel.split('/');
  if (top === 'features') {
    return { layer: 'feature', feature: second, side: third, rel };
  }
  return { layer: top, side: top === 'shared' ? undefined : second, rel };
}

const isTestFile = (path) => /\.test\.tsx?$/.test(path);

/** Why `importer` may not import `target`, or undefined when it may. */
function boundaryViolation(importer, target, importerIsTest) {
  if (importer.side && target.side && importer.side !== target.side) {
    return 'crossSide';
  }
  if (target.layer === 'shared' || target.layer === 'platform') {
    return importer.layer === 'shared' && target.layer !== 'shared' ? 'sharedImport' : undefined;
  }
  if (target.layer === 'app') {
    return importer.layer === 'app' ? undefined : 'appImport';
  }
  if (target.layer !== 'feature') {
    return undefined;
  }
  if (importer.layer === 'shared' || importer.layer === 'platform') {
    return 'featureFromBase';
  }
  if (importer.layer === 'feature' && importer.feature === target.feature) {
    return undefined;
  }
  const entry = `src/features/${target.feature}/${target.side}/index.ts`;
  if (target.rel === entry) {
    return undefined;
  }
  if (importerIsTest && target.rel.includes('/test-utils/')) {
    return undefined;
  }
  return 'deepImport';
}

export default {
  meta: { name: 'local' },
  rules: {
    'feature-boundaries': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Keep imports between features, platform, shared and app code inside the dependency rules in the README.',
        },
        messages: {
          deepImport:
            "Import another feature through its public entry, src/features/{{feature}}/{{side}}/index.ts, not '{{source}}'.",
          featureFromBase: 'src/platform and src/shared must not import from features.',
          appImport: 'Only src/app may import from src/app; it is the composition root.',
          sharedImport: 'src/shared may only import from src/shared.',
          crossSide:
            'UI code and server code must not import each other; share code through src/shared.',
        },
        schema: [],
      },
      create(context) {
        const cwd = context.cwd ?? process.cwd();
        const importer = locate(context.filename, cwd);
        if (importer === undefined) {
          return {};
        }
        const importerIsTest = isTestFile(context.filename);
        const check = (sourceNode) => {
          if (sourceNode?.type !== 'Literal' || typeof sourceNode.value !== 'string') {
            return;
          }
          const source = sourceNode.value;
          if (!source.startsWith('.')) {
            return;
          }
          const target = locate(resolve(dirname(context.filename), source), cwd);
          if (target === undefined) {
            return;
          }
          const messageId = boundaryViolation(importer, target, importerIsTest);
          if (messageId !== undefined) {
            context.report({
              node: sourceNode,
              messageId,
              data: { feature: target.feature, side: target.side, source },
            });
          }
        };
        return {
          ImportDeclaration: (node) => check(node.source),
          ExportNamedDeclaration: (node) => check(node.source),
          ExportAllDeclaration: (node) => check(node.source),
          ImportExpression: (node) => check(node.source),
        };
      },
    },
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
