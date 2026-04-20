"""
Orchestration Pipeline
Two-phase orchestration: Analysis → Pattern Execution → Synthesis.
Extracted from agent_manager.py for maintainability.
"""
from typing import Optional, AsyncIterator
from dataclasses import dataclass, field
import asyncio
import json as json_module
import re

from agent_framework import Agent, AgentSession, Message

from observability import get_logger, should_log_agent, track_performance, MetricType
from services.chatter import ChatterEvent, ChatterEventType


logger = get_logger(__name__)


def _accumulate_usage_from_update(update, token_accumulator: dict[str, int]) -> None:
    """Accumulate input/output token counts from streamed framework updates."""
    contents = getattr(update, "contents", None)
    if not contents:
        return

    for content_item in contents:
        if getattr(content_item, "type", None) != "usage":
            continue
        details = getattr(content_item, "usage_details", None)
        if not details:
            continue

        input_tokens = details.get("input_token_count") if isinstance(details, dict) else getattr(details, "input_token_count", None)
        output_tokens = details.get("output_token_count") if isinstance(details, dict) else getattr(details, "output_token_count", None)

        token_accumulator["input"] = token_accumulator.get("input", 0) + (input_tokens or 0)
        token_accumulator["output"] = token_accumulator.get("output", 0) + (output_tokens or 0)


@dataclass
class AgentResponse:
    """Response from agent execution."""
    agent_id: str
    agent_name: str
    content: str
    tokens_used: int
    metadata: dict
    chatter_events: list[ChatterEvent] = field(default_factory=list)


# =========================================================================
# Default prompts — used when admin has not configured custom prompts
# =========================================================================

DEFAULT_ANALYSIS_PROMPT = """You are an intelligent orchestration agent that routes requests to specialist agents.

YOUR ROLE:
- Analyze each user request to determine how to handle it
- Either answer directly yourself OR delegate to specialist agents
- Output your decision in a structured format

=== AVAILABLE SPECIALIST AGENTS ===
{agent_list}
===================================

DECISION PROCESS:
1. Read the user's request carefully
2. Check if any specialist agent can handle this request
3. If YES: Identify which specialist(s) are needed
4. If NO: You will answer directly

OUTPUT FORMAT:
You MUST respond with a JSON decision block, followed by any direct response if answering yourself.

For delegation to specialists:
```json
{
  "action": "delegate",
  "specialists": ["agent_id_1", "agent_id_2"],
  "contextualized_query": "A fully self-contained rewrite of the user's request that includes all necessary context from the conversation history so a specialist with NO access to prior messages can understand it completely",
  "reasoning": "Brief explanation of why these specialists are needed"
}
```

For direct answer (no specialists needed):
```json
{
  "action": "direct",
  "reasoning": "Brief explanation of why you're answering directly"
}
```
[Then provide your direct answer after the JSON block]

CONTEXTUALIZED QUERY RULES:
When delegating, you MUST provide a "contextualized_query" that:
1. Resolves ALL pronouns and vague references (e.g. "it", "that", "the show", "tell me more") using conversation history
2. Includes specific names, titles, and details from prior messages so the query is fully self-contained
3. Can be understood by a specialist who has NEVER seen the conversation history

DELEGATION RULES:
1. Delegate when the request matches a specialist's domain
2. You can delegate to MULTIPLE specialists if the request spans domains
3. When in doubt about whether a specialist can help, delegate to them
4. Generic questions (greetings, weather, time, general knowledge) = answer directly
5. Domain-specific questions (databases, APIs, documents) = delegate
6. Follow-ups to an existing HTML preview, draft revision requests, approval messages, and iterative design/content tweaks are NOT generic small talk. If a specialist previously generated the draft, delegate back to a specialist rather than answering directly.
"""

DEFAULT_SYNTHESIS_PROMPT = """You are an intelligent orchestration agent synthesizing results from specialist agents.

YOUR ROLE:
- Combine responses from multiple specialist agents into a coherent answer
- Present findings clearly and concisely to the user
- Highlight key information and resolve any conflicts

SPECIALIST RESPONSES:
{specialist_responses}

SYNTHESIS RULES:
1. Combine information logically - don't just concatenate
2. If specialists provided overlapping information, merge it
3. If specialists provided conflicting information, note the discrepancy
4. If a specialist encountered an error, explain what happened
5. Present the final answer as if you gathered the information yourself
6. Use clear formatting (bullet points, sections) for complex responses
7. Do NOT mention "the specialist said" or "the agent reported" - present findings directly

FORMATTING:
- Use markdown for readability when appropriate
- For data/tables, format them clearly
- For errors, explain what went wrong and suggest next steps if possible

Provide your synthesized response to the user now:
"""

