import { describe, expect, it } from 'vitest';
import { normalizeCopilotCliConfiguredModels } from '../src/copilotCliSupport';

describe('normalizeCopilotCliConfiguredModels', () => {
    it('keeps models configured with id', () => {
        const models = normalizeCopilotCliConfiguredModels([
            { name: 'GPT-4.1', id: 'gpt-4.1' },
        ]);

        expect(models).toEqual([
            { name: 'GPT-4.1', deploymentId: 'gpt-4.1' },
        ]);
    });

    it('accepts legacy deploymentId-shaped entries without clearing selection', () => {
        const models = normalizeCopilotCliConfiguredModels([
            { name: 'GPT-5.4 Mini', deploymentId: 'gpt-5.4-mini' },
        ]);

        expect(models).toEqual([
            { name: 'GPT-5.4 Mini', deploymentId: 'gpt-5.4-mini' },
        ]);
    });

    it('drops malformed entries with no model id', () => {
        const models = normalizeCopilotCliConfiguredModels([
            { name: 'Broken entry' },
            { name: 'Valid entry', id: 'gpt-4.1' },
        ]);

        expect(models).toEqual([
            { name: 'Valid entry', deploymentId: 'gpt-4.1' },
        ]);
    });
});