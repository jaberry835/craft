# AI Config Spec

## Goal

Allow AI behavior to be configured at the agent level without forcing us to duplicate model connectors.

Today the app already supports some model settings, but they live mostly on the Azure OpenAI connector:

- `temperature`
- `maxTokens`
- `deployment`
- `apiVersion`
- `authMode`

That works for environment/resource-level defaults, but it is the wrong place for persona-specific behavior. Two agents can share the same Azure OpenAI connection while still needing different creativity, verbosity, and response limits.

## Recommendation

Use a layered config model:

1. Connector-level settings remain the infrastructure default for a model endpoint.
2. Agent-level settings become behavior overrides for a specific agent persona.
3. Runtime request options remain the highest-precedence per-run override surface when we need one later.

This gives us the right ownership boundary:

- Connector config answers: which model/resource/auth endpoint do we call?
- Agent config answers: how should this agent behave when it calls that model?

## Proposed Precedence

At runtime, AI settings should resolve in this order:

1. Per-run request override
2. Agent-level override
3. Connector-level default
4. Hardcoded runtime fallback

That keeps current behavior stable while letting us add per-agent control incrementally.

## Phase 1 Scope

Implement the smallest useful slice first.

### Agent-Level Settings To Add

- `temperature?: number`
- `maxTokens?: number`
- `reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh'`

Notes:

- `reasoningEffort` already exists on agents and should remain agent-level.
- `temperature` and `maxTokens` should move from connector-only to connector-default plus agent-override.
- If an agent leaves either field unset, the connector default remains in effect.

### Settings To Defer

Do not add all possible OpenAI knobs in the first pass.

Defer these until we have a clear product need:

- `topP`
- `presencePenalty`
- `frequencyPenalty`
- `stopSequences`
- `seed`
- `responseFormat`
- `jsonMode`
- `toolChoice`
- `parallelToolCalls`

These are valid future settings, but they add UI and validation complexity quickly. We should avoid turning the agent editor into a raw SDK surface.

## Future Phase 2 Settings

Once Phase 1 is stable, add a second-tier advanced settings group:

- `topP?: number`
- `verbosity?: 'concise' | 'balanced' | 'detailed'`
- `toolUseMode?: 'auto' | 'minimal' | 'eager'`
- `groundingMode?: 'balanced' | 'strict' | 'off'`

These are more product-friendly than exposing every raw inference parameter.

## Data Model Changes

### Server Types

Add a reusable type:

```ts
export interface AgentAiSettings {
	temperature?: number;
	maxTokens?: number;
	reasoningEffort?: ReasoningEffort;
}
```

Update agent definitions:

```ts
export interface AgentDefinition {
	id: string;
	name: string;
	description: string;
	instructions: string;
	modelConnectionId: string;
	reasoningEffort?: ReasoningEffort;
	aiSettings?: AgentAiSettings;
	tools: string[];
	groundingSources: AgentGroundingSource[];
	mcpServerIds?: string[];
}
```

Notes:

- Keep `reasoningEffort` at the top level for backward compatibility initially.
- During rollout, `aiSettings.reasoningEffort` is optional.
- Later we can consolidate into `aiSettings` if we want a cleaner shape.

### Request Resolution Model

Before building the Azure OpenAI request, resolve effective settings:

```ts
const effectiveTemperature = runOverride.temperature
	?? agent.aiSettings?.temperature
	?? connection.temperature
	?? 0.2;

const effectiveMaxTokens = runOverride.maxTokens
	?? agent.aiSettings?.maxTokens
	?? connection.maxTokens
	?? 1200;

const effectiveReasoningEffort = runOverride.reasoningEffort
	?? agent.aiSettings?.reasoningEffort
	?? agent.reasoningEffort
	?? 'medium';
```

## Persistence Model

Agent-level AI settings should persist wherever agents already persist.

That means:

- Shared admin agents: `config/agents.json` or shared Cosmos config
- Workspace-local agents: workspace config store

This is the correct place because these settings belong to the agent persona, not to environment secrets or connector infra.

