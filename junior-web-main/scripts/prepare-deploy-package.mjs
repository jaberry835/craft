import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const distRoot = path.join(repoRoot, 'dist');
const packageRoot = path.join(repoRoot, '.deploy', 'package');

async function ensureExists(targetPath) {
  try {
    await fs.access(targetPath);
  } catch {
    throw new Error(`Required path not found: ${targetPath}`);
  }
}

async function main() {
  await ensureExists(path.join(distRoot, 'client'));
  await ensureExists(path.join(distRoot, 'server', 'index.js'));

  await fs.rm(packageRoot, { recursive: true, force: true });
  await fs.mkdir(packageRoot, { recursive: true });

  await fs.cp(path.join(distRoot, 'client'), path.join(packageRoot, 'client'), { recursive: true });
  await fs.cp(path.join(distRoot, 'server'), path.join(packageRoot, 'server'), { recursive: true });
  await fs.cp(path.join(repoRoot, 'config'), path.join(packageRoot, 'config'), { recursive: true });
  await fs.cp(path.join(repoRoot, 'data'), path.join(packageRoot, 'data'), { recursive: true });

  const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  // Server is bundled by esbuild; no runtime dependencies are required on the
  // App Service host. Ship a minimal package.json so `npm start` works without
  // any `npm install` step on the deployment target.
  const deploymentPackageJson = {
    name: packageJson.name,
    version: packageJson.version,
    private: true,
    type: 'module',
    scripts: {
      start: 'node server/index.js'
    }
  };

  await fs.writeFile(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify(deploymentPackageJson, null, 2)}\n`,
    'utf8'
  );

  console.log(`Deploy package staged at ${packageRoot}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
