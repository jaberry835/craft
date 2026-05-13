/**
 * Junior Dev Teams — named collections of custom agents with roles, routing,
 * permissions, and optional per-member model preferences.
 *
 * Storage:
 *   - Workspace teams: `.vscode/junior-dev-teams.json` (committable)
 *   - Global teams:    vscode.Memento globalState key `junior.devTeams.global`
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

const WORKSPACE_FILE = path.join('.vscode', 'junior-dev-teams.json');
const GLOBAL_STATE_KEY = 'junior.devTeams.global';

export type DevTeamScope = 'workspace' | 'global';
export type DevTeamMemberPermission = 'write' | 'review' | 'read';

export interface DevTeamMember {
    /** Stable id within this team. */
    id: string;
    /** Optional custom agent id. If omitted, the member is a built-in role placeholder. */
    agentId?: string;
    /** Human-facing role label, e.g. Lead Engineer or Test Engineer. */
    role: string;
    /** What this member is allowed to do in team mode. */
    permission: DevTeamMemberPermission;
    /** Optional deployment/model id for this member. `undefined` means use the current model. */
    deploymentId?: string;
}

export interface DevTeamRoutingRule {
    id: string;
    pattern: string;
    memberIds: string[];
}

export interface DevTeamDef {
    id: string;
    name: string;
    description?: string;
    members: DevTeamMember[];
    routing?: DevTeamRoutingRule[];
    memoryEnabled?: boolean;
    scope?: DevTeamScope;
}

export function slugifyDevTeamName(name: string): string {
    return name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || `dev-team-${Date.now()}`;
}

function slugifyMemberId(value: string, fallback: string): string {
    return (value || fallback)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50) || fallback;
}

function validatePermission(value: unknown): DevTeamMemberPermission {
    return value === 'write' || value === 'review' || value === 'read' ? value : 'review';
}

export function validateDevTeam(def: Partial<DevTeamDef>): DevTeamDef {
    if (!def.name || typeof def.name !== 'string' || !def.name.trim()) {
        throw new Error('Dev Team name is required.');
    }
    const id = (def.id && typeof def.id === 'string' && def.id.trim()) ? def.id.trim() : slugifyDevTeamName(def.name);
    if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(id)) {
        throw new Error(`Invalid Dev Team id "${id}". Use lowercase letters, numbers and hyphens.`);
    }

    const rawMembers = Array.isArray(def.members) ? def.members : [];
    if (rawMembers.length === 0) {
        throw new Error('Add at least one Dev Team member.');
    }

    const usedMemberIds = new Set<string>();
    const members: DevTeamMember[] = rawMembers.map((member, index) => {
        const role = typeof member.role === 'string' && member.role.trim()
            ? member.role.trim()
            : `Member ${index + 1}`;
        let memberId = typeof member.id === 'string' && member.id.trim()
            ? slugifyMemberId(member.id, `member-${index + 1}`)
            : slugifyMemberId(role, `member-${index + 1}`);
        const baseId = memberId;
        let suffix = 2;
        while (usedMemberIds.has(memberId)) {
            memberId = `${baseId}-${suffix++}`.slice(0, 60);
        }
        usedMemberIds.add(memberId);

        const out: DevTeamMember = {
            id: memberId,
            role,
            permission: validatePermission(member.permission),
        };
        if (typeof member.agentId === 'string' && member.agentId.trim()) {
            out.agentId = member.agentId.trim();
        }
        if (typeof member.deploymentId === 'string' && member.deploymentId.trim()) {
            out.deploymentId = member.deploymentId.trim();
        }
        return out;
    });

    const memberIds = new Set(members.map(m => m.id));
    const routing = (Array.isArray(def.routing) ? def.routing : [])
        .filter(rule => typeof rule.pattern === 'string' && rule.pattern.trim())
        .map((rule, index) => ({
            id: typeof rule.id === 'string' && rule.id.trim() ? slugifyMemberId(rule.id, `route-${index + 1}`) : `route-${index + 1}`,
            pattern: rule.pattern.trim(),
            memberIds: Array.isArray(rule.memberIds) ? rule.memberIds.filter(memberId => memberIds.has(memberId)) : [],
        }))
        .filter(rule => rule.memberIds.length > 0);

    return {
        id,
        name: def.name.trim(),
        description: typeof def.description === 'string' && def.description.trim() ? def.description.trim() : undefined,
        members,
        routing,
        memoryEnabled: def.memoryEnabled !== false,
    };
}

