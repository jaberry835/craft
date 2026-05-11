import { describe, expect, it } from 'vitest';
import { __test, buildDevTeamConsultContext, DevTeamConsultResult, getBlockingDevTeamConsultResults, planDevTeamMembers, selectDevTeamConsultMembers, selectDevTeamExecutionResults } from '../src/devTeamRuntime';
import { DevTeamDef } from '../src/devTeams';

const team: DevTeamDef = {
    id: 'feature-team',
    name: 'Feature Team',
    members: [
        { id: 'planner', role: 'Planner', permission: 'review' },
        { id: 'sme', role: 'Track Day SME', permission: 'read' },
        { id: 'implementer', role: 'Implementer', permission: 'write' },
    ],
    routing: [
        { id: 'planning', pattern: 'plan|requirements|scope', memberIds: ['planner', 'sme'] },
        { id: 'broken', pattern: '[track', memberIds: ['sme'] },
        { id: 'implementation', pattern: 'build|implement', memberIds: ['implementer'] },
    ],
};

describe('selectDevTeamConsultMembers', () => {
    it('selects routed members when a pattern matches', () => {
        const members = selectDevTeamConsultMembers(team, 'help me plan requirements for a track forum');
        expect(members.map(member => member.id)).toEqual(['planner', 'sme']);
    });

    it('falls back to token matching for invalid regex patterns', () => {
        const members = selectDevTeamConsultMembers(team, 'track day instructors need an event category');
        expect(members.map(member => member.id)).toEqual(['sme']);
    });

    it('consults the whole team when no route matches', () => {
        const members = selectDevTeamConsultMembers(team, 'what should we do next?');
        expect(members.map(member => member.id)).toEqual(['planner', 'sme', 'implementer']);
    });
});

describe('planDevTeamMembers', () => {
    it('adds explicitly mentioned SMEs before write members even when routing only names engineers', () => {
        const hrTeam: DevTeamDef = {
            id: 'balanced',
            name: 'Balanced Dev Team',
            members: [
                { id: 'lead', role: 'Lead Engineer', permission: 'write' },
                { id: 'reviewer', role: 'Code Reviewer', permission: 'review' },
                { id: 'hr-sme', role: 'HR SME', agentId: 'hr-agent', permission: 'read' },
            ],
            routing: [
                { id: 'implementation', pattern: 'build|create|implement', memberIds: ['lead'] },
            ],
        };
        const plan = planDevTeamMembers(hrTeam, [
            { id: 'hr-agent', name: 'HR', description: 'Knows company HR policies and employee guidance.', systemPrompt: 'Use official HR policy facts.', scope: 'workspace' },
        ], 'Build a simple HR page. The HR SME should know our specific policies to assist.');
        expect(plan.map(step => step.member.role)).toEqual(['HR SME', 'Lead Engineer']);
        expect(plan[0].phase).toBe('consult');
        expect(plan[1].phase).toBe('execute');
        expect(plan[0].purpose).toMatch(/Explicitly mentioned|HR-specific|domain-specific/);
    });

    it('uses capability matching to include domain members for policy requests', () => {
        const policyTeam: DevTeamDef = {
            id: 'policy',
            name: 'Policy Team',
            members: [
                { id: 'engineer', role: 'Engineer', permission: 'write' },
                { id: 'people-policy', role: 'People Policy Expert', permission: 'read' },
            ],
        };
        const plan = planDevTeamMembers(policyTeam, [], 'Create a page using our employee policies and workplace guidance.');
        expect(plan.map(step => step.member.role)).toEqual(['People Policy Expert', 'Engineer']);
    });

    it('leaves role interpretation to the lead plan for write-capable custom agents', () => {
        const flexibleTeam: DevTeamDef = {
            id: 'flexible-team',
            name: 'Flexible Team',
            members: [
                { id: 'source-agent', role: 'Source Agent', agentId: 'source', permission: 'write' },
                { id: 'builder', role: 'Builder', permission: 'write' },
            ],
        };
        const plan = planDevTeamMembers(flexibleTeam, [
            { id: 'source', name: 'Source', description: 'Retrieves source-of-truth facts.', systemPrompt: 'Provide cited facts.', scope: 'workspace' },
        ], 'Create a page using source-of-truth content.');

        expect(plan.map(step => step.member.id)).toEqual(['source-agent', 'builder']);
    });
});