# ── Supplement appended to any analysis prompt that lacks the field ──
CONTEXTUALIZED_QUERY_SUPPLEMENT = """

IMPORTANT — CONTEXTUALIZED QUERY:
When delegating to specialists, you MUST include a "contextualized_query" field
in your JSON response.  This is a fully self-contained rewrite of the user's
request that resolves ALL pronouns, vague references (e.g. "it", "that",
"the show", "tell me more"), and implicit context using the conversation history.

The specialist agents have NO access to prior messages — they will only see the
"contextualized_query" text.  If the query references something discussed
earlier, you must spell it out explicitly.


"""

DEFAULT_EVALUATION_PROMPT = """You are evaluating whether the specialist agents have gathered enough information to answer the user's question.

ORIGINAL USER QUESTION:
{user_question}

INFORMATION GATHERED SO FAR:
{gathered_info}

AVAILABLE SPECIALISTS:
{agent_list}

YOUR TASK:
Review what has been learned and decide if we need to investigate further.

EVALUATION CRITERIA:
1. Did we find specific information mentioned (names, companies, data)?
2. Can any of that NEW information be used to query OTHER agents?
3. Are there obvious follow-up queries that would add value?

Examples of when to continue:
- Investigator found "Dr. Smith works at Acme Corp" → ADX Agent should query for Acme Corp employees
- ADX found a list of transactions → Investigator could research the parties involved
- One agent mentioned a related entity that another agent could look up

Examples of when to STOP:
- Agents already queried with the new information
- No new entities/names/companies were discovered
- We've done 3+ rounds already
- The information gathered seems complete

RESPOND WITH JSON:
```json
{
  "continue": true/false,
  "reasoning": "Brief explanation",
  "follow_up_query": "The specific question to ask next (if continuing)",
  "target_agents": ["agent_id_1"] // Which agents should handle the follow-up
}
```
"""


# =========================================================================
# Orchestration helper functions (called by AgentManager)
# =========================================================================

