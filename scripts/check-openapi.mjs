#!/usr/bin/env node
/**
 * Fails when the implemented routes and docs/openapi.yaml disagree.
 *
 * §B5 calls that disagreement a release blocker, and it had drifted eighteen
 * paths before anything noticed, because nothing was checking. A contract that
 * drifted once will drift again, so the check belongs in CI rather than in a
 * reviewer's attention.
 *
 * The route table is read from source rather than by booting the app: the
 * server needs a database and a validated environment to start, and a contract
 * check should not need either. The trade is that this reads the two things
 * that can go stale, the mount table in routes/index.ts and the handler calls
 * in each route module, so both are parsed rather than assumed.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const routesDir = join(root, 'apps', 'server', 'src', 'routes');
const specPath = join(root, 'docs', 'openapi.yaml');

/** Router variable to the prefix it is mounted at, parsed from routes/index.ts. */
function readMounts() {
  const source = readFileSync(join(routesDir, 'index.ts'), 'utf8');
  const mounts = new Map();
  for (const match of source.matchAll(/apiRouter\.use\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/g)) {
    mounts.set(match[2], match[1]);
  }
  return mounts;
}

/** Every `<router>.<method>('<path>'` in the route modules, resolved to a full path. */
function readRoutes(mounts) {
  const found = new Map();
  for (const file of readdirSync(routesDir)) {
    if (!file.endsWith('.ts') || file === 'index.ts') continue;
    const source = readFileSync(join(routesDir, file), 'utf8');
    for (const match of source.matchAll(/(\w+Router)\.(get|post|put|delete)\(\s*\n?\s*'([^']*)'/g)) {
      const [, router, method, path] = match;
      const base = mounts.get(router);
      if (base === undefined) {
        throw new Error(
          `${file} registers on "${router}", which routes/index.ts does not mount. ` +
            'Either mount it or the route is unreachable.',
        );
      }
      const full = (base + (path === '/' ? '' : path)).replace(/:(\w+)/g, '{}') || '/';
      if (!found.has(full)) found.set(full, new Set());
      found.get(full).add(method.toUpperCase());
    }
  }
  return found;
}

/** Top-level keys under `paths:`. Structural, so it needs no YAML parser. */
function readSpecPaths() {
  const spec = readFileSync(specPath, 'utf8');
  const paths = new Set();
  for (const match of spec.matchAll(/^ {2}(\/[^\s:]*):/gm)) {
    paths.add(match[1].replace(/\{[^}]+\}/g, '{}'));
  }
  return paths;
}

const mounts = readMounts();
const implemented = readRoutes(mounts);
const documented = readSpecPaths();

const undocumented = [...implemented.keys()].filter((p) => !documented.has(p)).sort();
const phantom = [...documented].filter((p) => !implemented.has(p)).sort();

if (undocumented.length === 0 && phantom.length === 0) {
  console.log(`openapi.yaml matches the router: ${implemented.size} paths.`);
  process.exit(0);
}

if (undocumented.length > 0) {
  console.error(`\n${undocumented.length} implemented path(s) missing from docs/openapi.yaml:`);
  for (const path of undocumented) {
    console.error(`  ${[...implemented.get(path)].sort().join(',')} ${path}`);
  }
}

if (phantom.length > 0) {
  console.error(`\n${phantom.length} documented path(s) with no route behind them:`);
  for (const path of phantom) console.error(`  ${path}`);
}

console.error('\n§B5: the API contract and the implementation disagreeing is a release blocker.');
process.exit(1);
