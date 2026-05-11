import { AzureOpenAIClient } from './aoaiClient';
import { AoaiResponsesClient } from './aoaiResponsesClient';
import { CustomAgentDef, CustomAgentEmbeddingConfig, CustomAgentSearchConfig } from './customAgents';
import { DevTeamDef, DevTeamMember } from './devTeams';
import { AoaiChatClientAdapter } from './framework/aoaiAdapter';
import type { IChatClient } from './framework/chatClient';
import { getSetting } from './config';
import { ChatMessage, ChatMode, DevTeamRoomEvent, ExtensionMessage, WorkingBlock, WorkingBlockActionEntry } from './types';
import { TokenTracker } from './tokenTracker';
import { Citation, extractCitations, runSearch } from './tools/searchKnowledge';

export interface DevTeamConsultResult {
    member: DevTeamMember;
    agent?: CustomAgentDef;
    text: string;
    error?: string;
    executed?: boolean;
    purpose?: string;
    phase?: DevTeamPlanPhase;
    intent?: DevTeamMemberIntent;
    blocking?: boolean;
}

export type DevTeamPlanPhase = 'consult' | 'execute' | 'review';
export type DevTeamMemberIntent = 'specialist' | 'implementer' | 'reviewer' | 'planner' | 'researcher' | 'other';

export interface DevTeamPlanStep {
    member: DevTeamMember;
    agent?: CustomAgentDef;
    phase: DevTeamPlanPhase;
    purpose: string;
    intent?: DevTeamMemberIntent;
    source?: 'lead' | 'deterministic';
}

export interface DevTeamRoomMessage {
    speakerId: string;
    speakerRole: string;
    phase: DevTeamPlanPhase;
    assignment: string;
    text: string;
    blocking?: boolean;
    error?: string;
}

export interface DevTeamManagerDecision {
    nextMemberId?: string;
    phase?: DevTeamPlanPhase;
    intent?: DevTeamMemberIntent;
    assignment?: string;
    reason?: string;
    terminate?: boolean;
    askHuman?: string;
}

export interface DevTeamConsultOptions {
    mode: ChatMode;
    userText: string;
    displayText?: string;
    signal?: AbortSignal;
}

export interface DevTeamRuntimeCallbacks {
    sendToWebview(msg: ExtensionMessage): void;
}

export interface DevTeamGroundingDeps {
    getSearchKey(agentId: string): Promise<string | undefined>;
    getSearchEntraToken(config: CustomAgentSearchConfig): Promise<string | undefined>;
    getEmbeddingKey?(agentId: string): Promise<string | undefined>;
    getEmbeddingEntraToken?(config: CustomAgentEmbeddingConfig): Promise<string | undefined>;
    onCitations?(payload: { agentName: string; query: string; citations: Citation[] }): void;
}

const CONSULT_MAX_TOKENS = 900;
const ORCHESTRATION_MAX_TOKENS = 900;
const ROOM_MANAGER_MAX_TOKENS = 600;
const MAX_ROOM_TURNS = 6;

export class DevTeamRuntime {
    private readonly chatClient: IChatClient;

    constructor(
        private aoaiClient: AzureOpenAIClient,
        private callbacks: DevTeamRuntimeCallbacks,
        private tokenTracker?: TokenTracker,
        private log?: (msg: string) => void,
        private groundingDeps?: DevTeamGroundingDeps,
    ) {
        const wireApi = (getSetting<string>('azureOpenAI.wireApi') || 'chat-completions').toLowerCase();
        this.chatClient = wireApi === 'responses'
            ? new AoaiResponsesClient(aoaiClient)
            : new AoaiChatClientAdapter(aoaiClient);
    }

    async consult(team: DevTeamDef, agents: CustomAgentDef[], options: DevTeamConsultOptions): Promise<DevTeamConsultResult[]> {
        const agentById = new Map(agents.map(agent => [agent.id, agent]));
        const seedPlan = await this.planDevTeamMembers(team, agents, options);
        if (seedPlan.length === 0) { return []; }
        const block = createConsultWorkingBlock(team.name);
        this.callbacks.sendToWebview({ type: 'workingBlockStarted', block });
        this.callbacks.sendToWebview({ type: 'devTeamRoomEvent', event: createTeamRoomEvent(team, 'opened', 'Standup started', `${team.members.length} members in the standup.`) });

        const results: DevTeamConsultResult[] = [];
        const room: DevTeamRoomMessage[] = [];
        const consultedIds = new Set<string>();
        const maxTurns = Math.max(MAX_ROOM_TURNS, seedPlan.length);
        for (let turn = 0; turn < maxTurns; turn++) {
            if (options.signal?.aborted) { break; }
            let step = await this.nextRoomStep(team, agents, options, seedPlan, room, consultedIds);
            if (!step) { break; }
            step = normalizeStepAfterRoomBlocker(step, room);
            const member = step.member;
            if (consultedIds.has(member.id)) { break; }
            consultedIds.add(member.id);
            const agent = member.agentId ? agentById.get(member.agentId) : undefined;
            const entry = createConsultActionEntry(member, agent, step);
            this.callbacks.sendToWebview({ type: 'workingActionAdded', blockId: block.id, entry });
            this.callbacks.sendToWebview({ type: 'devTeamRoomEvent', event: createMemberRoomEvent(team, member, agent, step, 'started', step.purpose) });

            try {
                const grounding = await this.runMemberGrounding(member, agent, options, block.id, entry.id, step);
                const consultText = await this.runMemberConsult(team, member, agent, options, grounding, step, room);
                const text = enrichConsultTextWithGrounding(consultText, grounding);
                const blocking = isBlockingConsultText(text);
                results.push({ member, agent, text, purpose: step.purpose, phase: step.phase, intent: step.intent, blocking });
                room.push({ speakerId: member.id, speakerRole: member.role, phase: step.phase, assignment: step.purpose, text, blocking });
                this.callbacks.sendToWebview({
                    type: 'workingActionUpdated',
                    blockId: block.id,
                    entryId: entry.id,
                    status: 'done',
                    text: `Consulted ${member.role}`,
                    detail: summarizeForWorkingDetail(text),
                    icon: 'done',
                });
                this.callbacks.sendToWebview({ type: 'devTeamRoomEvent', event: createMemberRoomEvent(team, member, agent, step, blocking ? 'blocked' : 'done', summarizeForWorkingDetail(text) || 'No notes returned.') });
            } catch (err: any) {
                if (options.signal?.aborted || err?.name === 'AbortError') {
                    this.callbacks.sendToWebview({
                        type: 'workingActionUpdated',
                        blockId: block.id,
                        entryId: entry.id,
                        status: 'error',
                        text: `Stopped ${member.role}`,
                        detail: 'Team consultation was cancelled.',
                        icon: 'error',
                    });
                    break;
                }
                const message = summarizeConsultError(err);
                this.log?.(`[dev-team] Consult failed for ${member.role}: ${message}`);
                results.push({ member, agent, text: '', error: message, purpose: step.purpose, phase: step.phase, intent: step.intent });
                room.push({ speakerId: member.id, speakerRole: member.role, phase: step.phase, assignment: step.purpose, text: '', error: message });
                this.callbacks.sendToWebview({
                    type: 'workingActionUpdated',
                    blockId: block.id,
                    entryId: entry.id,
                    status: 'error',
                    text: `Consult failed for ${member.role}`,
                    detail: message,
                    icon: 'error',
                });
                this.callbacks.sendToWebview({ type: 'devTeamRoomEvent', event: createMemberRoomEvent(team, member, agent, step, 'failed', message) });
            }
        }

        block.status = 'completed';
        block.completedAt = Date.now();
        const successful = results.filter(result => result.text.trim()).length;
        const failed = results.filter(result => result.error).length;
        const summary = formatConsultSummary(successful, failed);
        this.callbacks.sendToWebview({ type: 'workingBlockCompleted', blockId: block.id, summary, completedAt: block.completedAt });
        this.callbacks.sendToWebview({ type: 'devTeamRoomEvent', event: createTeamRoomEvent(team, 'completed', 'Standup finished', summary) });
        return results;
    }

