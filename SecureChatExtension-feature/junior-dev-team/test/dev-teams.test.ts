import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DevTeamDef, DevTeamStore, slugifyDevTeamName, validateDevTeam } from '../src/devTeams';

class FakeMemento {
    private store = new Map<string, unknown>();
    get<T>(key: string, defaultValue?: T): T | undefined {
        return (this.store.has(key) ? (this.store.get(key) as T) : defaultValue);
    }
    update(key: string, value: unknown): Thenable<void> {
        if (value === undefined) { this.store.delete(key); }
        else { this.store.set(key, value); }
        return Promise.resolve();
    }
    keys(): readonly string[] { return [...this.store.keys()]; }
}

function makeTempWorkspace(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'junior-dev-teams-'));
}

function makeStore(tmpDir?: string) {
    const memento = new FakeMemento();
    const folder = tmpDir ? { uri: { fsPath: tmpDir }, name: 'tmp', index: 0 } as any : undefined;
    const store = new DevTeamStore(folder, memento as any);
    return { store, memento };
}

const baseTeam: DevTeamDef = {
    id: 'balanced',
    name: 'Balanced Dev Team',
    members: [
        { id: 'lead', role: 'Lead Engineer', permission: 'write', deploymentId: 'gpt-4.1' },
        { id: 'reviewer', role: 'Code Reviewer', permission: 'review' },
    ],
    routing: [
        { id: 'review', pattern: 'review|risk', memberIds: ['reviewer'] },
    ],
};

describe('slugifyDevTeamName', () => {
    it('lowercases, hyphenates and trims', () => {
        expect(slugifyDevTeamName('  Balanced Dev Team  ')).toBe('balanced-dev-team');
        expect(slugifyDevTeamName('Feature++Team')).toBe('feature-team');
    });
});

describe('validateDevTeam', () => {
    it('requires a name and at least one member', () => {
        expect(() => validateDevTeam({ name: '', members: baseTeam.members })).toThrow(/name/);
        expect(() => validateDevTeam({ name: 'Empty', members: [] })).toThrow(/member/);
    });

    it('normalizes duplicate member ids and drops invalid routing targets', () => {
        const team = validateDevTeam({
            name: 'Team',
            members: [
                { id: 'reviewer', role: 'Reviewer', permission: 'review' },
                { id: 'reviewer', role: 'Reviewer', permission: 'review' },
            ],
            routing: [
                { id: 'r', pattern: 'review', memberIds: ['reviewer', 'missing'] },
            ],
        });
        expect(team.members.map(member => member.id)).toEqual(['reviewer', 'reviewer-2']);
        expect(team.routing?.[0].memberIds).toEqual(['reviewer']);
    });
});

describe('DevTeamStore', () => {
    let tmpDir: string;
    beforeEach(() => { tmpDir = makeTempWorkspace(); });
    afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('round-trips workspace teams to .vscode/junior-dev-teams.json', async () => {
        const { store } = makeStore(tmpDir);
        await store.save(baseTeam, 'workspace');
        const file = path.join(tmpDir, '.vscode', 'junior-dev-teams.json');
        expect(fs.existsSync(file)).toBe(true);
        const list = await store.list();
        expect(list.map(team => team.id)).toEqual(['balanced']);
        expect(list[0].scope).toBe('workspace');
    });

    it('workspace teams shadow global teams on id collision', async () => {
        const { store } = makeStore(tmpDir);
        await store.save({ ...baseTeam, name: 'Global Team' }, 'global');
        await store.save({ ...baseTeam, name: 'Workspace Team' }, 'workspace');
        const list = await store.list();
        expect(list).toHaveLength(1);
        expect(list[0].name).toBe('Workspace Team');
        expect(list[0].scope).toBe('workspace');
    });

    it('refuses to save workspace teams without a workspace folder', async () => {
        const { store } = makeStore(undefined);
        await expect(store.save(baseTeam, 'workspace')).rejects.toThrow();
    });
});
