import { execFileSync } from 'node:child_process';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const distRoot = path.join(repositoryRoot, 'dist');

const omitLocalPlaywright = {
  name: 'omit-local-playwright',
  setup(buildContext) {
    buildContext.onResolve({ filter: /^playwright-core$/ }, () => ({
      path: 'playwright-core',
      namespace: 'aaa-container-stub'
    }));
    buildContext.onLoad({ filter: /.*/, namespace: 'aaa-container-stub' }, () => ({
      contents: `
        export const chromium = {
          launchPersistentContext() {
            throw new Error('Local Playwright is not included in the container runtime. Use AAA_BROWSER_MODE=bridge or disabled.');
          }
        };
      `,
      loader: 'js'
    }));
  }
};

for (const directory of ['runtime', 'container', 'server', 'src', 'config', 'template']) {
  await rm(path.join(distRoot, directory), { recursive: true, force: true });
}
await mkdir(path.join(distRoot, 'config'), { recursive: true });

const bundleResult = await build({
  entryPoints: [path.join(repositoryRoot, 'server', 'index.ts')],
  outfile: path.join(distRoot, 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'bundle',
  plugins: [omitLocalPlaywright],
  metafile: true,
  define: {
    'process.env.WS_NO_BUFFER_UTIL': '"1"',
    'process.env.WS_NO_UTF_8_VALIDATE': '"1"'
  },
  sourcemap: true,
  legalComments: 'none',
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"
  }
});

const nodeBuiltins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const playwrightInputs = Object.keys(bundleResult.metafile.inputs)
  .filter((input) => /(^|[/\\])node_modules[/\\](playwright(?:-core)?|@playwright)([/\\]|$)/.test(input));
if (playwrightInputs.length > 0) {
  throw new Error(`Container runtime must not bundle Playwright: ${playwrightInputs.join(', ')}`);
}
const unresolvedPackages = Object.values(bundleResult.metafile.outputs)
  .flatMap((output) => output.imports)
  .filter((entry) => entry.external && !nodeBuiltins.has(entry.path))
  .map((entry) => entry.path);
if (unresolvedPackages.length > 0) {
  throw new Error(`Server bundle contains unresolved runtime packages: ${[...new Set(unresolvedPackages)].join(', ')}`);
}

await Promise.all([
  cp(path.join(repositoryRoot, 'templates', 'default-project'), path.join(distRoot, 'template'), { recursive: true }),
  cp(path.join(repositoryRoot, 'config', 'agent-connections.json'), path.join(distRoot, 'config', 'agent-connections.json')),
  writeFile(path.join(distRoot, 'config', 'projects.json'), '{"projects":[]}\n', 'utf8'),
  writeFile(path.join(distRoot, 'package.json'), '{"private":true,"type":"module"}\n', 'utf8')
]);

let commit = null;
try {
  commit = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim();
} catch {
  // A source archive may not include Git metadata.
}

await writeFile(path.join(distRoot, 'artifact-manifest.json'), `${JSON.stringify({
  builtAtUtc: new Date().toISOString(),
  nodeVersion: process.version,
  commit
}, null, 2)}\n`, 'utf8');

console.log(`Self-contained runtime created at ${distRoot}`);