describe('lead orchestration helpers', () => {
    it('builds a roster prompt from linked agent descriptions and instructions', () => {
        const linkedTeam: DevTeamDef = {
            ...team,
            members: team.members.map(member => member.id === 'sme' ? { ...member, agentId: 'track-agent' } : member),
        };
        const messages = __test.buildLeadOrchestrationMessages(
            linkedTeam,
            [
                {
                    id: 'track-agent',
                    name: 'Track SME',
                    description: 'Knows track-day domain rules.',
                    systemPrompt: 'Use official track policy facts before implementation.',
                    scope: 'workspace',
                },
            ],
            { mode: 'agent', userText: 'Build a track-day page using SME knowledge.' },
        );
        expect(messages[0].content).toContain('lead coordinator');
        expect(messages[0].content).toContain('Return JSON only');
        expect(messages[0].content).toContain('enumerate the relevant grounded sources and extract the source-backed content');
        expect(messages[1].content).toContain('role: Track Day SME');
        expect(messages[1].content).toContain('permission: read');
        expect(messages[1].content).toContain('description: Knows track-day domain rules.');
        expect(messages[1].content).toContain('instructions: Use official track policy facts before implementation.');
    });

    it('parses lead JSON assignments and coerces read-only execute phases', () => {
        const plan = __test.parseLeadOrchestrationPlan(JSON.stringify({
            steps: [
                { memberId: 'sme', phase: 'execute', intent: 'specialist', purpose: 'Provide exact domain facts and blockers from the knowledge base.' },
                { memberId: 'implementer', phase: 'execute', intent: 'implementer', purpose: 'Build only after SME facts are available.' },
                { memberId: 'missing', phase: 'consult', purpose: 'Ignore invalid member.' },
            ],
        }), team, []);
        expect(plan.map(step => [step.member.id, step.phase, step.intent, step.source])).toEqual([
            ['sme', 'consult', 'specialist', 'lead'],
            ['implementer', 'execute', 'implementer', 'lead'],
        ]);
        expect(plan[0].purpose).toContain('exact domain facts');
    });

    it('adds a true implementer when the lead only selected a write-capable source member', () => {
        const balanced: DevTeamDef = {
            id: 'balanced',
            name: 'Balanced Dev Team',
            members: [
                { id: 'hr-sme', role: 'HR SME', agentId: 'hr', permission: 'write' },
                { id: 'lead', role: 'Lead Engineer', permission: 'write' },
                { id: 'reviewer', role: 'Code Reviewer', permission: 'review' },
            ],
        };
        const leadPlan = __test.parseLeadOrchestrationPlan(JSON.stringify({
            steps: [
                { memberId: 'hr-sme', phase: 'execute', intent: 'specialist', purpose: 'Provide source-backed HR content.' },
            ],
        }), balanced, [{ id: 'hr', name: 'HR', description: 'HR source of truth.', systemPrompt: 'Use HR sources.', scope: 'workspace' }]);
        const fallback = planDevTeamMembers(balanced, [], 'Create an HR info site based on our HR policies.');
        const merged = __test.mergeLeadPlanWithFallback(leadPlan, fallback);
        const completed = __test.completeTeamRoomPlan(merged, balanced, []);

        expect(completed.map(step => [step.member.id, step.phase, step.intent])).toEqual([
            ['hr-sme', 'consult', 'specialist'],
            ['reviewer', 'review', 'reviewer'],
            ['lead', 'execute', 'implementer'],
        ]);
    });

        it('turns later implementation passes into review after a blocker so the standup continues without editing', () => {
            const executeStep = planDevTeamMembers(team, [], 'build the track page').find(step => step.member.id === 'implementer');
            expect(executeStep?.phase).toBe('execute');

            const adjusted = __test.normalizeStepAfterRoomBlocker(executeStep!, [{
                speakerId: 'sme',
                speakerRole: 'Track Day SME',
                phase: 'consult',
                assignment: 'Check source facts.',
                text: 'Need authoritative source material before implementation.',
                blocking: true,
            }]);

            expect(adjusted.phase).toBe('review');
            expect(adjusted.intent).toBe('reviewer');
            expect(adjusted.purpose).toContain('Review the blocker before implementation');
        });
});

