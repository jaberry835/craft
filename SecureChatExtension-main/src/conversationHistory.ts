import { randomUUID } from 'crypto';
import { ChatMessage } from './types';

export type HistoryIdKind = 'turn' | 'round';

export function createHistoryId(kind: HistoryIdKind): string {
    return `${kind}_${randomUUID()}`;
}

/** Add stable metadata to legacy flat histories without changing message order. */
export function hydrateHistoryMetadata(messages: ChatMessage[], scope = 'legacy'): ChatMessage[] {
    let changed = false;
    let turnNumber = 0;
    let roundNumber = 0;
    let currentTurnId: string | undefined;
    let pendingRound: { turnId: string; roundId: string; toolCallIds: Set<string> } | undefined;

    const withMetadata = (message: ChatMessage, turnId?: string, roundId?: string): ChatMessage => {
        if ((!turnId || message.turnId === turnId) && (!roundId || message.roundId === roundId)) {
            return message;
        }
        changed = true;
        return {
            ...message,
            ...(turnId ? { turnId } : {}),
            ...(roundId ? { roundId } : {}),
        };
    };

    const hydrated = messages.map(message => {
        if (message.role === 'user') {
            turnNumber++;
            roundNumber = 0;
            currentTurnId = message.turnId ?? `turn_${scope}_${turnNumber}`;
            pendingRound = undefined;
            return withMetadata(message, currentTurnId);
        }

        if (!currentTurnId) {
            return message;
        }

        if (message.role === 'assistant') {
            roundNumber++;
            const turnId = message.turnId ?? currentTurnId;
            const roundId = message.roundId ?? `round_${scope}_${turnNumber}_${roundNumber}`;
            const toolCallIds = new Set(
                (message.tool_calls ?? []).map(toolCall => toolCall.id).filter(Boolean)
            );
            pendingRound = toolCallIds.size > 0 ? { turnId, roundId, toolCallIds } : undefined;
            return withMetadata(message, turnId, roundId);
        }

        if (message.role === 'tool' && pendingRound && message.tool_call_id &&
            pendingRound.toolCallIds.has(message.tool_call_id)) {
            const hydratedMessage = withMetadata(message, pendingRound.turnId, pendingRound.roundId);
            pendingRound.toolCallIds.delete(message.tool_call_id);
            if (pendingRound.toolCallIds.size === 0) {
                pendingRound = undefined;
            }
            return hydratedMessage;
        }

        return withMetadata(message, message.turnId ?? currentTurnId);
    });

    return changed ? hydrated : messages;
}