    private async planDevTeamMembers(team: DevTeamDef, agents: CustomAgentDef[], options: DevTeamConsultOptions): Promise<DevTeamPlanStep[]> {
        const fallback = planDevTeamMembers(team, agents, options.userText);
        if (team.members.length <= 1 || options.signal?.aborted) { return fallback; }
        try {
            const response = await this.chatClient.getResponse(buildLeadOrchestrationMessages(team, agents, options), {
                tools: [],
                toolChoice: 'none',
                maxTokens: ORCHESTRATION_MAX_TOKENS,
                reasoningMode: true,
                signal: options.signal,
            });
            if (response.usage) {
                this.tokenTracker?.record('chat', response.usage);
            }
            const text = response.messages
                .map(message => typeof message.content === 'string' ? message.content : '')
                .join('\n')
                .trim();
            const leadPlan = parseLeadOrchestrationPlan(text, team, agents);
            return leadPlan.length > 0 ? completeTeamRoomPlan(mergeLeadPlanWithFallback(leadPlan, fallback), team, agents) : completeTeamRoomPlan(fallback, team, agents);
        } catch (err: any) {
            if (options.signal?.aborted || err?.name === 'AbortError') { return []; }
            this.log?.(`[dev-team] Lead orchestration failed; using deterministic plan: ${summarizeConsultError(err)}`);
            return completeTeamRoomPlan(fallback, team, agents);
        }
    }

    private async nextRoomStep(
        team: DevTeamDef,
        agents: CustomAgentDef[],
        options: DevTeamConsultOptions,
        seedPlan: DevTeamPlanStep[],
        room: DevTeamRoomMessage[],
        consultedIds: Set<string>,
    ): Promise<DevTeamPlanStep | undefined> {
        const fallback = nextSeedPlanStep(seedPlan, consultedIds);
        if (team.members.length <= 1 || options.signal?.aborted) { return fallback; }
        try {
            const response = await this.chatClient.getResponse(buildRoomManagerMessages(team, agents, options, seedPlan, room, consultedIds), {
                tools: [],
                toolChoice: 'none',
                maxTokens: ROOM_MANAGER_MAX_TOKENS,
                reasoningMode: true,
                signal: options.signal,
            });
            if (response.usage) {
                this.tokenTracker?.record('chat', response.usage);
            }
            const text = response.messages
                .map(message => typeof message.content === 'string' ? message.content : '')
                .join('\n')
                .trim();
            const decision = parseRoomManagerDecision(text);
            if (decision?.askHuman) { return fallback; }
            if (decision?.terminate) { return fallback; }
            const step = decisionToPlanStep(decision, team, agents, consultedIds);
            return step ?? fallback;
        } catch (err: any) {
            if (options.signal?.aborted || err?.name === 'AbortError') { return undefined; }
            this.log?.(`[dev-team] Room manager failed; using next planned member: ${summarizeConsultError(err)}`);
            return fallback;
        }
    }

    private async runMemberGrounding(member: DevTeamMember, agent: CustomAgentDef | undefined, options: DevTeamConsultOptions, blockId: string, entryId: string, planned?: DevTeamPlanStep): Promise<string | undefined> {
        if (!agent?.search || !this.groundingDeps) { return undefined; }
        this.callbacks.sendToWebview({
            type: 'workingActionUpdated',
            blockId,
            entryId,
            status: 'running',
            text: `Searching ${member.role} knowledge`,
            detail: agent.name,
            icon: 'search',
        });
        const query = options.displayText || options.userText;
        const embedding = agent.search.embedding;
        const searchDeps = {
            getSearchKey: () => this.groundingDeps!.getSearchKey(agent.id),
            getEntraToken: () => this.groundingDeps!.getSearchEntraToken(agent.search!),
            getEmbeddingKey: embedding && embedding.auth === 'key'
                ? () => this.groundingDeps!.getEmbeddingKey ? this.groundingDeps!.getEmbeddingKey(agent.id) : Promise.resolve(undefined)
                : undefined,
            getEmbeddingEntraToken: embedding && embedding.auth === 'entra'
                ? () => this.groundingDeps!.getEmbeddingEntraToken ? this.groundingDeps!.getEmbeddingEntraToken(embedding) : Promise.resolve(undefined)
                : undefined,
        };
        const topK = groundingTopKForRequest(query, agent.search.topK ?? 5);
        const groundingQueries = buildMemberGroundingQueries(query, member, agent, planned);
        const docGroups = await Promise.all(groundingQueries
            .map((groundingQuery, index) => runSearch(agent.search!, searchDeps, groundingQuery, index === 0 ? topK : Math.max(topK, 15))));
        const initialDocs = mergeGroundingDocs(...docGroups);
        const detailQueries = buildDetailGroundingQueries(initialDocs, query);
        const detailGroups = await Promise.all(detailQueries
            .map(detailQuery => runSearch(agent.search!, searchDeps, detailQuery, Math.min(Math.max(agent.search!.topK ?? 5, 5), 8))));
        const docs = mergeGroundingDocs(initialDocs, ...detailGroups);
        const citations = extractCitations(docs);
        if (citations.length > 0) {
            this.groundingDeps.onCitations?.({ agentName: agent.name, query, citations });
        }
        this.callbacks.sendToWebview({
            type: 'workingActionUpdated',
            blockId,
            entryId,
            status: 'running',
            text: `Consulting ${member.role}`,
            detail: citations.length === 1 ? 'Found 1 source' : `Found ${citations.length} sources`,
            icon: 'loading',
        });
        return formatGroundingForConsult(agent.name, docs, citations);
    }

