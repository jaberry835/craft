import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ProjectCustomizationService } from '../projectCustomizationService.js';
import { ProjectWorkflowService } from '../projectWorkflowService.js';

const root = path.join(process.cwd(), '.test-data', 'instructions');

async function project() {
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, '.github', 'instructions'), { recursive: true });
  await mkdir(path.join(root, '.github', 'prompts'), { recursive: true });
  await writeFile(path.join(root, '.github', 'copilot-instructions.md'), '# Falcon package rules\n\nCite NIST SP 800-53 Rev. 5 control IDs exactly.\n');
  await writeFile(path.join(root, '.github', 'instructions', 'ssp.instructions.md'),
    '---\ndescription: "SSP writing style"\napplyTo: "security-package/**/*.md"\n---\n\nWrite control responses in the present tense.\n');
  await writeFile(path.join(root, '.github', 'prompts', 'review.prompt.md'),
    '---\ndescription: "Review the package"\n---\n\nReview every control response.\n');
}

test('instruction files are discovered, enabled by default, and injected into the system prompt', async (t) => {
  await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const items = (await new ProjectCustomizationService('demo', root).list()).items.filter((item) => item.kind === 'instruction');
  assert.deepEqual(items.map((item) => [item.id, item.enabled, item.detail]), [
    ['instruction:copilot-instructions.md', true, 'Applies to every request'],
    ['instruction:instructions/ssp.instructions.md', true, 'Applies to security-package/**/*.md'],
    ['instruction:review.prompt.md', true, 'Prompt file · run as /review']
  ]);
  assert.equal(items[0]!.description, 'Falcon package rules');

  const workflow = await new ProjectWorkflowService('demo', root).load();
  assert.deepEqual(workflow.instructions.map((instruction) => [instruction.name, instruction.applyTo]), [
    ['Repository instructions', undefined],
    ['Ssp', 'security-package/**/*.md']
  ]);
  assert.deepEqual(workflow.prompts.map((prompt) => prompt.id), ['review']);
  const system = ProjectWorkflowService.systemPrompt({
    projectName: 'Falcon',
    skills: workflow.skills,
    tools: ProjectWorkflowService.selectTools(workflow),
    instructions: workflow.instructions
  });
  assert.match(system, /# Project instructions[\s\S]*## Repository instructions\n# Falcon package rules[\s\S]*Cite NIST SP 800-53/);
  assert.match(system, /## Ssp \(applies to files matching security-package\/\*\*\/\*\.md\)\nWrite control responses in the present tense\./);
});

test('disabling an instruction or prompt file removes it from the next run', async (t) => {
  await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const customizations = new ProjectCustomizationService('demo', root);
  await customizations.setEnabled('instruction:copilot-instructions.md', false);
  await customizations.setEnabled('instruction:review.prompt.md', false);
  const workflow = await new ProjectWorkflowService('demo', root).load();
  assert.deepEqual(workflow.instructions.map((instruction) => instruction.id), ['instruction:instructions/ssp.instructions.md']);
  assert.deepEqual(workflow.prompts, []);
  assert.equal((await new ProjectWorkflowService('demo', root).summary()).commands.some((command) => command.name === 'review'), false);
});

test('instruction files can be created and edited, and repository instructions stay plain Markdown', async (t) => {
  await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const customizations = new ProjectCustomizationService('demo', root);
  const created = await customizations.create({
    kind: 'instruction',
    name: 'Evidence Naming',
    description: 'How to name evidence files',
    enabled: true,
    applyTo: 'evidence/**',
    instructions: 'Name evidence files <control>-<artifact>.<ext>.'
  });
  assert.equal(created.id, 'instruction:instructions/evidence-naming.instructions.md');
  assert.equal(created.applyTo, 'evidence/**');
  assert.equal(
    await readFile(path.join(root, '.github', 'instructions', 'evidence-naming.instructions.md'), 'utf8'),
    '---\nname: "Evidence Naming"\ndescription: "How to name evidence files"\napplyTo: "evidence/**"\n---\n\nName evidence files <control>-<artifact>.<ext>.\n'
  );

  await customizations.update(created.id!, { ...created, kind: 'instruction', applyTo: '', instructions: 'Applies everywhere now.' });
  const updated = await readFile(path.join(root, '.github', 'instructions', 'evidence-naming.instructions.md'), 'utf8');
  assert.doesNotMatch(updated, /applyTo/);
  assert.match(updated, /Applies everywhere now\./);

  const repository = await customizations.getEditor('instruction:copilot-instructions.md');
  assert.equal(repository.applyTo, undefined);
  await customizations.update(repository.id!, { ...repository, kind: 'instruction', instructions: '# Falcon package rules\n\nUse Rev. 5 baselines.' });
  assert.equal(await readFile(path.join(root, '.github', 'copilot-instructions.md'), 'utf8'), '# Falcon package rules\n\nUse Rev. 5 baselines.\n');

  const prompt = await customizations.getEditor('instruction:review.prompt.md');
  assert.equal(prompt.argumentHint, '');
  assert.equal(prompt.applyTo, undefined);
  assert.equal(prompt.instructions, 'Review every control response.');
});
