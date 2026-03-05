"""
Workflow Runner
WorkflowBuilder-based specialist execution for different orchestration patterns.
Extracted from agent_manager.py for maintainability.
"""
from typing import Optional, Any
import asyncio
import time

from agent_framework import (
    Agent, AgentResponseUpdate, WorkflowBuilder, Workflow, WorkflowEvent,
    Executor, handler, WorkflowContext,
)

from observability import get_logger, should_log_agent
from services.chatter import ChatterEvent, ChatterEventType, extract_chatter_from_update

logger = get_logger(__name__)


# =========================================================================
# Orchestration patterns
# =========================================================================

class OrchestrationPattern:
    """Constants matching the Enum in agent_manager.  Imported here to avoid
    circular imports; the canonical Enum lives in agent_manager."""
    SINGLE = "single"
    SEQUENTIAL = "sequential"
    CONCURRENT = "concurrent"
    MAGENTIC = "magentic"
    GROUP_CHAT = "group_chat"


class _PassthroughExecutor(Executor):
    """
    A no-op executor that simply forwards its input unchanged.

    Used as the ``start_executor`` in concurrent fan-out workflows so that
    all real specialist agents begin execution at the same time rather than
    waiting for the first agent to finish.
    """

    def __init__(self) -> None:
        super().__init__("_passthrough_dispatcher")

    @handler
    async def handle(self, message: str, ctx: WorkflowContext[str, None]) -> None:
        await ctx.send_message(message)


# =========================================================================
# Workflow building and running
# =========================================================================

async def build_specialist_agents(
    specialist_ids: list[str],
    configs_cache: dict[str, dict],
    create_specialist_agent_fn,
    user_token: Optional[str] = None,
    session_id: Optional[str] = None,
    user_id: Optional[str] = None,
    cosmos_service=None,
    embedding_service=None,
    search_service=None,
) -> list[tuple[str, str, Agent]]:
    """
    Create Agent instances for a list of specialist IDs.

    Returns:
        list of (agent_id, agent_name, Agent) tuples.
    """
    from services.context_providers import CosmosHistoryProvider, DocumentRAGProvider

    agents: list[tuple[str, str, Agent]] = []
    has_session = bool(session_id and user_id)

    for agent_id in specialist_ids:
        config = configs_cache.get(agent_id)
        if not config:
            if cosmos_service:
                config = await cosmos_service.get_agent(agent_id)
                if config:
                    configs_cache[agent_id] = config
        if not config:
            logger.warning(f"Specialist config not found for {agent_id}, skipping")
            continue

        agent_name = config.get("name", "Agent")
        agent_type = config.get("agent_type", "local")

        # External A2A agents are handled outside the workflow (remote HTTP)
        if agent_type == "a2a":
            continue

        providers = None
        if has_session:
            providers = [
                CosmosHistoryProvider(cosmos_service),
                DocumentRAGProvider(embedding_service, search_service),
            ]

        agent = await create_specialist_agent_fn(
            config, user_token, context_providers=providers
        )
        agents.append((agent_id, agent_name, agent))
    return agents