    private async runMemberConsult(team: DevTeamDef, member: DevTeamMember, agent: CustomAgentDef | undefined, options: DevTeamConsultOptions, grounding?: string, planned?: DevTeamPlanStep, room: DevTeamRoomMessage[] = []): Promise<string> {
        if (member.deploymentId) {
            this.aoaiClient.setDeploymentOverride(member.deploymentId);
        }
        try {
            const response = await this.chatClient.getResponse(buildMemberConsultMessages(team, member, agent, options, grounding, planned, room), {
                tools: [],
                toolChoice: 'none',
                maxTokens: CONSULT_MAX_TOKENS,
                reasoningMode: true,
                signal: options.signal,
            });
            if (response.usage) {
                this.tokenTracker?.record('chat', response.usage);
            }
            return response.messages
                .map(message => typeof message.content === 'string' ? message.content : '')
                .join('\n')
                .trim();
        } finally {
            if (member.deploymentId) {
                this.aoaiClient.setDeploymentOverride(undefined);
            }
        }
    }
}

export function selectDevTeamConsultMembers(team: DevTeamDef, userText: string): DevTeamMember[] {
    return planDevTeamMembers(team, [], userText).map(step => step.member);
}

export function planDevTeamMembers(team: DevTeamDef, agents: CustomAgentDef[], userText: string): DevTeamPlanStep[] {
    const normalizedText = userText.toLowerCase();
    const selectedIds = new Set<string>();
    const purposes = new Map<string, string>();
    for (const rule of team.routing || []) {
        if (!rule.pattern.trim()) { continue; }
        try {
            if (new RegExp(rule.pattern, 'i').test(userText)) {
                for (const memberId of rule.memberIds) {
                    selectedIds.add(memberId);
                    appendPurpose(purposes, memberId, `Routing hint matched /${rule.pattern}/i.`);
                }
            }
        } catch {
            const tokens = rule.pattern
                .split('|')
                .map(token => token.trim().toLowerCase().replace(/[^a-z0-9 -]/g, ''))
                .filter(Boolean);
            if (tokens.some(token => normalizedText.includes(token))) {
                for (const memberId of rule.memberIds) {
                    selectedIds.add(memberId);
                    appendPurpose(purposes, memberId, `Routing tokens matched ${tokens.join(', ')}.`);
                }
            }
        }
    }

    const agentById = new Map(agents.map(agent => [agent.id, agent]));
    for (const member of team.members) {
        const agent = member.agentId ? agentById.get(member.agentId) : undefined;
        const profile = memberProfileText(member, agent);
        if (isExplicitlyMentioned(normalizedText, member, agent)) {
            selectedIds.add(member.id);
            appendPurpose(purposes, member.id, 'Explicitly mentioned or strongly implied by the request.');
            continue;
        }
        const capabilityPurpose = inferCapabilityPurpose(normalizedText, profile, member.permission);
        if (capabilityPurpose) {
            selectedIds.add(member.id);
            appendPurpose(purposes, member.id, capabilityPurpose);
        }
    }

    if (selectedIds.size === 0) {
        for (const member of team.members) {
            selectedIds.add(member.id);
            appendPurpose(purposes, member.id, 'Whole-team fallback because no routing or capability match was found.');
        }
    }

    return team.members
        .filter(member => selectedIds.has(member.id))
        .map((member): DevTeamPlanStep => {
            const agent = member.agentId ? agentById.get(member.agentId) : undefined;
            const profile = memberProfileText(member, agent);
            const phase = inferPlanPhase(member, normalizedText, profile);
            return {
                member,
                agent,
                phase,
                intent: phase === 'execute' ? 'implementer' : phase === 'review' ? 'reviewer' : undefined,
                purpose: purposes.get(member.id) || defaultMemberPurpose(member, profile),
                source: 'deterministic',
            };
        })
        .sort(comparePlanSteps);
}

function appendPurpose(map: Map<string, string>, memberId: string, purpose: string): void {
    const existing = map.get(memberId);
    if (!existing) { map.set(memberId, purpose); }
    else if (!existing.includes(purpose)) { map.set(memberId, `${existing} ${purpose}`); }
}

function memberProfileText(member: DevTeamMember, agent: CustomAgentDef | undefined): string {
    return [member.role, member.id, agent?.name, agent?.description, agent?.systemPrompt]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
}

function isExplicitlyMentioned(normalizedText: string, member: DevTeamMember, agent: CustomAgentDef | undefined): boolean {
    const names = [member.role, member.id, agent?.name]
        .filter(Boolean)
        .map(value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())
        .filter(value => value.length >= 2);
    return names.some(name => normalizedText.includes(name));
}

function inferCapabilityPurpose(normalizedText: string, profile: string, permission: DevTeamMember['permission']): string | undefined {
    const asksForDomainKnowledge = /\b(policy|policies|domain|sme|expert|specific|requirements?|rules?|guidance|should know|source of truth)\b/.test(normalizedText);
    if (asksForDomainKnowledge && /\b(sme|expert|domain|policy|policies|hr|human resources|requirements?|business|compliance)\b/.test(profile)) {
        return 'Provides domain-specific requirements and constraints before implementation.';
    }
    if (/\b(hr|human resources|employee|employees|benefits|pto|leave|conduct|workplace)\b/.test(normalizedText) && /\b(hr|human resources|policy|policies|employee|workplace)\b/.test(profile)) {
        return 'Provides HR-specific policy guidance requested by the user.';
    }
    if (/\b(build|create|implement|add|write|edit|page|html|component|fix|scaffold)\b/.test(normalizedText) && permission === 'write') {
        return 'Implements the requested change after upstream specialist notes are available.';
    }
    if (/\b(test|tests|coverage|regression|validate|verify|qa)\b/.test(normalizedText) && /\b(test|qa|quality|validation|coverage)\b/.test(profile)) {
        return 'Validates the result and identifies test or coverage gaps.';
    }
    if (/\b(review|risk|security|safe|audit|compliance|auth)\b/.test(normalizedText) && /\b(review|risk|security|audit|compliance|auth)\b/.test(profile)) {
        return 'Reviews risks, safety, and missing requirements.';
    }
    if (/\b(doc|docs|readme|copy|content|write-up|guide)\b/.test(normalizedText) && /\b(doc|docs|writer|scribe|content|copy)\b/.test(profile)) {
        return 'Writes or reviews user-facing content and documentation.';
    }
    return undefined;
}

function inferPlanPhase(member: DevTeamMember, normalizedText: string, profile: string): DevTeamPlanPhase {
    if (member.permission === 'write' && /\b(build|create|implement|add|write|edit|fix|scaffold)\b/.test(normalizedText)) { return 'execute'; }
    if (/\b(review|test|coverage|regression|validate|verify|risk|security|audit)\b/.test(profile)) { return 'review'; }
    return 'consult';
}

