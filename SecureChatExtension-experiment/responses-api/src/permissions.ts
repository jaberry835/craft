import { getSetting } from './config';
import { AgentPermissionLevel } from './types';

export const DEFAULT_PERMISSION_LEVEL: AgentPermissionLevel = 'default';

export function isAutoApprovePermissionLevel(level: AgentPermissionLevel): boolean {
    return level === 'bypass';
}

export function shouldConfirmLocalCategory(
    level: AgentPermissionLevel,
    category: 'write' | 'terminal'
): boolean {
    if (isAutoApprovePermissionLevel(level)) {
        return false;
    }

    if (category === 'write') {
        return getSetting<boolean>('agent.confirmWrites') ?? true;
    }

    return getSetting<boolean>('agent.confirmTerminal') ?? true;
}

export function shouldAutoApproveCopilotPermission(
    level: AgentPermissionLevel,
    category: string
): boolean {
    if (category === 'read') {
        return true;
    }

    if (isAutoApprovePermissionLevel(level)) {
        return true;
    }

    if (category === 'write') {
        return getSetting<boolean>('copilotCli.autoApproveWrites') || false;
    }

    if (category === 'shell') {
        return getSetting<boolean>('copilotCli.autoApproveTerminal') || false;
    }

    return false;
}