async def run_workflow_and_collect(
    workflow: Workflow,
    user_message: str,
    agent_id_map: dict[str, tuple[str, str]],
    chatter_queue: Optional[asyncio.Queue] = None,
    session_id: Optional[str] = None,
    user_id: Optional[str] = None,
) -> list[dict]:
    """
    Run a WorkflowBuilder-produced Workflow with streaming, emitting chatter
    events and collecting specialist results.

    Args:
        workflow: The built Workflow object.
        user_message: The user's message to send to the workflow.
        agent_id_map: Mapping of executor_id -> (agent_id, agent_name).
        chatter_queue: Queue for real-time chatter events.
        session_id / user_id: For context-provider state.

    Returns:
        list of dicts with agent_id, agent_name, response.
    """
    results_by_executor: dict[str, dict] = {}

    # Per-executor tracking for chatter extraction
    seen_tool_calls: dict[str, set[str]] = {}
    seen_tool_results: dict[str, set[str]] = {}
    pending_tool_calls: dict[str, dict[str, tuple[float, str, Optional[dict]]]] = {}
    token_accumulators: dict[str, dict[str, int]] = {}
    executor_start_times: dict[str, float] = {}

    stream = workflow.run(user_message, stream=True)
    async for event in stream:
        etype = event.type

        if etype == "executor_invoked":
            executor_id = event.executor_id
            executor_start_times[executor_id] = time.time()
            seen_tool_calls.setdefault(executor_id, set())
            seen_tool_results.setdefault(executor_id, set())
            pending_tool_calls.setdefault(executor_id, {})
            token_accumulators.setdefault(executor_id, {"input": 0, "output": 0})

            agent_id, agent_name = agent_id_map.get(executor_id, (executor_id, executor_id))
            if chatter_queue:
                await chatter_queue.put(ChatterEvent(
                    type=ChatterEventType.DELEGATION,
                    agent_name=agent_name,
                    content=f"Running {agent_name}",
                    friendly_message=f"Asking {agent_name}",
                ))
            if should_log_agent():
                logger.info(f"Workflow: executor_invoked -> {executor_id} ({agent_name})")

        elif etype == "output":
            executor_id = event.executor_id or ""
            data = event.data
            agent_id, agent_name = agent_id_map.get(executor_id, (executor_id, executor_id))

            # AgentResponseUpdate — extract chatter (tool calls, tokens, etc.)
            if isinstance(data, AgentResponseUpdate):
                chatter_events = extract_chatter_from_update(
                    data, agent_name,
                    seen_tool_calls.get(executor_id, set()),
                    seen_tool_results.get(executor_id, set()),
                    pending_tool_calls.get(executor_id, {}),
                    token_accumulators.get(executor_id, {"input": 0, "output": 0}),
                )
                if chatter_queue:
                    for ce in chatter_events:
                        await chatter_queue.put(ce)

                # Accumulate text for final result
                if data.text:
                    results_by_executor.setdefault(executor_id, {
                        "agent_id": agent_id,
                        "agent_name": agent_name,
                        "parts": [],
                    })
                    results_by_executor[executor_id]["parts"].append(data.text)

        elif etype == "executor_completed":
            executor_id = event.executor_id or ""
            agent_id, agent_name = agent_id_map.get(executor_id, (executor_id, executor_id))
            duration_ms = None
            if executor_id in executor_start_times:
                duration_ms = (time.time() - executor_start_times[executor_id]) * 1000

            if chatter_queue:
                await chatter_queue.put(ChatterEvent(
                    type=ChatterEventType.CONTENT,
                    agent_name=agent_name,
                    content=f"Completed",
                    duration_ms=duration_ms,
                    friendly_message=f"{agent_name} finished" + (f" in {duration_ms/1000:.1f}s" if duration_ms else ""),
                ))
            if should_log_agent():
                logger.info(f"Workflow: executor_completed -> {executor_id} ({agent_name})")

        elif etype == "executor_failed":
            executor_id = event.executor_id or ""
            agent_id, agent_name = agent_id_map.get(executor_id, (executor_id, executor_id))
            error_detail = str(event.details) if event.details else "Unknown error"
            results_by_executor.setdefault(executor_id, {
                "agent_id": agent_id,
                "agent_name": agent_name,
                "parts": [],
                "error": error_detail,
            })
            if chatter_queue:
                await chatter_queue.put(ChatterEvent(
                    type=ChatterEventType.CONTENT,
                    agent_name=agent_name,
                    content=f"Error: {error_detail[:200]}",
                    friendly_message=f"{agent_name} encountered an error",
                ))

    # Build final results list
    results: list[dict] = []
    for executor_id, data in results_by_executor.items():
        response_text = "".join(data.get("parts", []))
        entry: dict[str, Any] = {
            "agent_id": data["agent_id"],
            "agent_name": data["agent_name"],
            "response": response_text,
        }
        if data.get("error"):
            entry["error"] = data["error"]
        results.append(entry)
    return results