function isBlockingConsultText(text: string): boolean {
    const normalized = text.toLowerCase().replace(/\s+/g, ' ');
    if (/\b(no|without)\s+(blockers?|blocking issues?|missing required input)\b/.test(normalized)) { return false; }
    if (isScopedImplementationApprovalText(normalized)) { return false; }
    return /\b(blocked|blocker|cannot proceed|can't proceed|do not proceed|should not proceed|must not proceed)\b/.test(normalized)
        || /\b(missing|need|needs|requires|required)\b[^.]{0,90}\b(actual|approved|authoritative|official|source|source material|policy text|input|content)\b/.test(normalized)
        || /\b(actual|approved|authoritative|official|source|source material|policy text|input|content)\b[^.]{0,90}\b(missing|not present|not provided|unavailable|needed|required)\b/.test(normalized)
        || /\b(not enough|insufficient|not authoritative|not the legal source|not a legal source|placeholder only)\b/.test(normalized);
}

function isScopedImplementationApprovalText(normalized: string): boolean {
    if (/\b(do not|must not|should not|cannot|can't)\s+(build|create|implement|write|publish|ship|proceed)\b/.test(normalized)) { return false; }
    const hasScopedScope = /\b(minimal|limited|scoped|safe|v1|initial|approved|grounded|confirmed|source-backed|cited)\b/.test(normalized);
    const hasBuildApproval = /\b(can|may|safe to|ready to|approved to|proceed with|build|create|implement|publish|ship)\b/.test(normalized);
    const hasBoundary = /\b(only|within|exclude|excluding|do not include|do not publish|beyond|full build|broader|scope)\b/.test(normalized);
    return hasScopedScope && hasBuildApproval && hasBoundary;
}

function defaultMemberPurpose(member: DevTeamMember, profile: string): string {
    if (member.permission === 'write') { return 'Can implement changes when the plan calls for file edits.'; }
    if (/\b(sme|expert|domain|policy|requirements?)\b/.test(profile)) { return 'Provides specialist requirements and constraints.'; }
    if (member.permission === 'read') { return 'Provides read-only facts and context.'; }
    return 'Provides review feedback and recommendations.';
}

function comparePlanSteps(a: DevTeamPlanStep, b: DevTeamPlanStep): number {
    const order: Record<DevTeamPlanPhase, number> = { consult: 0, review: 1, execute: 2 };
    const phase = order[a.phase] - order[b.phase];
    if (phase !== 0) { return phase; }
    return 0;
}

function buildLeadOrchestrationMessages(team: DevTeamDef, agents: CustomAgentDef[], options: DevTeamConsultOptions): ChatMessage[] {
    const agentById = new Map(agents.map(agent => [agent.id, agent]));
    const roster = team.members.map(member => {
        const agent = member.agentId ? agentById.get(member.agentId) : undefined;
        const agentParts = [
            agent?.name ? `linked agent: ${agent.name}` : '',
            agent?.description ? `description: ${truncateForPrompt(agent.description, 900)}` : '',
            agent?.systemPrompt ? `instructions: ${truncateForPrompt(agent.systemPrompt, 1400)}` : '',
        ].filter(Boolean).join('\n    ');
        return `- id: ${member.id}\n  role: ${member.role}\n  permission: ${member.permission}\n  preferredModel: ${member.deploymentId || 'current'}${agentParts ? `\n  ${agentParts}` : ''}`;
    }).join('\n');
    const routing = (team.routing || [])
        .map(rule => `- /${rule.pattern}/i -> ${rule.memberIds.join(', ')}`)
        .join('\n');

    return [
        {
            role: 'system',
            content: `You are the lead coordinator for a Junior Dev Team. Decide which team members should participate and give each selected member a concrete assignment.\n\nUse the team roster, linked custom-agent descriptions, and linked custom-agent instructions to infer each member's best contribution for this request. Classify each selected assignment with intent: specialist, implementer, reviewer, planner, researcher, or other. A member may have write permission but still be best used as a specialist, researcher, planner, or reviewer. Implementers should only execute after required upstream facts and review constraints are available. Reviewers should provide preflight risk, scope, validation, or approval guidance before implementation, and may validate again after implementation in a later pass.\n\nReturn JSON only, with this shape:\n{ "steps": [ { "memberId": "member-id", "phase": "consult|execute|review", "intent": "specialist|implementer|reviewer|planner|researcher|other", "purpose": "Lead assignment in one sentence" } ] }\n\nRules:\n- Use only member ids from the roster.\n- Select no more than 5 members unless the request truly needs the whole team.\n- Do not assign execute to read-only or review-only members.\n- Assign phase execute only when intent is implementer.\n- If source material, domain facts, policy facts, or business rules are needed, assign the member whose prompt/description best fits that source-of-truth work with intent specialist or researcher before implementation.\n- For broad content-generation work such as sites, docs, portals, catalogs, indexes, or knowledge-base pages, the source-of-truth member assignment must ask them to enumerate the relevant grounded sources and extract the source-backed content the implementer should publish or use.\n- If implementation is requested, include reviewer/planner guidance before the implementer when those roles exist, then include a write-capable member with intent implementer and phase execute when appropriate.`,
        },
        {
            role: 'user',
            content: `Team: ${team.name}\n${team.description ? `Description: ${team.description}\n` : ''}\nRoster:\n${roster}\n\n${routing ? `Routing hints:\n${routing}\n\n` : ''}Mode: ${options.mode}\nHuman request:\n${options.displayText || options.userText}`,
        },
    ];
}

function parseLeadOrchestrationPlan(text: string, team: DevTeamDef, agents: CustomAgentDef[]): DevTeamPlanStep[] {
    const jsonText = extractJsonObject(text);
    if (!jsonText) { return []; }
    let parsed: any;
    try {
        parsed = JSON.parse(jsonText);
    } catch {
        return [];
    }
    const rawSteps = Array.isArray(parsed?.steps) ? parsed.steps : [];
    const agentById = new Map(agents.map(agent => [agent.id, agent]));
    const memberById = new Map(team.members.map(member => [member.id, member]));
    const seen = new Set<string>();
    const steps: DevTeamPlanStep[] = [];
    for (const raw of rawSteps) {
        const memberId = typeof raw?.memberId === 'string' ? raw.memberId.trim() : '';
        const member = memberById.get(memberId);
        if (!member || seen.has(member.id)) { continue; }
        seen.add(member.id);
        const agent = member.agentId ? agentById.get(member.agentId) : undefined;
        const profile = memberProfileText(member, agent);
        const intent = coerceMemberIntent(raw?.intent);
        const phase = coercePlanPhase(raw?.phase, member, intent);
        const purpose = typeof raw?.purpose === 'string' && raw.purpose.trim()
            ? raw.purpose.trim().replace(/\s+/g, ' ').slice(0, 500)
            : defaultMemberPurpose(member, profile);
        steps.push({
            member,
            agent,
            phase,
            purpose,
            intent,
            source: 'lead',
        });
    }
    return steps.sort(comparePlanSteps);
}

function mergeLeadPlanWithFallback(leadPlan: DevTeamPlanStep[], fallback: DevTeamPlanStep[]): DevTeamPlanStep[] {
    const merged = [...leadPlan];
    const selectedIds = new Set(merged.map(step => step.member.id));
    const leadHasImplementer = merged.some(step => step.member.permission === 'write' && step.phase === 'execute' && step.intent === 'implementer');
    const fallbackWrite = fallback.filter(step => step.member.permission === 'write' && step.phase === 'execute');
    if (!leadHasImplementer && fallbackWrite.length > 0) {
        for (const step of fallbackWrite) {
            if (!selectedIds.has(step.member.id)) {
                merged.push({ ...step, intent: 'implementer', purpose: `${step.purpose} Lead fallback: implementation was requested and this is the write-capable member.` });
                selectedIds.add(step.member.id);
            }
        }
    }
    return merged.sort(comparePlanSteps);
}

function completeTeamRoomPlan(plan: DevTeamPlanStep[], team: DevTeamDef, agents: CustomAgentDef[]): DevTeamPlanStep[] {
    const agentById = new Map(agents.map(agent => [agent.id, agent]));
    const existing = new Set(plan.map(step => step.member.id));
    const completed = [...plan];
    for (const member of team.members) {
        if (existing.has(member.id)) { continue; }
        const agent = member.agentId ? agentById.get(member.agentId) : undefined;
        const phase = member.permission === 'review' ? 'review' : inferPlanPhase(member, '', memberProfileText(member, agent)) === 'review' ? 'review' : 'consult';
        completed.push({
            member,
            agent,
            phase,
            intent: member.permission === 'review' ? 'reviewer' : 'other',
            purpose: 'Participate in the Dev Team standup with any relevant constraints, concerns, context, or approval notes before the team lead finalizes the answer.',
            source: 'deterministic',
        });
    }
    return completed.sort(comparePlanSteps);
}

function buildRoomManagerMessages(
    team: DevTeamDef,
    agents: CustomAgentDef[],
    options: DevTeamConsultOptions,
    seedPlan: DevTeamPlanStep[],
    room: DevTeamRoomMessage[],
    consultedIds: Set<string>,
): ChatMessage[] {
    const agentById = new Map(agents.map(agent => [agent.id, agent]));
    const roster = team.members.map(member => {
        const agent = member.agentId ? agentById.get(member.agentId) : undefined;
        const status = consultedIds.has(member.id) ? 'already spoke' : 'available';
        return `- ${member.id}: ${member.role}; permission=${member.permission}; status=${status}${agent?.name ? `; linked=${agent.name}` : ''}${agent?.description ? `; description=${truncateForPrompt(agent.description, 500)}` : ''}`;
    }).join('\n');
    const seed = seedPlan.map(step => `- ${step.member.id}: ${step.phase}; ${step.purpose}`).join('\n');
    const history = formatRoomHistory(room) || 'No team members have spoken yet.';

    return [
        {
            role: 'system',
            content: `You are the lead manager for a Junior Dev Team standup. Choose the next team member who should speak.\n\nReturn JSON only with this shape:\n{ "nextMemberId": "member-id", "phase": "consult|execute|review", "intent": "specialist|implementer|reviewer|planner|researcher|other", "assignment": "one clear instruction", "reason": "short reason", "terminate": false, "askHuman": "" }\n\nRules:\n- Pick only one next speaker.\n- Use only available member ids from the roster.\n- Do not select a member who already spoke unless no useful available member remains.\n- Classify this assignment using intent based on the member's role, prompt, description, prior standup messages, and the work needed now.\n- Never assign execute to read-only or review-only members.\n- Assign phase execute only when intent is implementer.\n- If a prior message says implementation is blocked with no safe scoped path, return { "terminate": true, "askHuman": "what input is needed" }. Do not terminate merely because a member limited scope when source-backed excerpts are available.\n- Prefer source-of-truth, domain, or research assignments before implementation when facts are needed. For content-generation work, make the source-of-truth member enumerate grounded sources and extract usable content before selecting an implementer.\n- Prefer reviewer/planner guidance before implementation when those members are still available.\n- If implementation should now proceed, select a write-capable member with intent implementer and phase execute, and assign them to populate the deliverable from the grounded content already shared in the standup rather than creating empty shells.\n- Terminate only when no implementation is needed, every relevant available non-implementer has spoken, or human input is required.`,
        },
        {
            role: 'user',
            content: `Team: ${team.name}\nHuman request:\n${options.displayText || options.userText}\n\nRoster:\n${roster}\n\nInitial lead plan:\n${seed || 'No initial plan.'}\n\nShared standup history:\n${history}`,
        },
    ];
}

function parseRoomManagerDecision(text: string): DevTeamManagerDecision | undefined {
    const jsonText = extractJsonObject(text);
    if (!jsonText) { return undefined; }
    try {
        const parsed = JSON.parse(jsonText);
        if (!parsed || typeof parsed !== 'object') { return undefined; }
        return {
            nextMemberId: typeof parsed.nextMemberId === 'string' ? parsed.nextMemberId.trim() : undefined,
            phase: parsed.phase === 'execute' || parsed.phase === 'review' || parsed.phase === 'consult' ? parsed.phase : undefined,
            intent: coerceMemberIntent(parsed.intent),
            assignment: typeof parsed.assignment === 'string' ? parsed.assignment.trim() : undefined,
            reason: typeof parsed.reason === 'string' ? parsed.reason.trim() : undefined,
            terminate: parsed.terminate === true,
            askHuman: typeof parsed.askHuman === 'string' && parsed.askHuman.trim() ? parsed.askHuman.trim() : undefined,
        };
    } catch {
        return undefined;
    }
}

function decisionToPlanStep(decision: DevTeamManagerDecision | undefined, team: DevTeamDef, agents: CustomAgentDef[], consultedIds: Set<string>): DevTeamPlanStep | undefined {
    if (!decision?.nextMemberId || consultedIds.has(decision.nextMemberId)) { return undefined; }
    const member = team.members.find(candidate => candidate.id === decision.nextMemberId);
    if (!member) { return undefined; }
    const agentById = new Map(agents.map(agent => [agent.id, agent]));
    const agent = member.agentId ? agentById.get(member.agentId) : undefined;
    return {
        member,
        agent,
        phase: coercePlanPhase(decision.phase, member, decision.intent),
        purpose: (decision.assignment || decision.reason || defaultMemberPurpose(member, memberProfileText(member, agent))).replace(/\s+/g, ' ').slice(0, 500),
        intent: decision.intent,
        source: 'lead',
    };
}

function nextSeedPlanStep(seedPlan: DevTeamPlanStep[], consultedIds: Set<string>): DevTeamPlanStep | undefined {
    return seedPlan.find(step => !consultedIds.has(step.member.id));
}

function formatRoomHistory(room: DevTeamRoomMessage[]): string {
    if (room.length === 0) { return ''; }
    return room.map((message, index) => {
        const status = message.error ? `ERROR: ${message.error}` : message.blocking ? 'BLOCKING' : message.phase;
        const maxLength = message.text.includes('Grounded source excerpts available to this member') ? 12000 : 1200;
        const text = message.error ? '' : truncateForPrompt(message.text, maxLength);
        return `### Turn ${index + 1}: ${message.speakerRole} (${status})\nAssignment: ${message.assignment}\n${text}`.trim();
    }).join('\n\n');
}

function enrichConsultTextWithGrounding(text: string, grounding?: string): string {
    const trimmed = text.trim();
    const grounded = grounding?.trim();
    if (!grounded || grounded.endsWith('knowledge search found no matching documents.')) { return trimmed; }

    const sourceAppendix = `Grounded source excerpts available to this member. These excerpts may be compacted for the standup token budget; treat compaction as a retrieval summary, not as a request for more user-provided material:\n${compactGroundingForStandup(grounded, 12000)}`;
    if (!trimmed) {
        return `${sourceAppendix}\n\nNo additional member narrative was returned; use these retrieved source excerpts as this member's source-backed context.`;
    }

    if (/\[\d+\]/.test(trimmed) && trimmed.length > 180) { return trimmed; }
    return `${trimmed}\n\n${sourceAppendix}`;
}

function groundingTopKForRequest(query: string, configuredTopK: number): number {
    if (shouldRunKnowledgeInventoryGrounding(query)) { return Math.max(configuredTopK, 12); }
    return configuredTopK;
}

function buildMemberGroundingQueries(query: string, member: DevTeamMember, agent: CustomAgentDef | undefined, planned?: DevTeamPlanStep): string[] {
    const queries: string[] = [];
    addGroundingQuery(queries, query);

    if (planned?.purpose) {
        addGroundingQuery(queries, `${query}\n${planned.purpose}`);
        addGroundingQuery(queries, planned.purpose);
    }

    const profileParts = [member.role, agent?.name, agent?.description]
        .filter((part): part is string => typeof part === 'string' && !!part.trim());
    if (profileParts.length > 0 && (shouldRunKnowledgeInventoryGrounding(query) || /\b(source|ground|knowledge|facts?|requirements?|content|docs?|documents?)\b/i.test(planned?.purpose || ''))) {
        addGroundingQuery(queries, `${query}\n${profileParts.join('\n')}`);
    }

    for (const inventoryQuery of buildInventoryGroundingQueries(query)) {
        addGroundingQuery(queries, inventoryQuery);
    }

    return queries.slice(0, 6);
}

function addGroundingQuery(queries: string[], value: string | undefined): void {
    const compact = value?.replace(/\s+/g, ' ').trim();
    if (!compact) { return; }
    if (queries.some(existing => existing.toLowerCase() === compact.toLowerCase())) { return; }
    queries.push(compact.length > 700 ? compact.slice(0, 700) : compact);
}

function shouldRunKnowledgeInventoryGrounding(query: string): boolean {
    const normalized = query.toLowerCase().replace(/\s+/g, ' ');
    const asksForInventory = /\b(site|website|hub|portal|index|catalog|pages?|sections?|all|available|current|based on|using|from)\b/.test(normalized);
    const asksForKnowledge = /\b(knowledge|content|materials|docs?|documents?|files?|sources?|records?|articles?|policies|policy|guides?|handbook|manual)\b/.test(normalized);
    return asksForInventory && asksForKnowledge;
}

function buildInventoryGroundingQueries(query: string): string[] {
    if (!shouldRunKnowledgeInventoryGrounding(query)) { return []; }
    const normalized = query.toLowerCase();
    const queries = new Set<string>();
    if (/\bpolic(?:y|ies)\b/.test(normalized)) { queries.add('policy'); }
    if (/\b(records?|employees?|people|personnel)\b/.test(normalized)) { queries.add('record'); }
    if (/\b(docs?|documents?|files?|sources?|materials?)\b/.test(normalized)) { queries.add('document'); }
    if (/\b(articles?|guides?|handbook|manual)\b/.test(normalized)) { queries.add('guide'); }
    queries.add('content');
    return [...queries].slice(0, 3);
}

function buildDetailGroundingQueries<T extends { fields: Record<string, unknown> }>(docs: T[], originalQuery: string): string[] {
    if (!shouldRunKnowledgeInventoryGrounding(originalQuery) || docs.length === 0) { return []; }
    const queries: string[] = [];
    const seenTitles = new Set<string>();
    for (const doc of docs) {
        const title = pickGroundingTitle(doc.fields);
        if (!title) { continue; }
        const normalized = title.toLowerCase();
        if (seenTitles.has(normalized)) { continue; }
        seenTitles.add(normalized);
        addGroundingQuery(queries, `${title} details`);
        if (queries.length >= 8) { break; }
    }
    return queries;
}

function mergeGroundingDocs<T extends { fields: Record<string, unknown> }>(...groups: T[][]): T[] {
    const merged: T[] = [];
    const seen = new Set<string>();
    for (const group of groups) {
        for (const doc of group) {
            const key = groundingDocKey(doc.fields);
            if (seen.has(key)) { continue; }
            seen.add(key);
            merged.push(doc);
        }
    }
    return merged;
}

function groundingDocKey(fields: Record<string, unknown>): string {
    const title = pickGroundingTitle(fields);
    const content = pickGroundingContent(fields);
    if (title && content) { return `title-content:${title.toLowerCase()}:${content.slice(0, 160).toLowerCase()}`; }
    if (title) { return `title:${title.toLowerCase()}`; }
    if (content) { return `content:${content.slice(0, 220).toLowerCase()}`; }
    const id = fields.id;
    return typeof id === 'string' && id.trim() ? `id:${id.trim().toLowerCase()}` : JSON.stringify(fields).slice(0, 300);
}

function pickGroundingTitle(fields: Record<string, unknown>): string | undefined {
    for (const key of ['title', 'name', 'displayName', 'metadata_title', 'metadata_storage_name', 'fileName', 'source', 'url', 'uri']) {
        const value = fields[key];
        if (typeof value === 'string' && value.trim()) { return value.trim(); }
    }
    return undefined;
}

function compactGroundingForStandup(grounding: string, maxLength: number): string {
    const sections = splitGroundingSections(grounding);
    if (sections.length <= 1) { return truncateGroundingSection(grounding, maxLength); }

    const header = grounding.slice(0, grounding.indexOf(sections[0])).trim();
    const headerText = header ? `${header}\n` : '';
    const headings = sections.map(section => section.split('\n', 1)[0].trim());
    const headingBudget = headings.reduce((total, heading) => total + heading.length + 2, 0);
    const available = Math.max(sections.length * 300, maxLength - headerText.length - headingBudget - (sections.length * 40));
    const perSectionBody = Math.max(300, Math.floor(available / sections.length));
    const compacted = sections.map(section => compactGroundingSectionWithHeading(section.trim(), perSectionBody)).join('\n\n');
    const text = `${headerText}${compacted}`.trim();
    return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 78)).trim()}\n[Grounding compacted for standup; every retrieved source heading was preserved when possible.]` : text;
}

function compactGroundingSectionWithHeading(section: string, bodyBudget: number): string {
    const newline = section.indexOf('\n');
    if (newline < 0) { return section; }
    const heading = section.slice(0, newline).trim();
    const body = section.slice(newline + 1).trim();
    if (body.length <= bodyBudget) { return `${heading}\n${body}`; }
    return `${heading}\n${body.slice(0, Math.max(0, bodyBudget - 78)).trim()}\n[Source excerpt compacted for standup; do not ask the user to paste this source.]`;
}

function truncateGroundingSection(text: string, maxLength: number): string {
    if (text.length <= maxLength) { return text; }
    return `${text.slice(0, Math.max(0, maxLength - 78)).trim()}\n[Source excerpt compacted for standup; do not ask the user to paste this source.]`;
}

function splitGroundingSections(grounding: string): string[] {
    const matches = [...grounding.matchAll(/^### \[\d+\].*$/gm)];
    return matches.map((match, index) => {
        const start = match.index ?? 0;
        const end = index + 1 < matches.length ? matches[index + 1].index ?? grounding.length : grounding.length;
        return grounding.slice(start, end).trim();
    }).filter(Boolean);
}

function coercePlanPhase(value: unknown, member: DevTeamMember, intent?: DevTeamMemberIntent): DevTeamPlanPhase {
    const phase = value === 'execute' || value === 'review' || value === 'consult' ? value : undefined;
    if (phase === 'execute') {
        if (member.permission !== 'write') { return 'consult'; }
        return intent === 'implementer' ? 'execute' : 'consult';
    }
    if (phase === 'review') { return member.permission === 'write' ? 'review' : 'review'; }
    return 'consult';
}

function coerceMemberIntent(value: unknown): DevTeamMemberIntent | undefined {
    if (value === 'specialist' || value === 'implementer' || value === 'reviewer' || value === 'planner' || value === 'researcher' || value === 'other') {
        return value;
    }
    return undefined;
}

function extractJsonObject(text: string): string | undefined {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = (fenced?.[1] || text).trim();
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    return start >= 0 && end > start ? candidate.slice(start, end + 1) : undefined;
}

function truncateForPrompt(text: string, maxLength: number): string {
    const compact = text.replace(/\s+/g, ' ').trim();
    return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

export function buildDevTeamConsultContext(results: DevTeamConsultResult[]): string {
    const useful = results.filter(result => result.text.trim() || result.error);
    if (useful.length === 0) { return ''; }
    const failedCount = useful.filter(result => result.error).length;
    const blockers = getBlockingDevTeamConsultResults(useful);
    const consultedRoles = useful.filter(result => result.text.trim() && !result.error).map(result => result.member.role);
    const unavailableRoles = useful.filter(result => result.error).map(result => result.member.role);
    const sections = useful.map(result => {
        const agentName = result.agent?.name ? ` (${result.agent.name})` : '';
        const heading = `### ${result.member.role}${agentName}`;
        const purpose = result.purpose ? `Purpose: ${result.purpose}\n` : '';
        if (result.error) {
            return `${heading}\n${purpose}Consult unavailable: ${result.error}`;
        }
        return `${heading}\n${purpose}${result.text.trim()}`;
    });
    const failureGuidance = failedCount > 0
        ? ` ${failedCount === 1 ? 'One selected member was unavailable' : `${failedCount} selected members were unavailable`}; do not invent their perspective, and call out any missing review coverage if it matters.`
        : '';
    const rosterGuidance = [
        consultedRoles.length ? `Consulted roles: ${consultedRoles.join(', ')}.` : 'No team members returned usable notes.',
        unavailableRoles.length ? `Unavailable roles: ${unavailableRoles.join(', ')}.` : '',
        blockers.length ? `Execution blocked by: ${blockers.map(result => result.member.role).join(', ')}. Do not implement, fabricate, or claim completion until the missing authoritative input is provided.` : '',
        'Only label final-answer sections with consulted roles. Put team-level synthesis under Recommendation, Plan, or Next steps rather than inventing an unconsulted member voice. Do not use "Coordinator" as a visible speaker or heading.',
    ].filter(Boolean).join('\n');
    return `## Junior Dev Team Consult Notes\nThese are pre-flight notes from selected team members. Use them as input, resolve conflicts, and ask the human only for decisions that remain unclear.${failureGuidance}\n\n${rosterGuidance}\n\n${sections.join('\n\n')}`;
}