async def run_orchestrator_for_analysis(
    orchestrator_config: dict,
    specialist_configs: list[dict],
    user_message: str,
    session_id: str,
    user_id: str,
    preview_context: Optional[dict],
    create_chat_client_fn,
    cosmos_service,
    embedding_service,
    search_service,
) -> dict:
    """
    Phase 1: Run orchestrator to analyze the request and decide action.

    Uses AgentSession with CosmosHistoryProvider (for automatic
    conversation-history loading) and DocumentRAGProvider (for automatic
    document-context injection) so the orchestrator sees the full
    conversation and any relevant uploaded documents.

    Returns:
        dict with keys:
            - action: "direct" or "delegate"
            - specialists: list of agent IDs to call (if delegate)
            - reasoning: explanation of decision
            - direct_response: response text (if direct action)
            - tokens_input / tokens_output: orchestrator analysis usage
    """
    from services.context_providers import CosmosHistoryProvider, DocumentRAGProvider

    # Build agent list for prompt
    agent_list = []
    agent_id_map = {}  # Map names to IDs for later
    for config in specialist_configs:
        name = config.get("name", "Agent")
        agent_id = config.get("id", "")
        description = config.get("description", "No description")
        agent_list.append(f"- {name} (id: {agent_id}): {description}")
        agent_id_map[name.lower()] = agent_id
        agent_id_map[agent_id] = agent_id  # Also map ID to itself

    preview_source_agent_id = (preview_context or {}).get("source_agent_id")
    preview_source_agent_name = (preview_context or {}).get("source_agent_name")
    preview_action = (preview_context or {}).get("action")
    preview_current_html = (preview_context or {}).get("current_html")

    # When a follow-up comes from an open preview and the preview was produced by
    # a known specialist, route it back to that specialist directly instead of
    # letting the orchestrator reclassify it as a generic direct-answer request.
    if preview_source_agent_id and any(
        config.get("id") == preview_source_agent_id for config in specialist_configs
    ):
        prefix = "The user is responding to an existing HTML preview generated earlier."
        if preview_action == "approval":
            prefix = "The user approved the existing HTML preview and wants the originating agent to continue with the next step."
        elif preview_action == "revision":
            prefix = "The user requested a revision to the existing HTML preview and wants the originating agent to update that draft directly."

        contextualized_query = f"{prefix}\nOriginating agent: {preview_source_agent_name or preview_source_agent_id}\nUser follow-up: {user_message}"
        if preview_current_html:
            contextualized_query += f"\n\nCURRENT HTML DRAFT (source of truth - modify this exact draft unless the user asks for a broader redesign):\n```html\n{preview_current_html}\n```"
        return {
            "action": "delegate",
            "specialists": [preview_source_agent_id],
            "contextualized_query": contextualized_query,
            "reasoning": "Follow-up to an open preview should return to the originating specialist so it can revise or continue its current draft.",
            "tokens_input": 0,
            "tokens_output": 0,
        }

    # Generic fallback: when this is clearly a preview revision/approval flow and
    # there is only one specialist in the session, prefer that specialist instead
    # of letting the orchestrator handle the request directly.
    if preview_action in {"revision", "approval"} and preview_current_html and len(specialist_configs) == 1:
        only_specialist = specialist_configs[0]
        contextualized_query = (
            f"This is a follow-up to an existing HTML preview. "
            f"Preview action: {preview_action}.\n"
            f"User follow-up: {user_message}\n\n"
            f"CURRENT HTML DRAFT (source of truth - modify this exact draft unless the user asks for a broader redesign):\n"
            f"```html\n{preview_current_html}\n```"
        )
        return {
            "action": "delegate",
            "specialists": [only_specialist.get("id")],
            "contextualized_query": contextualized_query,
            "reasoning": "Preview follow-up with a single available specialist should return to that specialist to preserve the draft editing flow.",
            "tokens_input": 0,
            "tokens_output": 0,
        }
    
    # Use admin-configured analysis prompt, or default if not set
    analysis_prompt = orchestrator_config.get("analysis_prompt") or DEFAULT_ANALYSIS_PROMPT
    
    # Format the prompt with agent list
    analysis_prompt = analysis_prompt.replace("{agent_list}", "\n".join(agent_list) if agent_list else "No specialists available")

    # Always append the contextualized-query instruction so that even
    # admin-customized prompts produce a self-contained rewrite for
    # specialists that have no access to conversation history.
    if "contextualized_query" not in analysis_prompt:
        analysis_prompt += CONTEXTUALIZED_QUERY_SUPPLEMENT

    if preview_context:
        analysis_prompt += f"""

PREVIEW FOLLOW-UP CONTEXT:
- This message may be a follow-up to an open HTML preview shown in the UI.
- Preview action: {preview_action or 'unknown'}
- Preview source agent ID: {preview_source_agent_id or 'unknown'}
- Preview source agent name: {preview_source_agent_name or 'unknown'}
- Current preview HTML is attached: {'yes' if preview_current_html else 'no'}

If this is a revision/approval/follow-up to a previously generated preview, prefer routing it back to the same originating specialist unless there is a strong reason not to.
Do not treat preview revisions as generic requests for coding advice or direct explanation when a specialist is available to continue the draft.
"""
    
    # Create chat client
    chat_client = create_chat_client_fn(orchestrator_config)
    
    # Create analysis agent with context providers for automatic
    # history loading and RAG injection (no manual message building).
    # store_inputs/store_outputs default to False so the analysis
    # agent's internal JSON decision is never persisted to Cosmos.
    analysis_agent = chat_client.as_agent(
        name="Analyzer",
        instructions=analysis_prompt,
        context_providers=[
            CosmosHistoryProvider(cosmos_service),
            DocumentRAGProvider(embedding_service, search_service),
        ],
    )
    
    # Create an AgentSession and populate provider-scoped state so the
    # providers know which Cosmos session to query.
    session = analysis_agent.create_session()
    session.state.setdefault("cosmos-history", {}).update({
        "session_id": session_id,
        "user_id": user_id,
        "current_query": user_message,
    })
    session.state.setdefault("document-rag", {}).update({
        "session_id": session_id,
        "user_id": user_id,
        "user_query": user_message,
    })
    
    # Run — providers automatically load history + RAG; the framework
    # adds user_message as the current input.
    response_parts = []
    token_accumulator = {"input": 0, "output": 0}
    async for update in analysis_agent.run(
        user_message, session=session, stream=True
    ):
        _accumulate_usage_from_update(update, token_accumulator)
        if update.text:
            response_parts.append(update.text)
    
    full_response = "".join(response_parts)
    
    if should_log_agent():
        logger.info(f"Orchestrator analysis response:\n{full_response[:500]}...")
    
    # Parse the JSON decision from response
    try:
        # Find JSON block in response
        json_match = re.search(r'```json\s*\n?(.*?)\n?```', full_response, re.DOTALL)
        if json_match:
            decision = json_module.loads(json_match.group(1))
        else:
            # Try to find raw JSON
            json_match = re.search(r'\{[^{}]*"action"[^{}]*\}', full_response, re.DOTALL)
            if json_match:
                decision = json_module.loads(json_match.group())
            else:
                # No JSON found - assume direct answer
                decision = {"action": "direct", "reasoning": "Could not parse decision"}
        
        # Extract any text after the JSON as the direct response
        if decision.get("action") == "direct":
            # Get text after the JSON block
            if json_match:
                post_json = full_response[json_match.end():].strip()
                if post_json:
                    decision["direct_response"] = post_json
                else:
                    decision["direct_response"] = full_response
            else:
                decision["direct_response"] = full_response
        
        # Normalize specialist IDs
        if decision.get("action") == "delegate":
            specialists = decision.get("specialists", [])
            # Collect the set of valid agent IDs for fuzzy matching
            valid_agent_ids = {v for v in agent_id_map.values()}
            normalized = []
            for spec in specialists:
                spec_lower = spec.lower()
                if spec_lower in agent_id_map:
                    normalized.append(agent_id_map[spec_lower])
                elif spec in agent_id_map:
                    normalized.append(agent_id_map[spec])
                else:
                    # Try partial name match
                    matched = False
                    for name, aid in agent_id_map.items():
                        if spec_lower in name or name in spec_lower:
                            normalized.append(aid)
                            matched = True
                            break
                    # Fuzzy UUID match: LLM sometimes gets 1-2 chars wrong
                    if not matched and len(spec) >= 30:
                        best_match = None
                        best_distance = 3  # max 2 char differences allowed
                        for valid_id in valid_agent_ids:
                            if len(valid_id) == len(spec):
                                dist = sum(a != b for a, b in zip(spec.lower(), valid_id.lower()))
                                if dist < best_distance:
                                    best_distance = dist
                                    best_match = valid_id
                        if best_match:
                            logger.info(f"Fuzzy-matched specialist UUID '{spec}' -> '{best_match}' (distance={best_distance})")
                            normalized.append(best_match)
                        else:
                            logger.warning(f"Could not match specialist '{spec}' to any known agent")
            decision["specialists"] = normalized
            
            if not normalized and specialists:
                # Couldn't match any specialists - fall back to direct
                logger.warning(f"Could not match specialists {specialists}, falling back to direct")
                decision["action"] = "direct"
                decision["direct_response"] = full_response
        
        decision["tokens_input"] = token_accumulator["input"]
        decision["tokens_output"] = token_accumulator["output"]
        return decision
        
    except json_module.JSONDecodeError as e:
        logger.warning(f"Failed to parse orchestrator analysis JSON: {e}")
        # Fallback to direct answer
        return {
            "action": "direct",
            "reasoning": "Failed to parse decision",
            "direct_response": full_response,
            "tokens_input": token_accumulator["input"],
            "tokens_output": token_accumulator["output"],
        }


