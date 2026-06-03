import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

await build({
  entryPoints: [path.join(repoRoot, 'server', 'index.ts')],
  outfile: path.join(repoRoot, 'dist', 'server', 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  // Node built-ins are external by default for platform=node.
  // Keep these external because they ship native/optional binaries that
  // esbuild cannot safely inline at build time.
  external: [
    'fsevents'
  ],
  banner: {
    // Provide CommonJS-style helpers some bundled deps reach for under ESM.
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __dirname_fn } from 'node:path';",
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __dirname_fn(__filename);"
    ].join('\n')
  }
});

console.log('Server bundle written to dist/server/index.js');