export function selectDevTeamExecutionResults(results: DevTeamConsultResult[]): DevTeamConsultResult[] {
    if (getBlockingDevTeamConsultResults(results).length > 0) { return []; }
    return results.filter(result => result.member.permission === 'write' && !result.error && result.phase === 'execute');
}

export function getBlockingDevTeamConsultResults(results: DevTeamConsultResult[]): DevTeamConsultResult[] {
    return results.filter(result => result.member.permission !== 'write' && !!result.blocking && !result.error);
}

function buildMemberConsultMessages(team: DevTeamDef, member: DevTeamMember, agent: CustomAgentDef | undefined, options: DevTeamConsultOptions, grounding?: string, planned?: DevTeamPlanStep, room: DevTeamRoomMessage[] = []): ChatMessage[] {
    const permission = member.permission === 'write'
        ? 'You may recommend implementation steps, but this consult pass must not edit files or call tools.'
        : member.permission === 'read'
            ? 'You are read-only. Focus on facts, constraints, and questions.'
            : 'You are review-only. Focus on risks, critique, missing requirements, and validation.';
    const agentPrompt = agent?.systemPrompt?.trim()
        ? `\n\nLinked custom-agent instructions:\n${agent.systemPrompt.trim()}`
        : '';
    const groundingText = grounding?.trim()
        ? `\n\nGrounded knowledge retrieved for this consult:\n${grounding.trim()}`
        : '';
    const roomText = formatRoomHistory(room);
    const roomHistoryText = roomText ? `\n\nShared Dev Team standup so far:\n${roomText}` : '';
    const plannedText = planned?.purpose
        ? `\nLead assignment: ${planned.purpose}\nAssigned phase: ${planned.phase}.`
        : '';

    return [
        {
            role: 'system',
            content: `You are serving as one member of a Junior Dev Team standup.\nTeam: ${team.name}\nRole: ${member.role}\nPermission: ${member.permission}. ${permission}${plannedText}${agent?.description ? `\nSpecialty: ${agent.description}` : ''}${agentPrompt}${groundingText}${roomHistoryText}\n\nRespond directly to the lead assignment with concise, structured notes for the team lead and later team members. Build on prior standup messages when present; do not repeat them unless needed. Do not address the human directly. Do not claim to have changed files. Prefer concrete requirements, constraints, risks, open questions, and suggested next steps. If you are a domain expert or SME, provide the authoritative facts the implementer must use. If grounded knowledge is provided, treat those retrieved excerpts as source material for a bounded implementation and cite relevant items by bracket number such as [1]. For content-generation tasks, enumerate each grounded source that should be used and extract the concrete content, fields, sections, facts, labels, dates, contacts, and exclusions the implementer should put into the deliverable. Do not merely say that content exists. Do not invent HR, legal, privacy, approval, canonical-document, or publication blockers unless the retrieved source itself marks content confidential, personal, restricted, or missing. If only part of the requested content is grounded, recommend implementing the grounded portion and clearly marking unknown or excluded sections instead of blocking all work. Grounded excerpts may be compacted for the standup token budget; do not describe that as the user's prompt being truncated and do not ask the user to paste the source solely because an excerpt was compacted. If no authoritative source material is available, or the source itself says the team should not implement yet, say that clearly as a blocker.`,
        },
        {
            role: 'user',
            content: `Mode: ${options.mode}\nHuman request:\n${options.displayText || options.userText}`,
        },
    ];
}