## UI Changes

### Admin Custom Agents

In the existing Custom Agents editor, add an `AI Settings` section.

Fields:

1. `Temperature`
	 - Number input
	 - Range: `0.0` to `2.0`
	 - Step: `0.1`
	 - Empty means: inherit from connector

2. `Max output tokens`
	 - Number input
	 - Range: `1` to a reasonable upper bound such as `8192`
	 - Empty means: inherit from connector

3. `Reasoning effort`
	 - Existing selector remains
	 - Clarify label text to show this is agent behavior, not connector configuration

### Workspace Custom Agents

Expose the same fields in workspace-scoped custom agents so teams can override behavior without changing shared admin agents.

### Connector Editor

Keep connector-level `temperature` and `maxTokens`, but relabel them to make their purpose clear:

- `Default temperature`
- `Default max output tokens`

That avoids confusion with agent-level overrides.

## API Changes

### Agent Save/Update Requests

Extend these request contracts:

- `AgentCreateRequest`
- `AgentUpdateRequest`

Add:

```ts
aiSettings?: {
	temperature?: number;
	maxTokens?: number;
	reasoningEffort?: ReasoningEffort;
}
```

Backward compatibility:

- Existing agents without `aiSettings` continue to work.
- Existing `reasoningEffort` field continues to be honored.

## Runtime Changes

### Best Implementation Path

Do not modify the connector definition to copy agent settings onto the connection.

Instead:

1. Resolve the selected agent.
2. Resolve the selected model connection.
3. Build an effective request settings object from both.
4. Pass that into the Azure OpenAI request builder.

This is cleaner because it keeps agent behavior and connection infrastructure separate.

### Suggested Code Shape

Add a small resolver function in the agent runtime layer, not in the connector store.

Example:

```ts
interface EffectiveModelSettings {
	temperature: number;
	maxTokens: number;
	reasoningEffort: ReasoningEffort;
}
```

Likely owning surfaces:

- `simpleJuniorAgent.ts`
- `juniorAgentLoop.ts`
- `azureOpenAiChatClient.ts`

The runtime should pass resolved values into the chat client instead of forcing the chat client to know how to merge agent and connector config itself.

## Validation Rules

### Temperature

- allow empty
- if provided, must be a valid number
- clamp or reject values outside `0.0` to `2.0`

### Max Tokens

- allow empty
- if provided, must be an integer
- must be greater than `0`

### Reasoning Effort

- must be one of the supported enum values

## UX Notes

### Inheritance

We should show inherited behavior clearly.

Examples:

- empty field placeholder: `Inherit connector default`
- help text: `Leave blank to use the connector default`

### Avoid Overconfiguration

Do not expose ten advanced fields on day one. Most users need:

- deterministic vs creative behavior
- short vs long responses
- reasoning effort

Anything beyond that should be hidden behind a future advanced section.

## Rollout Plan

### Slice 1

- add `aiSettings` to agent contracts
- persist it for shared and workspace agents
- add admin/workspace custom agent UI for `temperature` and `maxTokens`
- resolve effective values at runtime
- preserve connector defaults as fallback

### Slice 2

- relabel connector settings as defaults
- improve inherited-value UX
- add read-only display of effective resolved settings in the agent editor

### Slice 3

- consider advanced agent settings such as `topP` or tool-use policy
- add per-run overrides if chat workflows need temporary tuning

## Acceptance Criteria

1. A shared admin agent can set its own temperature without requiring a duplicate connector.
2. A workspace custom agent can override max tokens independently of the shared connector.
3. Existing agents and connectors continue to work without migration errors.
4. If an agent-level setting is omitted, the connector-level default is used.
5. The UI makes it clear which values are explicit and which are inherited.

## Recommended Next Implementation Task

Implement Slice 1 only.

That gives us the real value with minimal surface area:

- `temperature`
- `maxTokens`
- existing `reasoningEffort`
- inheritance from connector defaults

That is the best next step because it solves the immediate problem, fits the current architecture, and avoids turning AI config into an unbounded settings dump.