describe('Dev Team standup orchestration helpers', () => {
    it('builds a manager prompt with roster status, seed plan, and shared history', () => {
        const messages = __test.buildRoomManagerMessages(
            team,
            [],
            { mode: 'agent', userText: 'Build a policy-backed track-day page.' },
            [
                { member: team.members[1], phase: 'consult', purpose: 'Provide domain facts.', source: 'lead' },
                { member: team.members[2], phase: 'execute', intent: 'implementer', purpose: 'Build after SME facts.', source: 'lead' },
            ],
            [
                {
                    speakerId: 'sme',
                    speakerRole: 'Track Day SME',
                    phase: 'consult',
                    assignment: 'Provide exact facts.',
                    text: 'Use run group, instructor, and safety requirements.',
                },
            ],
            new Set(['sme']),
        );

        expect(messages[0].content).toContain('lead manager');
        expect(messages[0].content).toContain('Pick only one next speaker');
        expect(messages[0].content).toContain('extract usable content before selecting an implementer');
        expect(messages[0].content).toContain('rather than creating empty shells');
        expect(messages[1].content).toContain('sme: Track Day SME; permission=read; status=already spoke');
        expect(messages[1].content).toContain('implementer: Implementer; permission=write; status=available');
        expect(messages[1].content).toContain('Turn 1: Track Day SME');
    });

    it('parses manager JSON and converts it into a safe plan step', () => {
        const decision = __test.parseRoomManagerDecision('```json\n{"nextMemberId":"implementer","phase":"execute","intent":"implementer","assignment":"Build only from the SME facts.","reason":"Ready for implementation","terminate":false}\n```');
        const step = __test.decisionToPlanStep(decision, team, [], new Set(['sme']));

        expect(step?.member.id).toBe('implementer');
        expect(step?.phase).toBe('execute');
        expect(step?.intent).toBe('implementer');
        expect(step?.purpose).toBe('Build only from the SME facts.');
    });

    it('coerces unsafe manager execute assignments for read-only members', () => {
        const decision = __test.parseRoomManagerDecision('{"nextMemberId":"sme","phase":"execute","assignment":"Implement it."}');
        const step = __test.decisionToPlanStep(decision, team, [], new Set());

        expect(step?.member.id).toBe('sme');
        expect(step?.phase).toBe('consult');
    });

    it('coerces execute assignments unless the manager marks the intent as implementer', () => {
        const decision = __test.parseRoomManagerDecision('{"nextMemberId":"implementer","phase":"execute","intent":"specialist","assignment":"Provide source facts."}');
        const step = __test.decisionToPlanStep(decision, team, [], new Set());

        expect(step?.member.id).toBe('implementer');
        expect(step?.intent).toBe('specialist');
        expect(step?.phase).toBe('consult');
    });

    it('includes shared standup history in member consult prompts', () => {
        const messages = __test.buildMemberConsultMessages(
            team,
            team.members[2],
            undefined,
            { mode: 'agent', userText: 'Build a page.' },
            undefined,
            { member: team.members[2], phase: 'execute', purpose: 'Build from prior SME facts.', source: 'lead' },
            [
                {
                    speakerId: 'sme',
                    speakerRole: 'Track Day SME',
                    phase: 'consult',
                    assignment: 'Provide facts.',
                    text: 'Approved facts: use novice, intermediate, and advanced run groups.',
                },
            ],
        );

        expect(messages[0].content).toContain('Shared Dev Team standup so far');
        expect(messages[0].content).toContain('Approved facts');
        expect(messages[0].content).toContain('Lead assignment: Build from prior SME facts.');
        expect(messages[0].content).toContain('extract the concrete content, fields, sections, facts, labels, dates, contacts, and exclusions');
        expect(messages[0].content).toContain('Do not merely say that content exists');
    });
});