async def run_orchestrator_for_evaluation(
    orchestrator_config: dict,
    results_so_far: list[dict],
    original_question: str,
    specialist_configs: list[dict],
    create_chat_client_fn,
) -> dict:
    """
    Magentic evaluation phase: Decide if more investigation rounds are needed.
    
    Returns:
        dict with keys:
            - continue: bool - whether to do another round
            - follow_up_query: str - what to ask in the next round
            - target_agents: list[str] - which agents to query
            - reasoning: str - explanation
    """
    # Format gathered information
    gathered_parts = []
    for result in results_so_far:
        agent_name = result.get("agent_name", "Agent")
        response = result.get("response", "")
        if response:
            gathered_parts.append(f"[{agent_name}]: {response}")
    gathered_info = "\n\n".join(gathered_parts) if gathered_parts else "No information gathered yet."
    
    # Build agent list
    agent_list = []
    agent_id_map = {}
    for config in specialist_configs:
        name = config.get("name", "Agent")
        agent_id = config.get("id", "")
        description = config.get("description", "No description")
        agent_list.append(f"- {name} (id: {agent_id}): {description}")
        agent_id_map[name.lower()] = agent_id
        agent_id_map[agent_id] = agent_id
    
    # Build evaluation prompt
    eval_prompt = DEFAULT_EVALUATION_PROMPT
    eval_prompt = eval_prompt.replace("{user_question}", original_question)
    eval_prompt = eval_prompt.replace("{gathered_info}", gathered_info)
    eval_prompt = eval_prompt.replace("{agent_list}", "\n".join(agent_list) if agent_list else "No specialists")
    
    # Create chat client and agent
    chat_client = create_chat_client_fn(orchestrator_config)
    eval_agent = Agent(
        name="Evaluator",
        description="Evaluates if more investigation is needed",
        instructions=eval_prompt,
        client=chat_client
    )
    
    # Get evaluation
    eval_messages = [
        Message("system", [eval_prompt]),
        Message("user", ["Should we continue investigating or do we have enough information?"])
    ]
    
    response_parts = []
    token_accumulator = {"input": 0, "output": 0}
    async for update in eval_agent.run(eval_messages, stream=True):
        _accumulate_usage_from_update(update, token_accumulator)
        if update.text:
            response_parts.append(update.text)
    
    full_response = "".join(response_parts)
    
    if should_log_agent():
        logger.info(f"Magentic evaluation response:\n{full_response[:300]}...")
    
    # Parse JSON response
    try:
        json_match = re.search(r'```json\s*\n?(.*?)\n?```', full_response, re.DOTALL)
        if json_match:
            evaluation = json_module.loads(json_match.group(1))
        else:
            json_match = re.search(r'\{[^{}]*"continue"[^{}]*\}', full_response, re.DOTALL)
            if json_match:
                evaluation = json_module.loads(json_match.group())
            else:
                evaluation = {"continue": False, "reasoning": "Could not parse evaluation"}
        
        # Normalize agent IDs in target_agents
        if "target_agents" in evaluation:
            normalized = []
            for spec in evaluation["target_agents"]:
                spec_lower = spec.lower()
                if spec_lower in agent_id_map:
                    normalized.append(agent_id_map[spec_lower])
                elif spec in agent_id_map:
                    normalized.append(agent_id_map[spec])
            evaluation["target_agents"] = normalized
        
        evaluation["tokens_input"] = token_accumulator["input"]
        evaluation["tokens_output"] = token_accumulator["output"]
        return evaluation
        
    except json_module.JSONDecodeError as e:
        logger.warning(f"Failed to parse evaluation JSON: {e}")
        return {
            "continue": False,
            "reasoning": "Failed to parse evaluation",
            "tokens_input": token_accumulator["input"],
            "tokens_output": token_accumulator["output"],
        }