function createConsultWorkingBlock(teamName: string): WorkingBlock {
    return {
        id: `dev-team-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        status: 'in_progress',
        title: `${teamName} standup`,
        hidden: true,
        entries: [],
        startedAt: Date.now(),
    };
}

function createConsultActionEntry(member: DevTeamMember, agent: CustomAgentDef | undefined, planned?: DevTeamPlanStep): WorkingBlockActionEntry {
    return {
        id: `consult-${member.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        kind: 'action',
        text: `Consulting ${member.role}`,
        detail: planned?.purpose || (agent?.name ? `Using ${agent.name}` : permissionDetail(member.permission)),
        actionType: 'review',
        status: 'running',
        icon: 'loading',
        createdAt: Date.now(),
    };
}

function normalizeStepAfterRoomBlocker(step: DevTeamPlanStep, room: DevTeamRoomMessage[]): DevTeamPlanStep {
    if (step.phase !== 'execute' || !room.some(message => message.blocking)) { return step; }
    return {
        ...step,
        phase: 'review',
        intent: step.intent === 'implementer' ? 'reviewer' : step.intent,
        purpose: `Review the blocker before implementation and state exactly what would be needed to proceed. ${step.purpose}`,
    };
}

function createTeamRoomEvent(team: DevTeamDef, status: DevTeamRoomEvent['status'], title: string, detail?: string): DevTeamRoomEvent {
    return {
        teamId: team.id,
        teamName: team.name,
        status,
        title: `${team.name}: ${title}`,
        detail,
    };
}

function createMemberRoomEvent(
    team: DevTeamDef,
    member: DevTeamMember,
    agent: CustomAgentDef | undefined,
    step: DevTeamPlanStep,
    status: DevTeamRoomEvent['status'],
    detail?: string,
): DevTeamRoomEvent {
    const statusText = status === 'started'
        ? 'joined the standup'
        : status === 'blocked'
            ? 'reported a blocker'
            : status === 'failed'
                ? 'was unavailable'
                : 'finished their turn';
    return {
        teamId: team.id,
        teamName: team.name,
        memberRole: member.role,
        agentName: agent?.name,
        permission: member.permission,
        phase: step.phase,
        status,
        title: `${member.role} ${statusText}`,
        detail,
    };
}

function permissionDetail(permission: DevTeamMember['permission']): string {
    if (permission === 'write') { return 'Implementation perspective'; }
    if (permission === 'read') { return 'Read-only perspective'; }
    return 'Review perspective';
}

function summarizeForWorkingDetail(text: string): string {
    const compact = text.replace(/\s+/g, ' ').trim();
    return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}

function summarizeConsultError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err ?? 'Unknown error');
    const unsupported = raw.match(/Unsupported parameter: ['"]?([^'".]+)['"]?/i);
    if (unsupported) { return `Model rejected parameter: ${unsupported[1]}`; }
    const apiStatus = raw.match(/(?:responses|chat completions)?\s*API\s*(\d{3})/i);
    if (apiStatus) { return `Model request failed with HTTP ${apiStatus[1]}`; }
    const compact = raw.replace(/\s+/g, ' ').trim();
    return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}

