import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
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

for (const directory of ['runtime', 'container', 'server', 'src', 'config', 'template', 'node_modules']) {
  await rm(path.join(distRoot, directory), { recursive: true, force: true });
}
await mkdir(path.join(distRoot, 'config'), { recursive: true });

const dependencyPaths = execFileSync(
  process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm',
  process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm ls --omit=dev --all --parseable']
    : ['ls', '--omit=dev', '--all', '--parseable'],
  { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
).trim().split(/\r?\n/).filter((entry) => path.resolve(entry) !== repositoryRoot);
for (const source of new Set(dependencyPaths)) {
  const relative = path.relative(repositoryRoot, source);
  if (!relative.startsWith(`node_modules${path.sep}`)) {
    throw new Error(`Runtime dependency must be installed inside node_modules: ${source}`);
  }
  const metadata = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  if (/^(playwright(?:-core)?|@playwright\/)/.test(metadata.name)) {
    throw new Error(`Playwright must remain a development-only dependency: ${metadata.name}`);
  }
  await cp(source, path.join(distRoot, relative), {
    recursive: true,
    filter: (entry) => !path.relative(source, entry).split(path.sep).includes('node_modules')
  });
}
const stagedEntries = await readdir(path.join(distRoot, 'node_modules'), { recursive: true });
if (stagedEntries.some((entry) => entry.endsWith('.node'))) {
  throw new Error('Runtime dependencies contain native addons. Stage dependencies on the target container platform instead.');
}

const bundleResult = await build({
  entryPoints: [path.join(repositoryRoot, 'server', 'index.ts')],
  outfile: path.join(distRoot, 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
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
const runtimeRequire = createRequire(path.join(distRoot, 'index.js'));
const runtimePackages = Object.values(bundleResult.metafile.outputs)
  .flatMap((output) => output.imports)
  .filter((entry) => entry.external && !nodeBuiltins.has(entry.path))
  .map((entry) => entry.path);
for (const specifier of new Set(runtimePackages)) {
  const resolved = runtimeRequire.resolve(specifier);
  if (!resolved.startsWith(path.join(distRoot, 'node_modules') + path.sep)) {
    throw new Error(`Runtime package resolves outside the artifact: ${specifier}`);
  }
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