function serializeForDisk(def: DevTeamDef): DevTeamDef {
    const { scope: _scope, ...rest } = def;
    return rest as DevTeamDef;
}

export class DevTeamStore {
    private static warnedWorkspaceLoad = false;

    constructor(
        private workspaceFolder: vscode.WorkspaceFolder | undefined,
        private globalState: vscode.Memento,
    ) {}

    static fromContext(context: vscode.ExtensionContext): DevTeamStore {
        return new DevTeamStore(vscode.workspace.workspaceFolders?.[0], context.globalState);
    }

    private workspaceFilePath(): string | undefined {
        if (!this.workspaceFolder) { return undefined; }
        return path.join(this.workspaceFolder.uri.fsPath, WORKSPACE_FILE);
    }

    private async loadWorkspaceTeams(): Promise<DevTeamDef[]> {
        const file = this.workspaceFilePath();
        if (!file || !fs.existsSync(file)) { return []; }
        try {
            const raw = await fs.promises.readFile(file, 'utf8');
            const parsed = JSON.parse(raw);
            const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.teams) ? parsed.teams : [];
            return arr.map((d: any) => ({ ...validateDevTeam(d), scope: 'workspace' as const }));
        } catch (err: any) {
            const msg = err?.message || String(err);
            console.warn(`[junior] Failed to load ${WORKSPACE_FILE}: ${msg}`);
            if (!DevTeamStore.warnedWorkspaceLoad) {
                DevTeamStore.warnedWorkspaceLoad = true;
                vscode.window.showWarningMessage(
                    `Junior: ${WORKSPACE_FILE} could not be parsed (${msg}). Dev Teams are unavailable until the file is fixed.`,
                );
            }
            return [];
        }
    }

    private async saveWorkspaceTeams(teams: DevTeamDef[]): Promise<void> {
        const file = this.workspaceFilePath();
        if (!file) { throw new Error('No workspace folder is open; cannot save workspace Dev Team.'); }
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, JSON.stringify(teams.map(serializeForDisk), null, 2), 'utf8');
    }

    private loadGlobalTeams(): DevTeamDef[] {
        const raw = this.globalState.get<DevTeamDef[]>(GLOBAL_STATE_KEY) || [];
        const out: DevTeamDef[] = [];
        for (const d of raw) {
            try { out.push({ ...validateDevTeam(d), scope: 'global' }); }
            catch { /* skip invalid */ }
        }
        return out;
    }

    private async saveGlobalTeams(teams: DevTeamDef[]): Promise<void> {
        await this.globalState.update(GLOBAL_STATE_KEY, teams.map(serializeForDisk));
    }

    async list(): Promise<DevTeamDef[]> {
        const ws = await this.loadWorkspaceTeams();
        const global = this.loadGlobalTeams();
        const map = new Map<string, DevTeamDef>();
        for (const team of global) { map.set(team.id, team); }
        for (const team of ws) { map.set(team.id, team); }
        return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    async get(id: string): Promise<DevTeamDef | undefined> {
        return (await this.list()).find(team => team.id === id);
    }

    async save(def: DevTeamDef, scope: DevTeamScope): Promise<DevTeamDef> {
        const validated = validateDevTeam(def);
        if (scope === 'workspace') {
            const existing = await this.loadWorkspaceTeams();
            await this.saveWorkspaceTeams([...existing.filter(team => team.id !== validated.id), validated]);
        } else {
            const existing = this.loadGlobalTeams();
            await this.saveGlobalTeams([...existing.filter(team => team.id !== validated.id), validated]);
        }
        return { ...validated, scope };
    }

    async delete(id: string, scope: DevTeamScope): Promise<void> {
        if (scope === 'workspace') {
            const existing = await this.loadWorkspaceTeams();
            await this.saveWorkspaceTeams(existing.filter(team => team.id !== id));
        } else {
            const existing = this.loadGlobalTeams();
            await this.saveGlobalTeams(existing.filter(team => team.id !== id));
        }
    }
}

export const __test = {
    WORKSPACE_FILE,
    GLOBAL_STATE_KEY,
};
