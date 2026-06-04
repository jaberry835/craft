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
    // Provide a CommonJS `require` shim for any bundled CJS module that
    // reaches for it. Do not redeclare `__dirname` / `__filename` here —
    // bundled modules declare their own at module scope and a top-level
    // declaration would collide.
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"
  }
});

console.log('Server bundle written to dist/server/index.js');