async def run_orchestrator_for_synthesis(
    orchestrator_config: dict,
    specialist_results: list[dict],
    user_message: str,
    create_chat_client_fn,
) -> dict:
    """
    Phase 3: Run orchestrator to synthesize specialist results.
    
    Returns:
        dict with content, tokens_input, and tokens_output
    """
    # Format specialist responses
    responses_text = []
    for result in specialist_results:
        agent_name = result.get("agent_name", "Agent")
        response = result.get("response", "")
        error = result.get("error")
        
        if error:
            responses_text.append(f"=== {agent_name} ===\n[ERROR: {error}]")
        else:
            responses_text.append(f"=== {agent_name} ===\n{response}")
    
    specialist_responses = "\n\n".join(responses_text)
    
    # Debug: Log what's being sent to synthesis
    if should_log_agent():
        logger.info(f"SYNTHESIS INPUT (specialist_responses):\n{specialist_responses[:1000]}{'...' if len(specialist_responses) > 1000 else ''}")
    
    # Use admin-configured synthesis prompt, or default if not set
    synthesis_prompt = orchestrator_config.get("synthesis_prompt") or DEFAULT_SYNTHESIS_PROMPT
    
    synthesis_prompt = synthesis_prompt.replace("{specialist_responses}", specialist_responses)
    
    # Create chat client
    chat_client = create_chat_client_fn(orchestrator_config)
    
    # Create synthesis agent — instructions contain the synthesis prompt
    # with specialist responses already embedded.  No providers or session
    # needed; the synthesizer only needs the user question + specialist output.
    synthesis_agent = Agent(
        name="Synthesizer",
        description="Synthesizes results",
        instructions=synthesis_prompt,
        client=chat_client,
    )
    
    # Pass only the user's original question; the specialist responses are
    # embedded in the instructions (system prompt) already.
    response_parts = []
    token_accumulator = {"input": 0, "output": 0}
    async for update in synthesis_agent.run(user_message, stream=True):
        _accumulate_usage_from_update(update, token_accumulator)
        if update.text:
            response_parts.append(update.text)
    
    return {
        "content": "".join(response_parts),
        "tokens_input": token_accumulator["input"],
        "tokens_output": token_accumulator["output"],
    }