function formatConsultSummary(successful: number, failed: number): string {
    const consulted = successful === 1 ? '1 standup turn' : `${successful} standup turns`;
    if (failed === 0) { return consulted; }
    const failedText = failed === 1 ? '1 unavailable' : `${failed} unavailable`;
    return `${consulted}, ${failedText}`;
}

function formatGroundingForConsult(agentName: string, docs: Awaited<ReturnType<typeof runSearch>>, citations: Citation[]): string {
    if (docs.length === 0) { return `${agentName} knowledge search found no matching documents.`; }
    const sections = docs.map((doc, index) => {
        const citation = citations[index];
        const title = citation?.title || `Result ${index + 1}`;
        const source = citation?.url ? `\nSource: ${citation.url}` : '';
        const content = pickGroundingContent(doc.fields) || doc.captionText || citation?.snippet;
        return `### [${index + 1}] ${title}${source}\n${content || 'No content field or snippet available.'}`;
    });
    return `Knowledge source: ${agentName}\n${sections.join('\n\n')}`;
}

function pickGroundingContent(fields: Record<string, unknown>): string | undefined {
    for (const key of ['content', 'text', 'chunk', 'body', 'markdown', 'description', 'summary']) {
        const value = fields[key];
        if (typeof value === 'string' && value.trim()) {
            return value.length > 3500 ? `${value.slice(0, 3497)}...` : value;
        }
    }
    return undefined;
}

export const __test = {
    buildLeadOrchestrationMessages,
    parseLeadOrchestrationPlan,
    mergeLeadPlanWithFallback,
    completeTeamRoomPlan,
    buildRoomManagerMessages,
    parseRoomManagerDecision,
    decisionToPlanStep,
    formatRoomHistory,
    buildMemberConsultMessages,
    formatGroundingForConsult,
    formatConsultSummary,
    normalizeStepAfterRoomBlocker,
    summarizeConsultError,
    isBlockingConsultText,
    enrichConsultTextWithGrounding,
    compactGroundingForStandup,
    compactGroundingSectionWithHeading,
    truncateGroundingSection,
    shouldRunKnowledgeInventoryGrounding,
    buildInventoryGroundingQueries,
    buildMemberGroundingQueries,
    buildDetailGroundingQueries,
    groundingTopKForRequest,
    mergeGroundingDocs,
    coerceMemberIntent,
};
