import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

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
 * Where a file sits: its workspace package (`apps/server`, `packages/contract`) and, inside an
 * app's `src/`, its layer: `app`, `platform` or one feature. `src/main.ts` belongs to `app`.
 * Returns undefined for files outside the packages.
 */
function locate(path, cwd) {
  const rel = relative(cwd, path).split('\\').join('/');
  const match = /^((?:apps|packages)\/[^/]+)\/(.*)$/.exec(rel);
  if (match === null) {
    return undefined;
  }
  const [, pkg, inner] = match;
  const parts = inner.split('/');
  if (!pkg.startsWith('apps/') || parts[0] !== 'src') {
    return { pkg, rel };
  }
  if (parts.length === 2) {
    return { pkg, layer: /^main\.tsx?$/.test(parts[1]) ? 'app' : undefined, rel };
  }
  if (parts[1] === 'features') {
    return { pkg, layer: 'feature', feature: parts[2], rel };
  }
  return { pkg, layer: parts[1], rel };
}

const isTestFile = (path) => /\.test\.tsx?$/.test(path);

/** Why `importer` may not import `target`, or undefined when it may. */
function boundaryViolation(importer, target, importerIsTest) {
  if (target === undefined || importer.pkg !== target.pkg) {
    return 'crossPackage';
  }
  if (target.layer === 'app') {
    return importer.layer === 'app' ? undefined : 'appImport';
  }
  if (target.layer !== 'feature') {
    return undefined;
  }
  if (importer.layer === 'platform') {
    return 'featureFromPlatform';
  }
  if (importer.layer === 'feature' && importer.feature === target.feature) {
    return undefined;
  }
  if (target.rel === `${target.pkg}/src/features/${target.feature}/index.ts`) {
    return undefined;
  }
  if (importerIsTest && target.rel.includes('/test-utils/')) {
    return undefined;
  }
  return 'deepImport';
}

/**
 * Which workspace packages each package may import. The server and the UI share code only through
 * the contract; a new edge is an architecture change, so it goes here and in the README.
 */
const PACKAGE_GRAPH = {
  'apps/server': ['@pr-quest/contract'],
  'apps/web': ['@pr-quest/contract'],
  'packages/contract': [],
};

const declaredDependencies = new Map();

/** The names in a package's `dependencies` and `devDependencies`; empty without a manifest. */
function dependenciesOf(pkg, cwd) {
  if (!declaredDependencies.has(pkg)) {
    const path = join(cwd, pkg, 'package.json');
    const manifest = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
    declaredDependencies.set(
      pkg,
      new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
      ]),
    );
  }
  return declaredDependencies.get(pkg);
}

/** `@pr-quest/contract` for `@pr-quest/contract/api`, or undefined for any other import. */
function workspacePackageName(source) {
  return /^@pr-quest\/[^/]+/.exec(source)?.[0];
}

/** Why `pkg` may not import the workspace package `name`, or undefined when it may. */
function packageViolation(pkg, name, cwd) {
  if (!(PACKAGE_GRAPH[pkg] ?? []).includes(name)) {
    return 'forbiddenPackage';
  }
  return dependenciesOf(pkg, cwd).has(name) ? undefined : 'undeclaredPackage';
}

export default {
  meta: { name: 'local' },
  rules: {
    'feature-boundaries': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Keep imports between packages, features, platform and app code inside the dependency rules in the README.',
        },
        messages: {
          deepImport:
            "Import another feature through its public entry, {{pkg}}/src/features/{{feature}}/index.ts, not '{{source}}'.",
          featureFromPlatform: 'platform/ must not import from features.',
          appImport:
            'Only app/ and src/main.ts may import from app/; they are the composition root.',
          crossPackage:
            "A relative import must stay inside its package; import '{{source}}' by package name, such as @pr-quest/contract/api.",
          forbiddenPackage:
            '{{pkg}} may not import {{name}}. The server and the UI share code only through @pr-quest/contract; see PACKAGE_GRAPH in oxlint-plugins/local.js.',
          undeclaredPackage: 'Add {{name}} to the dependencies in {{pkg}}/package.json.',
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
          const name = workspacePackageName(source);
          if (name !== undefined) {
            const messageId = packageViolation(importer.pkg, name, cwd);
            if (messageId !== undefined) {
              context.report({ node: sourceNode, messageId, data: { name, pkg: importer.pkg } });
            }
            return;
          }
          if (!source.startsWith('.')) {
            return;
          }
          const target = locate(resolve(dirname(context.filename), source), cwd);
          const messageId = boundaryViolation(importer, target, importerIsTest);
          if (messageId !== undefined) {
            context.report({
              node: sourceNode,
              messageId,
              data: { pkg: target?.pkg, feature: target?.feature, source },
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
