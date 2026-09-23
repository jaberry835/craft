import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ProjectRegistry } from '../projectRegistry.js';

const testRoot = path.join(process.cwd(), '.test-data', 'project-registry');

test('managed projects are seeded, selected, collision-safe, and restored', async (t) => {
  await rm(testRoot, { recursive: true, force: true });
  t.after(() => rm(testRoot, { recursive: true, force: true }));

  const templateRoot = path.join(testRoot, 'template');
  const templatePackage = path.join(
    templateRoot,
    '.github',
    'skills',
    'initialize-security-package',
    'assets',
    'security-package-template'
  );
  const configPath = path.join(testRoot, 'config', 'projects.json');
  const statePath = path.join(testRoot, 'data', 'projects.json');
  const managedRoot = path.join(testRoot, 'data', 'workspaces');

  await mkdir(templatePackage, { recursive: true });
  await mkdir(path.join(templateRoot, '.github', 'agents'), { recursive: true });
  await mkdir(path.join(templateRoot, '.vscode'), { recursive: true });
  await writeFile(path.join(templatePackage, 'package-config.json'), JSON.stringify({
    packageName: 'Template',
    systemName: 'Template system'
  }), 'utf8');
  await writeFile(path.join(templateRoot, '.github', 'agents', 'builder.agent.md'), '# Builder\n', 'utf8');
  await writeFile(path.join(templateRoot, '.vscode', 'mcp.json'), '{"servers":{}}\n', 'utf8');
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    activeProjectId: 'template',
    projects: [{ id: 'template', name: 'Template', rootPath: templateRoot }]
  }), 'utf8');

  const registry = await ProjectRegistry.load(configPath, { statePath, managedRoot });
  const created = await registry.create({
    name: 'FedRAMP Package',
    description: 'Authorization package for the demonstration.',
    systemName: 'Demo System'
  });
  assert.equal(created.id, 'fedramp-package');
  assert.equal(created.active, true);

  const packageConfig = JSON.parse(await readFile(
    path.join(created.rootPath, 'security-package', 'package-config.json'),
    'utf8'
  )) as { packageName: string; systemName: string };
  assert.deepEqual(packageConfig, {
    packageName: 'FedRAMP Package',
    systemName: 'Demo System'
  });
  assert.match(await readFile(path.join(created.rootPath, 'README.md'), 'utf8'), /FedRAMP Package/);
  assert.equal(await readFile(
    path.join(created.rootPath, '.github', 'agents', 'builder.agent.md'),
    'utf8'
  ), '# Builder\n');

  const collision = await registry.create({ name: 'FedRAMP Package' });
  assert.equal(collision.id, 'fedramp-package-2');
  await registry.select('fedramp-package');

  const restored = await ProjectRegistry.load(configPath, { statePath, managedRoot });
  assert.equal(restored.list().activeProjectId, 'fedramp-package');
  assert.deepEqual(
    restored.list().projects.map((project) => project.id),
    ['template', 'fedramp-package', 'fedramp-package-2']
  );
});