describe('buildDevTeamConsultContext', () => {
    it('formats member notes for coordinator synthesis', () => {
        const results: DevTeamConsultResult[] = [
            { member: team.members[0], text: 'Clarify public read/private write and category list.' },
            { member: team.members[1], agent: { id: 'hpde-sme', name: 'HPDE SME', systemPrompt: 'Know HPDE.', scope: 'workspace' }, text: 'Track forums need run group, event, safety, and instructor context.' },
        ];
        const context = buildDevTeamConsultContext(results);
        expect(context).toContain('Junior Dev Team Consult Notes');
        expect(context).toContain('### Planner');
        expect(context).toContain('### Track Day SME (HPDE SME)');
        expect(context).toContain('public read/private write');
        expect(context).toContain('Consulted roles: Planner, Track Day SME.');
        expect(context).toContain('Only label final-answer sections with consulted roles');
    });

    it('makes failed consults explicit without treating them as advice', () => {
        const results: DevTeamConsultResult[] = [
            { member: team.members[0], text: 'Clarify the core categories.' },
            { member: team.members[2], text: '', error: 'Model rejected parameter: temperature' },
        ];
        const context = buildDevTeamConsultContext(results);
        expect(context).toContain('One selected member was unavailable');
        expect(context).toContain('do not invent their perspective');
        expect(context).toContain('Consult unavailable: Model rejected parameter: temperature');
    });
});

describe('consult progress summaries', () => {
    it('summarizes partial consult failures', () => {
        expect(__test.formatConsultSummary(0, 2)).toBe('0 standup turns, 2 unavailable');
        expect(__test.formatConsultSummary(2, 1)).toBe('2 standup turns, 1 unavailable');
    });

    it('condenses noisy model errors', () => {
        const err = new Error('responses API 400: {"error":{"message":"Unsupported parameter: \'temperature\' is not supported with this model."}}');
        expect(__test.summarizeConsultError(err)).toBe('Model rejected parameter: temperature');
    });
});

describe('selectDevTeamExecutionResults', () => {
    it('selects only successful write members for Level 3 execution', () => {
        const results: DevTeamConsultResult[] = [
            { member: team.members[0], text: 'Plan the work.' },
            { member: team.members[1], text: 'Domain constraints.' },
            { member: team.members[2], text: 'I can implement this.', phase: 'execute', intent: 'implementer' },
            { member: { id: 'docs', role: 'Docs Writer', permission: 'write' }, text: '', error: 'Model request failed' },
        ];
        expect(selectDevTeamExecutionResults(results).map(result => result.member.role)).toEqual(['Implementer']);
    });

    it('blocks write execution when an upstream SME says authoritative content is missing', () => {
        const results: DevTeamConsultResult[] = [
            {
                member: { id: 'hr-sme', role: 'HR SME', permission: 'read' },
                text: 'Blocked: actual HR-provided source material is not present. Need approved policy text before implementation.',
                phase: 'consult',
                blocking: true,
            },
            { member: team.members[2], text: 'I can implement once HR input exists.', phase: 'execute' },
        ];
        expect(getBlockingDevTeamConsultResults(results).map(result => result.member.role)).toEqual(['HR SME']);
        expect(selectDevTeamExecutionResults(results)).toEqual([]);
        expect(buildDevTeamConsultContext(results)).toContain('Execution blocked by: HR SME');
    });

    it('detects blocking language but not explicit no-blocker language', () => {
        expect(__test.isBlockingConsultText('Need actual approved policy text before implementation.')).toBe(true);
        expect(__test.isBlockingConsultText('No blockers found; approved source text is available.')).toBe(false);
        expect(__test.isBlockingConsultText('Full build is blocked, but you can build a minimal safe v1 using only the grounded Dress Code content and excluding unsupported policy pages.')).toBe(false);
    });

    it('allows write execution when review blocks full scope but approves a bounded safe build', () => {
        const results: DevTeamConsultResult[] = [
            {
                member: { id: 'reviewer', role: 'Code Reviewer', permission: 'review' },
                text: 'Full HR site build is blocked, but the team can build a minimal safe v1 using only confirmed Dress Code content and excluding unsupported pages.',
                phase: 'review',
                blocking: __test.isBlockingConsultText('Full HR site build is blocked, but the team can build a minimal safe v1 using only confirmed Dress Code content and excluding unsupported pages.'),
            },
            { member: team.members[2], text: 'I can implement the bounded safe build.', phase: 'execute', intent: 'implementer' },
        ];

        expect(getBlockingDevTeamConsultResults(results)).toEqual([]);
        expect(selectDevTeamExecutionResults(results).map(result => result.member.role)).toEqual(['Implementer']);
        expect(buildDevTeamConsultContext(results)).not.toContain('Execution blocked by:');
    });
});