async def execute_specialists_with_pattern(
    pattern: str,
    specialist_ids: list[str],
    user_message: str,
    configs_cache: dict[str, dict],
    create_specialist_agent_fn,
    call_specialist_a2a_fn,
    user_token: Optional[str] = None,
    chatter_queue: Optional[asyncio.Queue] = None,
    max_rounds: int = 10,
    orchestrator_config: Optional[dict] = None,
    session_id: Optional[str] = None,
    user_id: Optional[str] = None,
    # Service references for agent building
    cosmos_service=None,
    embedding_service=None,
    search_service=None,
    # For evaluation (Magentic)
    run_evaluation_fn=None,
) -> list[dict]:
    """
    Phase 2: Execute specialists using Agent Framework WorkflowBuilder.

    Builds a proper Workflow graph for each orchestration pattern instead of
    manual loops.  The framework handles message passing, context
    synchronization, and parallel execution.

    Returns:
        list of dicts with agent_id, agent_name, response
    """
    if not specialist_ids:
        return []

    # Separate local agents (workflow-capable) from external A2A agents
    local_ids = []
    a2a_ids = []
    for sid in specialist_ids:
        config = configs_cache.get(sid, {})
        if config.get("agent_type") == "a2a":
            a2a_ids.append(sid)
        else:
            local_ids.append(sid)

    # Build Agent instances for local specialists
    agent_tuples = await build_specialist_agents(
        local_ids, configs_cache, create_specialist_agent_fn,
        user_token, session_id, user_id,
        cosmos_service, embedding_service, search_service,
    )
    # agent_tuples: list of (agent_id, agent_name, Agent)

    # Map executor_id (agent.name) -> (agent_id, agent_name) for event processing
    agent_id_map: dict[str, tuple[str, str]] = {}
    agents_for_workflow: list[Agent] = []
    for agent_id, agent_name, agent in agent_tuples:
        agent_id_map[agent.name] = (agent_id, agent_name)
        agents_for_workflow.append(agent)

    results: list[dict] = []

    # Handle external A2A agents with direct calls (not part of the workflow)
    a2a_results = []
    if a2a_ids:
        a2a_tasks = [
            call_specialist_a2a_fn(
                aid, user_message, user_token, chatter_queue,
                session_id=session_id, user_id=user_id,
            )
            for aid in a2a_ids
        ]
        a2a_results = list(await asyncio.gather(*a2a_tasks))

    if not agents_for_workflow:
        # Only A2A agents — return their results directly
        return a2a_results

    # -----------------------------------------------------------------
    # Build the workflow graph based on pattern
    # -----------------------------------------------------------------

    if pattern == OrchestrationPattern.SINGLE or len(agents_for_workflow) == 1:
        agent = agents_for_workflow[0]
        workflow = WorkflowBuilder(start_executor=agent).build()

    elif pattern == OrchestrationPattern.SEQUENTIAL:
        first = agents_for_workflow[0]
        workflow = (
            WorkflowBuilder(start_executor=first)
            .add_chain(agents_for_workflow)
            .build()
        )

    elif pattern == OrchestrationPattern.CONCURRENT:
        dispatcher = _PassthroughExecutor()
        agent_id_map[dispatcher.id] = ("_dispatcher", "Dispatcher")
        workflow = (
            WorkflowBuilder(start_executor=dispatcher)
            .add_fan_out_edges(dispatcher, agents_for_workflow)
            .build()
        )

    elif pattern == OrchestrationPattern.MAGENTIC:
        first = agents_for_workflow[0]
        workflow = (
            WorkflowBuilder(start_executor=first)
            .add_chain(agents_for_workflow)
            .build()
        )

    elif pattern == OrchestrationPattern.GROUP_CHAT:
        first = agents_for_workflow[0]
        workflow = (
            WorkflowBuilder(
                start_executor=first,
                max_iterations=max_rounds * len(agents_for_workflow),
            )
            .add_chain(agents_for_workflow)
            .build()
        )

    else:
        first = agents_for_workflow[0]
        workflow = (
            WorkflowBuilder(start_executor=first)
            .add_chain(agents_for_workflow)
            .build()
        )

    # -----------------------------------------------------------------
    # Run the workflow with streaming and collect results + chatter
    # -----------------------------------------------------------------

    workflow_results = await run_workflow_and_collect(
        workflow=workflow,
        user_message=user_message,
        agent_id_map=agent_id_map,
        chatter_queue=chatter_queue,
        session_id=session_id,
        user_id=user_id,
    )
    results.extend(workflow_results)

    # Magentic iterative evaluation loop (runs additional rounds if needed)
    if pattern == OrchestrationPattern.MAGENTIC and orchestrator_config and run_evaluation_fn:
        for round_num in range(1, max_rounds):
            evaluation = await run_evaluation_fn(
                orchestrator_config,
                results + a2a_results,
                user_message,
                [configs_cache.get(sid, {}) for sid in specialist_ids],
            )
            if should_log_agent():
                logger.info(
                    f"Magentic round {round_num} evaluation: "
                    f"continue={evaluation.get('continue')}, "
                    f"follow_up={(evaluation.get('follow_up_query') or '')[:100]}"
                )
            if not evaluation.get("continue", False):
                break

            follow_up = evaluation.get("follow_up_query") or ""
            if not follow_up:
                break

            if chatter_queue:
                await chatter_queue.put(ChatterEvent(
                    type=ChatterEventType.THINKING,
                    agent_name="Orchestrator",
                    content=f"Round {round_num + 1}: Following up on new information...",
                    friendly_message="Investigating further based on new findings",
                ))

            # Re-run the workflow with the follow-up query
            follow_up_results = await run_workflow_and_collect(
                workflow=workflow,
                user_message=follow_up,
                agent_id_map=agent_id_map,
                chatter_queue=chatter_queue,
                session_id=session_id,
                user_id=user_id,
            )
            results.extend(follow_up_results)

    # Append A2A results
    results.extend(a2a_results)
    return results