describe('grounded consult prompts', () => {
    it('includes retrieved knowledge and citation guidance in member consult messages', () => {
        const messages = __test.buildMemberConsultMessages(
            team,
            team.members[1],
            { id: 'hpde-sme', name: 'HPDE SME', systemPrompt: 'Know HPDE.', scope: 'workspace' },
            { mode: 'agent', userText: 'plan a track forum' },
            'Knowledge source: HPDE SME\n### [1] Run Group Guide\nNovice drivers need instructor matching.',
        );
        expect(messages[0].content).toContain('Grounded knowledge retrieved for this consult');
        expect(messages[0].content).toContain('Run Group Guide');
        expect(messages[0].content).toContain('cite relevant items by bracket number');
        expect(messages[0].content).toContain('Do not invent HR, legal, privacy, approval, canonical-document, or publication blockers');
        expect(messages[0].content).toContain('If only part of the requested content is grounded, recommend implementing the grounded portion');
    });

    it('formats grounding documents for consult synthesis', () => {
        const text = __test.formatGroundingForConsult('HPDE SME', [
            {
                fields: { title: 'Run Group Guide', content: 'Drivers need run group, experience, and instructor status.' },
                captionText: 'Drivers need run group context.',
            },
        ] as any, [
            { index: 1, title: 'Run Group Guide', snippet: 'Drivers need run group context.' },
        ]);
        expect(text).toContain('Knowledge source: HPDE SME');
        expect(text).toContain('### [1] Run Group Guide');
        expect(text).toContain('Drivers need run group, experience, and instructor status.');
    });

    it('prefers full document content over short semantic captions for Dev Team grounding', () => {
        const fullPolicy = [
            'At Contoso, creative expression through clothing enhances workplace morale.',
            'Thursday: Throwback Thursday is mandatory and rotates monthly by decade theme.',
            'Friday: Fancy Hat Friday requires a minimum hat brim of 3 inches or height of 6 inches.',
            'Baseball caps are not acceptable unless bedazzled with at least 50 rhinestones.',
            'Penguin Protocol suspends theme days during client visits.',
        ].join('\n');
        const text = __test.formatGroundingForConsult('HR SME', [
            {
                fields: { title: 'Dress Code Policy', content: fullPolicy },
                captionText: 'Dress Code and Themed Attire Policy excerpt.',
            },
        ] as any, [
            { index: 1, title: 'Dress Code Policy', snippet: 'Dress Code and Themed Attire Policy excerpt.' },
        ]);

        expect(text).toContain('Throwback Thursday is mandatory');
        expect(text).toContain('minimum hat brim of 3 inches');
        expect(text).toContain('50 rhinestones');
        expect(text).not.toContain('No content field or snippet available');
    });

    it('promotes retrieved grounding into standup notes when the member returns no narrative', () => {
        const text = __test.enrichConsultTextWithGrounding('', 'Knowledge source: HR SME\n### [1] Dress Code Policy\nEmployees may wear themed attire on approved days.');

        expect(text).toContain('Grounded source excerpts available to this member');
        expect(text).toContain('Dress Code Policy');
        expect(text).toContain('No additional member narrative was returned');
        expect(__test.isBlockingConsultText(text)).toBe(false);
    });

    it('includes promoted grounding in shared standup history for later members', () => {
        const groundedText = __test.enrichConsultTextWithGrounding('', `Knowledge source: HR SME\n### [1] Dress Code Policy\n${'Policy detail. '.repeat(180)}Thursday theme days are mandatory. Friday hats require a 3 inch brim or 6 inch height. Baseball caps need 50 rhinestones.`);
        const messages = __test.buildMemberConsultMessages(
            team,
            team.members[2],
            undefined,
            { mode: 'agent', userText: 'Create an HR info site.' },
            undefined,
            { member: team.members[2], phase: 'execute', purpose: 'Build from HR SME source excerpts.', source: 'lead' },
            [
                {
                    speakerId: 'hr-sme',
                    speakerRole: 'HR SME',
                    phase: 'consult',
                    assignment: 'Provide HR source facts.',
                    text: groundedText,
                },
            ],
        );

        expect(messages[0].content).toContain('Shared Dev Team standup so far');
        expect(messages[0].content).toContain('Dress Code Policy');
        expect(messages[0].content).toContain('Thursday theme days are mandatory');
        expect(messages[0].content).toContain('50 rhinestones');
    });

    it('preserves every retrieved HR document when grounding is compacted for standup', () => {
        const grounding = [
            'Knowledge source: HR SME',
            `### [1] Dress Code Policy\n${'Dress policy details. '.repeat(180)}`,
            `### [2] Employee PAR Records\nHR Confidential employee-specific ratings and identifiers. ${'Confidential detail. '.repeat(120)}`,
            `### [3] Pet Leave Policy\nPet bereavement and bonding leave details. ${'Pet leave detail. '.repeat(120)}`,
            `### [4] Retirement Bonus Policy\nRetirement bonus eligibility and deferral rules. ${'Retirement detail. '.repeat(120)}`,
            `### [5] Meeting Snack Policy\nApproved meeting snack guidance and pantry etiquette. ${'Snack detail. '.repeat(120)}`,
        ].join('\n\n');

        const text = __test.enrichConsultTextWithGrounding('', grounding);
        const history = __test.formatRoomHistory([{
            speakerId: 'hr-sme',
            speakerRole: 'HR SME',
            phase: 'consult',
            assignment: 'Provide HR source facts.',
            text,
        }]);

        expect(history).toContain('### [1] Dress Code Policy');
        expect(history).toContain('### [2] Employee PAR Records');
        expect(history).toContain('### [3] Pet Leave Policy');
        expect(history).toContain('### [4] Retirement Bonus Policy');
        expect(history).toContain('### [5] Meeting Snack Policy');
        expect(history).toContain('Approved meeting snack guidance');
    });

    it('labels compacted grounding as retrieved excerpts rather than missing user input', () => {
        const text = __test.enrichConsultTextWithGrounding('', `Knowledge source: Support KB\n### [1] Long Runbook\n${'Detailed step. '.repeat(1200)}`);
        const compacted = __test.truncateGroundingSection(`### [1] Long Runbook\n${'Detailed step. '.repeat(1200)}`, 900);

        expect(text).toContain('These excerpts may be compacted for the standup token budget');
        expect(text).toContain('not as a request for more user-provided material');
        expect(compacted).toContain('Source excerpt compacted for standup');
        expect(compacted).toContain('do not ask the user to paste this source');
        expect(__test.isBlockingConsultText(text)).toBe(false);
    });

    it('broadens grounding for custom-agent knowledge inventory requests', () => {
        expect(__test.shouldRunKnowledgeInventoryGrounding('Can you create an HR info site based on our HR policies?')).toBe(true);
        expect(__test.shouldRunKnowledgeInventoryGrounding('Build pages for all current employee policy documents.')).toBe(true);
        expect(__test.shouldRunKnowledgeInventoryGrounding('Create a support portal using all troubleshooting guides.')).toBe(true);
        expect(__test.shouldRunKnowledgeInventoryGrounding('Make an index from the available product docs.')).toBe(true);
        expect(__test.shouldRunKnowledgeInventoryGrounding('What does the snack policy say?')).toBe(false);
        expect(__test.groundingTopKForRequest('Create an HR policy website.', 5)).toBe(12);
        expect(__test.groundingTopKForRequest('Make an index from the available product docs.', 5)).toBe(12);
        expect(__test.groundingTopKForRequest('What does the snack policy say?', 5)).toBe(5);
        expect(__test.buildInventoryGroundingQueries('Can you create an HR info site based on our HR policies?')).toContain('policy');
        expect(__test.buildInventoryGroundingQueries('Create a support portal using all troubleshooting guides.')).toContain('guide');
        expect(__test.buildInventoryGroundingQueries('Make an index from the available product docs.')).toContain('document');
    });

    it('builds grounding queries from arbitrary teammate assignments and agent profiles', () => {
        const queries = __test.buildMemberGroundingQueries(
            'Create a customer support portal from the available knowledge articles.',
            { id: 'support-sme', role: 'Support SME', permission: 'read' },
            {
                id: 'support-agent',
                name: 'Support KB Agent',
                description: 'Knows troubleshooting guides, escalation runbooks, and service outage articles.',
                systemPrompt: 'Use the support knowledge base.',
                scope: 'workspace',
            },
            {
                member: { id: 'support-sme', role: 'Support SME', permission: 'read' },
                phase: 'consult',
                intent: 'specialist',
                purpose: 'Extract the source-backed troubleshooting categories and escalation requirements for the implementer.',
                source: 'lead',
            },
        );

        expect(queries[0]).toContain('customer support portal');
        expect(queries.some(query => query.includes('Extract the source-backed troubleshooting categories'))).toBe(true);
        expect(queries.some(query => query.includes('Support KB Agent'))).toBe(true);
        expect(queries).toContain('guide');
        expect(queries).toContain('content');
    });

    it('deduplicates inventory grounding by source document identity', () => {
        const docs = __test.mergeGroundingDocs(
            [
                { fields: { title: 'Dress Code Policy', content: 'First chunk.' } },
                { fields: { title: 'Retirement Bonus Policy', content: 'Retirement chunk.' } },
            ],
            [
                { fields: { title: 'Dress Code Policy', content: 'Duplicate inventory chunk.' } },
                { fields: { title: 'Meeting Snack Policy', content: 'Snack inventory chunk.' } },
            ],
        );

        expect(docs.map(doc => doc.fields.title)).toEqual([
            'Dress Code Policy',
            'Retirement Bonus Policy',
            'Dress Code Policy',
            'Meeting Snack Policy',
        ]);
        expect(docs.map(doc => doc.fields.content)).toContain('Duplicate inventory chunk.');
    });

    it('builds targeted detail grounding queries from discovered source titles', () => {
        const queries = __test.buildDetailGroundingQueries([
            { fields: { title: 'Dress Code Policy', content: 'Overview chunk.' } },
            { fields: { title: 'Meeting Snack Policy', content: 'Overview chunk.' } },
            { fields: { title: 'Dress Code Policy', content: 'Second chunk.' } },
        ], 'Create a site from all policy documents.');

        expect(queries).toEqual(['Dress Code Policy details', 'Meeting Snack Policy details']);
    });
});
