import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import httpx
from semantic_kernel import Kernel
from semantic_kernel.agents import ChatCompletionAgent
from semantic_kernel.connectors.ai.function_choice_behavior import FunctionChoiceBehavior
from semantic_kernel.connectors.ai.open_ai import AzureChatCompletion, OpenAIChatPromptExecutionSettings
from semantic_kernel.functions import kernel_function
from semantic_kernel.contents import ChatHistory
from src.utils.sse_emitter import sse_emitter

logger = logging.getLogger(__name__)


@dataclass
class AgentCard:
    name: str
    description: str
    endpoint: str  # full URL for JSON-RPC
    raw: Dict[str, Any]


class A2ARemoteAgent:
    def __init__(self, base_url: str, card: AgentCard):
        self.base_url = base_url.rstrip("/")
        self.card = card

    async def send_message(
        self,
        task: str,
        thread_id: Optional[str] = None,
        timeout: int = 60,
        headers: Optional[Dict[str, str]] = None,
    ) -> str:
        payload = {
            "jsonrpc": "2.0",
            "id": "1",
            "method": "message/send",  # Use canonical A2A method name
            "params": {"task": task, "threadId": thread_id},
        }
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(self.card.endpoint, json=payload, headers=headers or {})
            resp.raise_for_status()
            data = resp.json()
            if "error" in data:
                raise RuntimeError(f"A2A error from {self.card.name}: {data['error']}")
            result = data.get("result") or {}
            return result.get("content") or ""


class RoutingHost:
    """
    A2A-compliant router:
      - Discovers remote agents via RFC 8615 well-known URIs (/.well-known/agent-card.json)
      - Uses SK ChatCompletionAgent with a single function: delegate_task(agent_name, task)
      - LLM decides when to delegate; execution happens over A2A with canonical method names
    """

    def __init__(self, azure_api_key: str, azure_endpoint: str, azure_deployment: str):
        self.azure_api_key = azure_api_key
        self.azure_endpoint = azure_endpoint
        self.azure_deployment = azure_deployment

        self.kernel = Kernel()
        self.kernel.add_service(
            AzureChatCompletion(
                service_id="router",
                api_key=self.azure_api_key,
                endpoint=self.azure_endpoint,
                deployment_name=self.azure_deployment,
            )
        )
        # Router internal state
        self.remote_agents: Dict[str, A2ARemoteAgent] = {}
        self.router: Optional[ChatCompletionAgent] = None
        self._context_headers: Dict[str, str] = {}
        self._session_id: Optional[str] = None
        
        # Research control state
        self._research_control: Dict[str, Dict[str, Any]] = {}  # session_id -> control state
        self._research_control_lock = asyncio.Lock()

    async def _delegate(self, agent_name: str, task: str) -> str:
        """Shared delegation path with SSE instrumentation."""
        agent = self.remote_agents.get(agent_name)
        if not agent:
            return f"Agent '{agent_name}' not found."
        try:
            session_id = self._session_id or self._context_headers.get("X-Session-ID")
            if session_id:
                sse_emitter.emit_agent_activity(
                    session_id=session_id,
                    agent_name="Multi-Agent System",
                    action=f"Delegating to {agent_name}",
                    status="in-progress",
                    details=(task[:200] + ("..." if len(task) > 200 else "")),
                )
                sse_emitter.emit_agent_activity(
                    session_id=session_id,
                    agent_name=agent_name,
                    action="Invoked by router",
                    status="starting",
                    details=(task[:200] + ("..." if len(task) > 200 else "")),
                )

            t0 = time.perf_counter()
            content = await agent.send_message(task, headers=self._context_headers)
            dt = time.perf_counter() - t0

            if session_id:
                sse_emitter.emit_agent_activity(
                    session_id=session_id,
                    agent_name=agent_name,
                    action="Response received",
                    status="completed",
                    details=(content[:400] + ("..." if len(content) > 400 else "")),
                    duration=dt,
                )
                sse_emitter.emit_agent_activity(
                    session_id=session_id,
                    agent_name="Multi-Agent System",
                    action=f"Delegation from {agent_name} complete",
                    status="completed",
                    details=None,
                    duration=dt,
                )
            return f"[{agent_name}] {content}"
        except Exception as e:
            session_id = self._session_id or self._context_headers.get("X-Session-ID")
            if session_id:
                sse_emitter.emit_agent_activity(
                    session_id=session_id,
                    agent_name=agent_name,
                    action="Error during delegation",
                    status="error",
                    details=str(e),
                )
                sse_emitter.emit_agent_activity(
                    session_id=session_id,
                    agent_name="Multi-Agent System",
                    action=f"Delegation to {agent_name} failed",
                    status="error",
                    details=str(e),
                )
            return f"Error delegating to {agent_name}: {str(e)}"

    async def _delegate_with_retry(
        self, 
        agent_name: str, 
        task: str,
        max_retries: int = 3,
        initial_backoff: float = 2.0
    ) -> str:
        """Delegate with exponential backoff retry for 429 errors."""
        
        for attempt in range(max_retries + 1):
            try:
                return await self._delegate(agent_name, task)
            except Exception as e:
                error_str = str(e).lower()
                
                # Check if it's a 429 rate limit error
                if "429" in error_str or "rate limit" in error_str or "too many requests" in error_str:
                    if attempt < max_retries:
                        backoff_time = initial_backoff * (2 ** attempt)  # Exponential backoff
                        
                        session_id = self._session_id or self._context_headers.get("X-Session-ID")
                        if session_id:
                            sse_emitter.emit_agent_activity(
                                session_id=session_id,
                                agent_name=agent_name,
                                action=f"Rate limited - retrying in {backoff_time:.1f}s",
                                status="warning",
                                details=f"Attempt {attempt + 1}/{max_retries + 1}",
                            )
                        
                        logger.warning(f"⏳ Rate limit hit for {agent_name}, waiting {backoff_time}s before retry {attempt + 1}")
                        await asyncio.sleep(backoff_time)
                        continue
                    else:
                        # Max retries exceeded
                        session_id = self._session_id or self._context_headers.get("X-Session-ID")
                        if session_id:
                            sse_emitter.emit_agent_activity(
                                session_id=session_id,
                                agent_name=agent_name,
                                action="Rate limit exceeded after retries",
                                status="error",
                                details=f"Failed after {max_retries} retry attempts",
                            )
                        return f"[{agent_name}] Rate limit exceeded after {max_retries} retries. Please try again in a few moments."
                else:
                    # Not a rate limit error, re-raise
                    raise
        
        return f"[{agent_name}] Failed after {max_retries} retries"

    async def pause_research(self, session_id: str) -> bool:
        """Signal research to pause gracefully."""
        async with self._research_control_lock:
            if session_id not in self._research_control:
                self._research_control[session_id] = {}
            self._research_control[session_id]['pause_requested'] = True
            logger.info(f"⏸️ Pause requested for research session: {session_id}")
            return True
    
    async def resume_research(self, session_id: str) -> bool:
        """Resume paused research."""
        async with self._research_control_lock:
            if session_id in self._research_control:
                self._research_control[session_id]['pause_requested'] = False
                logger.info(f"▶️ Resume requested for research session: {session_id}")
                return True
            return False
    
    async def request_summary(self, session_id: str) -> bool:
        """Request immediate summary of current research."""
        async with self._research_control_lock:
            if session_id not in self._research_control:
                self._research_control[session_id] = {}
            self._research_control[session_id]['summary_requested'] = True
            logger.info(f"📊 Summary requested for research session: {session_id}")
            return True
    
    async def _check_pause_requested(self, session_id: str) -> bool:
        """Check if pause has been requested."""
        async with self._research_control_lock:
            return self._research_control.get(session_id, {}).get('pause_requested', False)
    
    async def _check_summary_requested(self, session_id: str) -> bool:
        """Check if summary has been requested."""
        async with self._research_control_lock:
            requested = self._research_control.get(session_id, {}).get('summary_requested', False)
            if requested:
                # Clear the flag after checking
                self._research_control[session_id]['summary_requested'] = False
            return requested
    
    def _generate_progress_summary(self, research_history: ChatHistory) -> str:
        """Generate a summary of research progress so far."""
        
        logger.info(f"🔍 Generating progress summary from ChatHistory with {len(research_history.messages)} messages")
        
        agents_used = set()
        key_findings = []
        
        for idx, msg in enumerate(research_history.messages):
            content_str = str(msg.content) if msg.content else ""
            logger.debug(f"📝 Message {idx+1}/{len(research_history.messages)}: Role={msg.role.value}, Length={len(content_str)}, Preview={content_str[:100]}...")
            
            # Track which agents were called - look for [AgentName] pattern
            import re
            agent_pattern = r'\[([A-Za-z]+Agent)\]'
            matches = re.findall(agent_pattern, content_str)
            if matches:
                logger.info(f"✅ Found agent names in content: {matches}")
            for agent_name in matches:
                agents_used.add(agent_name)
            
            # Also check for function calls in message items
            if hasattr(msg, 'items') and msg.items:
                logger.debug(f"🔧 Message has {len(msg.items)} items")
                for item_idx, item in enumerate(msg.items):
                    logger.debug(f"  Item {item_idx+1}: {type(item).__name__}")
                    if hasattr(item, 'function_name'):
                        logger.info(f"  Function call: {item.function_name}")
                        if item.function_name == 'delegate_task':
                            # Extract agent name from function arguments
                            try:
                                if hasattr(item, 'arguments'):
                                    args = item.arguments
                                    if isinstance(args, dict) and 'agent_name' in args:
                                        agent_name = args['agent_name']
                                        logger.info(f"✅ Found agent from function arguments: {agent_name}")
                                        agents_used.add(agent_name)
                            except Exception as e:
                                logger.error(f"Error extracting agent name from function arguments: {e}")
            
            # Collect substantial responses (but skip [PAUSED] messages)
            if msg.role.value == "assistant" and len(content_str) > 100 and "[PAUSED]" not in content_str:
                # Take first 400 chars as preview
                preview = content_str[:400] + ("..." if len(content_str) > 400 else "")
                key_findings.append(preview)
                logger.debug(f"📊 Added finding preview: {preview[:100]}...")
        
        logger.info(f"🎯 Summary generation complete: {len(agents_used)} agents found, {len(key_findings)} findings")
        logger.info(f"   Agents: {sorted(agents_used)}")
        
        summary = f"**Agents Consulted:** {', '.join(sorted(agents_used)) if agents_used else 'None yet'}\n\n"
        
        if key_findings:
            summary += "**Key Findings So Far:**\n"
            for i, finding in enumerate(key_findings[-3:], 1):  # Last 3 findings
                summary += f"{i}. {finding}\n\n"
        else:
            summary += "**Status:** Research in progress, no substantial findings yet.\n"
        
        return summary

    async def _check_research_scope(self, research_objective: str, agent_list: List[str]) -> Optional[str]:
        """Check if research scope needs to be narrowed, especially for ADX-heavy queries."""
        
        # If ADXAgent is involved, check table count
        if "ADXAgent" in agent_list:
            try:
                # Quick check to see how many tables are available
                table_check = await self._delegate_with_retry("ADXAgent", "List all available tables (names only)")
                
                # Count tables (simple heuristic - count occurrences of common table indicators)
                import re
                table_patterns = re.findall(r'\btable\b|\bTable\b|\b\w+Table\b', table_check, re.IGNORECASE)
                table_count = len(set(table_patterns))  # Unique table references
                
                if table_count > 10:
                    session_id = self._session_id or self._context_headers.get("X-Session-ID")
                    if session_id:
                        sse_emitter.emit_agent_activity(
                            session_id=session_id,
                            agent_name="Research Orchestrator",
                            action="Large data environment detected",
                            status="info",
                            details=f"Found approximately {table_count} tables. Recommending scope narrowing.",
                        )
                    
                    return (
                        f"🔍 **Large Data Environment Detected**\n\n"
                        f"I found approximately {table_count} tables in the ADX environment. "
                        f"To provide faster and more focused results:\n\n"
                        f"**Available tables:**\n{table_check}\n\n"
                        f"**Please specify:**\n"
                        f"- Which specific tables should I focus on?\n"
                        f"- What time range are you interested in?\n"
                        f"- Are there specific identifiers (IPs, names, etc.) to search for?\n\n"
                        f"Or reply 'search all' to proceed with comprehensive research (may take 3+ minutes)."
                    )
            except Exception as e:
                logger.warning(f"Could not check ADX scope: {e}")
        
        return None

    def set_context(
        self,
        user_id: Optional[str] = None,
        session_id: Optional[str] = None,
        adx_token: Optional[str] = None,
        authorization: Optional[str] = None,
    ) -> None:
        headers: Dict[str, str] = {}
        if user_id:
            headers["X-User-ID"] = user_id
        if session_id:
            headers["X-Session-ID"] = session_id
            self._session_id = session_id
        if adx_token:
            headers["X-ADX-Token"] = adx_token
            # Provide standard bearer form only if Authorization not already provided
            headers.setdefault("Authorization", f"Bearer {adx_token}")
        if authorization:
            # Preserve upstream caller token; do not override it with ADX token
            headers["Authorization"] = authorization
        self._context_headers = headers

    async def discover_agents(self, addresses: List[str]) -> None:
        """Fetch agent cards using RFC 8615 well-known URI standard."""
        async with httpx.AsyncClient(timeout=15) as client:
            for addr in addresses:
                base = addr.rstrip("/")
                try:
                    r = await client.get(f"{base}/.well-known/agent-card.json")
                    r.raise_for_status()
                    card_raw = r.json()
                    
                    name = card_raw.get("name") or "UnnamedAgent"
                    # Find a JSON-RPC endpoint from card; default to /a2a/message
                    ep = (
                        card_raw.get("endpoints", {}).get("jsonrpc")
                        or f"{base}/a2a/message"
                    )
                    card = AgentCard(
                        name=name,
                        description=card_raw.get("description", ""),
                        endpoint=ep,
                        raw=card_raw,
                    )
                    self.remote_agents[name] = A2ARemoteAgent(base, card)
                    print(f"✅ Discovered agent via well-known URI: {base} -> {name}")
                except Exception as e:
                    print(f"Failed to read Agent Card at {addr}/.well-known/agent-card.json: {e}")

    async def initialize(self) -> None:
        """Create a single ChatCompletionAgent with delegation and collaboration functions."""

        @kernel_function(
            name="delegate_task",
            description="Delegate a task to a remote specialist via A2A with automatic retry on rate limits",
        )
        async def delegate_task(agent_name: str, task: str) -> str:
            # Check if pause is requested before delegating
            session_id = self._session_id or self._context_headers.get("X-Session-ID")
            if session_id and await self._check_pause_requested(session_id):
                logger.info(f"⏸️ Delegation to {agent_name} skipped due to pause request")
                return f"[PAUSED] Research paused by user before calling {agent_name}"
            
            return await self._delegate_with_retry(agent_name, task)

        @kernel_function(
            name="collaborate_agents",
            description="Coordinate multiple agents to work together on a complex task that requires information from different specialists",
        )
        async def collaborate_agents(task_description: str, agent_sequence: str) -> str:
            """
            Orchestrate multiple agents in sequence or parallel to solve complex problems.
            
            Args:
                task_description: The overall task to accomplish
                agent_sequence: Comma-separated list of agents to involve (e.g., "DocumentAgent,ADXAgent")
            """
            return await self._orchestrate_collaboration(task_description, agent_sequence)

        @kernel_function(
            name="research_task",
            description="Execute deep, multi-agent research with iterative collaboration. REQUIRED for company research - MUST include FictionalCompaniesAgent,ADXAgent,InvestigatorAgent for comprehensive results. Router orchestrates multiple rounds where findings from one agent guide the next query.",
        )
        async def research_task(research_objective: str, relevant_agents: str) -> str:
            """
            Magentic-style orchestration: Router maintains control and iteratively decides
            which agent to invoke next based on previous responses and emerging insights.
            
            Args:
                research_objective: The research goal or question to investigate
                relevant_agents: For COMPANY RESEARCH, use "FictionalCompaniesAgent,ADXAgent,InvestigatorAgent" (all three required for complete analysis: company data, IP/network scans, and leadership background)
            """
            return await self._iterative_research(research_objective, relevant_agents)

        self.kernel.add_function("A2ATools", delegate_task)
        self.kernel.add_function("A2ATools", collaborate_agents)
        self.kernel.add_function("A2ATools", research_task)

        self.router = ChatCompletionAgent(
            service=self.kernel.get_service(),
            kernel=self.kernel,
            name="RoutingAgent",
            instructions=self._router_instructions(),
            function_choice_behavior=FunctionChoiceBehavior.Auto(
                filters={"included_plugins": ["A2ATools"]}
            ),
        )

    async def process_user_message(
        self,
        message: str,
        session_id: Optional[str] = None,
        user_id: Optional[str] = None,
        adx_token: Optional[str] = None,
        authorization: Optional[str] = None,
        chat_history: Optional[ChatHistory] = None,
    ) -> str:
        """Let the router choose to answer directly or delegate via A2A."""
        if not self.router:
            raise RuntimeError("Router not initialized.")
        # Capture forwarding headers for this turn
        if any([session_id, user_id, adx_token, authorization]):
            self.set_context(user_id=user_id, session_id=session_id, adx_token=adx_token, authorization=authorization)
        
        # Emit SSE: routing start
        if self._session_id:
            sse_emitter.emit_agent_activity(
                session_id=self._session_id,
                agent_name="RoutingAgent",
                action="Analyzing message",
                status="in-progress",
                details=(message[:200] + ("..." if len(message) > 200 else "")),
            )
        # Present known specialists in context
        specialists = [
            {"name": n, "description": a.card.description}
            for n, a in self.remote_agents.items()
        ]
        # Get router instructions from the same source used during initialization
        router_instructions = self._router_instructions()
        system_preamble = f"{router_instructions}\n\nAvailable specialists:\n{json.dumps(specialists, indent=2)}"

        # Use provided chat history or create a new one
        if chat_history is None:
            chat_history = ChatHistory()
            chat_history.add_system_message(system_preamble)
        else:
            # Chat history exists from previous conversation
            # CRITICAL: Insert router instructions at the beginning so the router knows its capabilities
            # We need to preserve other system messages (like document upload notifications) while ensuring
            # the router sees its instructions
            logger.info(f"Using existing chat history with {len(chat_history.messages)} messages for routing decision")
            
            # DEBUG: Log the contents of chat history to see if document upload notification is present
            for i, msg in enumerate(chat_history.messages):
                logger.info(f"  Message {i}: Role={msg.role.value}, Content={msg.content[:100] if msg.content else 'None'}...")
            
            # Check if first message contains router instructions (has "delegate_task" function reference)
            has_router_instructions = (
                len(chat_history.messages) > 0 
                and chat_history.messages[0].role.value == "system"
                and "delegate_task" in (chat_history.messages[0].content or "")
            )
            
            if not has_router_instructions:
                # Insert router instructions at the beginning while preserving other messages
                logger.info("Inserting router instructions at the beginning of chat history")
                # ChatHistory doesn't support insert, so we need to rebuild it
                original_messages = list(chat_history.messages)
                chat_history.messages.clear()
                chat_history.add_system_message(system_preamble)
                # Re-add all original messages except any generic system message at position 0
                for i, msg in enumerate(original_messages):
                    if i == 0 and msg.role.value == "system":
                        # Skip the first generic system message, we replaced it with router instructions
                        continue
                    # Re-add all other messages (including other system messages like document notifications)
                    if msg.role.value == "system":
                        chat_history.add_system_message(msg.content)
                    elif msg.role.value == "user":
                        chat_history.add_user_message(msg.content)
                    elif msg.role.value == "assistant":
                        chat_history.add_assistant_message(msg.content)
        
        chat_history.add_user_message(message)

        settings = OpenAIChatPromptExecutionSettings(
            temperature=0.1,
            max_tokens=1200,
            function_choice_behavior=self.router.function_choice_behavior,
        )
        t0 = time.perf_counter()
        result = await self.kernel.get_service().get_chat_message_content(
            chat_history=chat_history,
            settings=settings,
            kernel=self.kernel,
        )
        final = (result.content or "").strip()
        # Emit SSE: routing complete
        if self._session_id:
            sse_emitter.emit_agent_activity(
                session_id=self._session_id,
                agent_name="RoutingAgent",
                action="Synthesis complete",
                status="completed",
                details=(final[:400] + ("..." if len(final) > 400 else "")),
                duration=(time.perf_counter() - t0),
            )
        return final

    async def _orchestrate_collaboration(self, task_description: str, agent_sequence: str) -> str:
        """
        Orchestrate multiple agents to work together on a complex task.
        Uses regular ChatCompletion to coordinate the workflow.
        """
        # Parse agent sequence - handle various formats
        import re
        
        # Clean up the sequence and extract agent names
        # Handle formats like: "DocumentAgent,ADXAgent", "DocumentAgent -> ADXAgent", "DocumentAgent then ADXAgent"
        agent_sequence_clean = re.sub(r'\s*->\s*|\s+then\s+|\s*,\s*', ',', agent_sequence)
        agent_names = [name.strip() for name in agent_sequence_clean.split(",") if name.strip()]
        
        # Validate all agents exist
        missing_agents = [name for name in agent_names if name not in self.remote_agents]
        if missing_agents:
            return f"Cannot collaborate: agents not found: {missing_agents}"

        session_id = self._session_id or self._context_headers.get("X-Session-ID")
        if session_id:
            sse_emitter.emit_agent_activity(
                session_id=session_id,
                agent_name="Multi-Agent System",
                action="Starting collaboration",
                status="starting", 
                details=f"Task: {task_description[:200]}... Agents: {agent_sequence}",
            )

        # Create an orchestration agent to manage the workflow
        orchestrator = ChatCompletionAgent(
            service=self.kernel.get_service(),
            kernel=self.kernel,
            name="OrchestrationAgent",
            instructions=self._orchestration_instructions(agent_names),
            function_choice_behavior=FunctionChoiceBehavior.Auto(
                filters={"included_plugins": ["A2ATools"]}
            ),
        )

        # Build context about available agents
        agent_info = []
        for name in agent_names:
            agent = self.remote_agents[name]
            agent_info.append({
                "name": name,
                "description": agent.card.description,
                "capabilities": agent.card.raw.get("capabilities", [])
            })

        # Create orchestration prompt
        orchestration_prompt = f"""
Task to accomplish: {task_description}

Available specialist agents for this task:
{json.dumps(agent_info, indent=2)}

Plan and execute a multi-step workflow using delegate_task() to coordinate these agents.
For questions that involve finding information from one source and then using it with another:
1. First, gather the necessary information from the appropriate agent
2. Then, use that information with the next agent
3. Synthesize the final results

Start by planning your approach, then execute the steps.
"""

        chat_history = ChatHistory()
        chat_history.add_user_message(orchestration_prompt)

        try:
            # Let the orchestrator plan and execute the workflow
            result = await orchestrator.get_response(messages=[orchestration_prompt], kernel=self.kernel)
            final_content = result.message.content or "No response from orchestration."
            
            if session_id:
                sse_emitter.emit_agent_activity(
                    session_id=session_id,
                    agent_name="Multi-Agent System",
                    action="Collaboration complete",
                    status="completed",
                    details=final_content[:400] + ("..." if len(final_content) > 400 else ""),
                )
            
            return final_content
            
        except Exception as e:
            error_msg = f"Error during multi-agent collaboration: {str(e)}"
            if session_id:
                sse_emitter.emit_agent_activity(
                    session_id=session_id,
                    agent_name="Multi-Agent System", 
                    action="Collaboration failed",
                    status="error",
                    details=error_msg,
                )
            return error_msg

    async def _iterative_research(self, research_objective: str, relevant_agents: str) -> str:
        """
        Magentic-style research orchestration where router acts as the manager,
        maintaining conversation state and iteratively deciding which agent to invoke
        next based on accumulated findings.
        
        This enables deep, multi-round research where:
        - Findings from one agent inform which agent to query next
        - The router dynamically adapts the research strategy
        - Multiple rounds of agent invocations build comprehensive answers
        """
        import re
        
        # Parse agent list
        agent_list = [name.strip() for name in relevant_agents.split(",") if name.strip()]
        
        # Filter out DocumentAgent if no documents are uploaded
        # DocumentAgent should only be used when user has uploaded files to analyze
        if "DocumentAgent" in agent_list:
            # Check if there are any uploaded documents (you can enhance this check)
            # For now, remove DocumentAgent from research unless explicitly needed
            session_id = self._session_id or self._context_headers.get("X-Session-ID")
            # Simple heuristic: If research objective doesn't mention documents/files, exclude DocumentAgent
            if not any(keyword in research_objective.lower() for keyword in ["document", "file", "upload", "pdf", "doc"]):
                agent_list.remove("DocumentAgent")
                if session_id:
                    logger.info(f"Filtered out DocumentAgent from research (no document-related keywords in objective)")
        else:
            session_id = self._session_id or self._context_headers.get("X-Session-ID")
        
        # Validate agents exist
        missing_agents = [name for name in agent_list if name not in self.remote_agents]
        if missing_agents:
            return f"Cannot start research: agents not found: {missing_agents}"
        
        # Check if research scope needs narrowing (for large ADX environments)
        scope_check = await self._check_research_scope(research_objective, agent_list)
        if scope_check:
            return scope_check
        
        if session_id:
            sse_emitter.emit_agent_activity(
                session_id=session_id,
                agent_name="Research Orchestrator",
                action="Starting iterative research",
                status="starting",
                details=f"Objective: {research_objective[:200]}... Agents: {relevant_agents}",
            )
        
        # Initialize control state for this session
        if session_id:
            async with self._research_control_lock:
                self._research_control[session_id] = {
                    'pause_requested': False,
                    'summary_requested': False
                }
        
        # Create research orchestrator agent with special instructions
        research_orchestrator = ChatCompletionAgent(
            service=self.kernel.get_service(),
            kernel=self.kernel,
            name="ResearchOrchestrator",
            instructions=self._research_orchestration_instructions(agent_list, research_objective),
            function_choice_behavior=FunctionChoiceBehavior.Auto(
                filters={"included_plugins": ["A2ATools"]}
            ),
        )
        
        # Initialize research conversation
        research_history = ChatHistory()
        research_history.add_user_message(f"""Begin research on this objective:

{research_objective}

You have access to these specialist agents: {', '.join(agent_list)}

Plan your approach and begin executing step-by-step. Use delegate_task() to gather information from agents as needed.
After each agent response, analyze what you learned and decide the next action.

When you have sufficient information, synthesize a comprehensive final answer.""")
        
        max_rounds = 12  # Allow more rounds for deep research
        round_num = 0
        # Track all messages across rounds for summary generation
        all_round_messages = []
        
        # Get the time limit from settings (default 4 minutes = 240 seconds)
        from src.config.settings import settings
        round_time_limit = settings.RESEARCH_ROUND_TIME_LIMIT_SECONDS
        round_start_time = time.time()
        
        logger.info(f"⏱️ Research round time limit: {round_time_limit} seconds ({round_time_limit/60:.1f} minutes)")
        
        try:
            while round_num < max_rounds:
                round_num += 1
                
                # Check if round time limit exceeded
                elapsed_time = time.time() - round_start_time
                if elapsed_time > round_time_limit:
                    logger.info(f"⏱️ Round time limit exceeded: {elapsed_time:.1f}s > {round_time_limit}s")
                    
                    # Create temp_history for summary
                    temp_history = ChatHistory()
                    for msg in research_history.messages:
                        temp_history.add_message(msg)
                    for msg in all_round_messages:
                        if msg not in temp_history.messages:
                            temp_history.add_message(msg)
                    
                    summary = self._generate_progress_summary(temp_history)
                    
                    if session_id:
                        sse_emitter.emit_agent_activity(
                            session_id=session_id,
                            agent_name="Research Orchestrator",
                            action="Round time limit reached",
                            status="paused",
                            details=f"Research round exceeded {round_time_limit/60:.1f} minute time limit",
                        )
                    
                    # Cleanup control state
                    if session_id:
                        async with self._research_control_lock:
                            self._research_control.pop(session_id, None)
                    
                    return (
                        f"⏱️ **Research Round Time Limit Reached**\n\n"
                        f"The current research round has been running for {elapsed_time/60:.1f} minutes, "
                        f"which exceeds the configured limit of {round_time_limit/60:.1f} minutes.\n\n"
                        f"**Progress Summary (Round {round_num}/{max_rounds}):**\n{summary}\n\n"
                        f"**Next Steps:**\n"
                        f"- Ask a follow-up question to continue researching specific aspects\n"
                        f"- Reply 'continue' to resume the research\n"
                        f"- Or consider this complete if you have the information you need\n\n"
                        f"💡 *Tip: You can adjust the time limit by setting RESEARCH_ROUND_TIME_LIMIT_SECONDS in your .env file*"
                    )
                
                # Check for pause request
                if session_id and await self._check_pause_requested(session_id):
                    # Combine research_history with all accumulated messages from previous rounds
                    logger.info(f"⏸️ Pause detected at round {round_num}/{max_rounds}")
                    logger.info(f"📊 Research history has {len(research_history.messages)} messages")
                    logger.info(f"📨 Accumulated messages from previous rounds: {len(all_round_messages)} messages")
                    
                    # Create temp_history combining both sources
                    # FIX: Use empty constructor and add messages properly
                    temp_history = ChatHistory()
                    
                    # Add all messages from research_history
                    for msg in research_history.messages:
                        temp_history.add_message(msg)
                    
                    # Add all accumulated messages from previous rounds
                    for msg in all_round_messages:
                        if msg not in temp_history.messages:
                            temp_history.add_message(msg)
                    
                    logger.info(f"📊 Temp history for summary has {len(temp_history.messages)} messages")
                    for i, msg in enumerate(temp_history.messages, 1):
                        logger.debug(f"  Message {i}: Role={msg.role}, Content preview: {str(msg.content)[:100] if hasattr(msg, 'content') else str(msg)[:100]}")
                    
                    summary = self._generate_progress_summary(temp_history)
                    
                    if session_id:
                        sse_emitter.emit_agent_activity(
                            session_id=session_id,
                            agent_name="Research Orchestrator",
                            action="Research paused by user",
                            status="paused",
                            details="Generating progress summary...",
                        )
                    
                    # Cleanup control state
                    if session_id:
                        async with self._research_control_lock:
                            self._research_control.pop(session_id, None)
                    
                    return (
                        f"⏸️ **Research Paused**\n\n"
                        f"**Progress Summary (Round {round_num}/{max_rounds}):**\n{summary}\n\n"
                        f"**Next Steps:**\n"
                        f"- Reply 'continue' to resume research\n"
                        f"- Ask a follow-up question to redirect the research\n"
                        f"- Or consider this complete if you have what you need"
                    )
                
                # Check for summary request
                if session_id and await self._check_summary_requested(session_id):
                    summary = self._generate_progress_summary(research_history)
                    
                    if session_id:
                        sse_emitter.emit_agent_activity(
                            session_id=session_id,
                            agent_name="Research Orchestrator",
                            action="Progress summary generated",
                            status="in-progress",
                            details=summary[:200] + "...",
                        )
                        
                        # Emit summary as a special event
                        sse_emitter.emit_research_summary(
                            session_id=session_id,
                            round_num=round_num,
                            max_rounds=max_rounds,
                            summary=summary
                        )
                    # Continue research after summary
                
                if session_id:
                    sse_emitter.emit_agent_activity(
                        session_id=session_id,
                        agent_name="Research Orchestrator",
                        action=f"Research round {round_num}/{max_rounds}",
                        status="in-progress",
                        details="Analyzing findings and planning next step...",
                    )
                
                # Get orchestrator's next decision
                # invoke() is an async generator that streams results and modifies chat_history in place
                messages = []
                async for msg in research_orchestrator.invoke(
                    kernel=self.kernel,
                    chat_history=research_history
                ):
                    messages.append(msg)
                
                # Validate that research_history has proper message structure
                # Semantic Kernel should have updated research_history in place
                logger.debug(f"🔍 After invoke: research_history has {len(research_history.messages)} messages")
                for idx, msg in enumerate(research_history.messages):
                    if not hasattr(msg, 'role') or not hasattr(msg, 'content'):
                        logger.error(f"❌ Invalid message at index {idx}: {type(msg)} - {msg}")
                        # Skip accumulating invalid messages
                        continue
                
                # Accumulate messages from this round for summary generation
                # Only add NEW messages that aren't already in all_round_messages
                for msg in messages:
                    if msg not in all_round_messages:
                        all_round_messages.append(msg)
                
                # Extract response content from the last message
                if len(messages) == 0:
                    # No response, prompt for next action
                    research_history.add_user_message(
                        "What's your next step? Gather more information from an agent, or synthesize your findings into a final answer?"
                    )
                    continue
                
                # Get the last message (assistant's response)
                last_message = messages[-1]
                # Ensure response_content is always a string
                if hasattr(last_message, 'content'):
                    response_content = str(last_message.content) if last_message.content is not None else ""
                else:
                    response_content = str(last_message)
                
                # Check if delegation was paused mid-research
                if "[PAUSED]" in response_content:
                    # Add debug logging to see what's in research_history vs messages
                    logger.info(f"📊 Research history has {len(research_history.messages)} messages before summary")
                    logger.debug(f"🔍 Research history message types: {[msg.role for msg in research_history.messages]}")
                    logger.info(f"📨 Messages list from invoke() has {len(messages)} messages")
                    logger.debug(f"🔍 Messages list message types: {[msg.role for msg in messages]}")
                    
                    # The invoke() call should have updated research_history,
                    # but if not, we can analyze the messages list directly
                    # Create a temporary ChatHistory combining research_history with all accumulated messages
                    temp_history = ChatHistory()
                    
                    # Add all messages from research_history
                    for msg in research_history.messages:
                        temp_history.add_message(msg)
                    
                    # Add all accumulated messages from previous rounds
                    for msg in all_round_messages:
                        # Check if this message is already in temp_history
                        # to avoid duplicates (since invoke() may update research_history in place)
                        if msg not in temp_history.messages:
                            temp_history.add_message(msg)
                    
                    logger.info(f"📊 Temp history for summary has {len(temp_history.messages)} messages")
                    summary = self._generate_progress_summary(temp_history)
                    
                    if session_id:
                        sse_emitter.emit_agent_activity(
                            session_id=session_id,
                            agent_name="Research Orchestrator",
                            action="Research paused by user",
                            status="paused",
                            details="Paused during agent delegation",
                        )
                    
                    # Cleanup control state
                    if session_id:
                        async with self._research_control_lock:
                            self._research_control.pop(session_id, None)
                    
                    # Emit SSE event for the pause summary
                    if session_id:
                        sse_emitter.emit_research_summary(
                            session_id=session_id,
                            round_num=round_num,
                            max_rounds=max_rounds,
                            summary=summary
                        )
                    
                    return (
                        f"⏸️ **Research Paused**\n\n"
                        f"**Progress Summary (Round {round_num}/{max_rounds}):**\n{summary}\n\n"
                        f"**Next Steps:**\n"
                        f"- Reply 'continue' to resume research\n"
                        f"- Ask a follow-up question to redirect the research\n"
                        f"- Or consider this complete if you have what you need"
                    )
                
                # Check if research is complete
                if self._is_research_complete(response_content):
                    if session_id:
                        sse_emitter.emit_agent_activity(
                            session_id=session_id,
                            agent_name="Research Orchestrator",
                            action="Research complete",
                            status="completed",
                            details=response_content[:400] + ("..." if len(response_content) > 400 else ""),
                        )
                    
                    # Cleanup control state
                    if session_id:
                        async with self._research_control_lock:
                            self._research_control.pop(session_id, None)
                    
                    return response_content
                
                # If orchestrator didn't call a function and hasn't concluded,
                # prompt it to either gather more info or conclude
                has_function_call = hasattr(last_message, 'items') and last_message.items and any(
                    hasattr(item, 'function_name') for item in last_message.items
                )
                
                if not has_function_call:
                    # Check if this looks like a synthesis/conclusion attempt
                    if len(response_content) > 200 and any(
                        indicator in response_content.lower() 
                        for indicator in ["based on", "in summary", "findings show", "analysis reveals"]
                    ):
                        # This appears to be a final synthesis
                        # Cleanup control state
                        if session_id:
                            async with self._research_control_lock:
                                self._research_control.pop(session_id, None)
                        return response_content
                    
                    # Otherwise prompt for next action
                    # Note: invoke() already added assistant message to history
                    research_history.add_user_message(
                        "What's your next step? Gather more information from an agent, or synthesize your findings into a final answer?"
                    )
                # If function was called, invoke() already added response to history
                # Loop will continue with next round
            
            # Max rounds reached - generate progress summary
            summary = self._generate_progress_summary(research_history)
            final_msg = f"⏱️ **Research Reached Maximum Iterations** ({max_rounds} rounds)\n\n{summary}"
            
            # Cleanup control state
            if session_id:
                async with self._research_control_lock:
                    self._research_control.pop(session_id, None)
            
            return final_msg
            
        except Exception as e:
            import traceback
            error_msg = f"Error during iterative research: {str(e)}"
            logger.error(f"❌ Research error: {error_msg}")
            logger.error(f"📍 Error traceback:\n{traceback.format_exc()}")
            logger.error(f"📊 Research state: round {round_num}/{max_rounds}, history size {len(research_history.messages)}")
            if session_id:
                sse_emitter.emit_agent_activity(
                    session_id=session_id,
                    agent_name="Research Orchestrator",
                    action="Research failed",
                    status="error",
                    details=error_msg,
                )
                # Cleanup control state
                async with self._research_control_lock:
                    self._research_control.pop(session_id, None)
            return error_msg
    
    def _is_research_complete(self, content: str) -> bool:
        """Check if research has reached a conclusion."""
        if not content or len(content) < 100:
            return False
        
        completion_indicators = [
            "research complete",
            "comprehensive answer",
            "final synthesis",
            "conclusion:",
            "final answer:",
            "in summary of all findings",
            "complete analysis",
            "research summary:",
            "final research findings",
            "summary of research findings",  # Added
            "final research summary",        # Added
            "### final",                     # Markdown heading
            "## final",                      # Markdown heading
            "**final",                       # Bold final
            "next steps:",                   # Added - indicates conclusion with recommendations
            "recommendation:",               # Added
            "### completion:",               # Added
            "**completion:**",               # Added
        ]
        
        content_lower = content.lower()
        has_indicator = any(indicator in content_lower for indicator in completion_indicators)
        
        # Additional check: if response is very long (> 1500 chars) and contains "final" or "complete"
        # it's likely a comprehensive conclusion
        if len(content) > 1500 and ("final" in content_lower or "complete" in content_lower):
            logger.info(f"🎯 Detected completion: Long response ({len(content)} chars) with 'final' or 'complete'")
            return True
        
        if has_indicator:
            logger.info(f"🎯 Detected completion indicator in response")
        
        return has_indicator
    
    def _research_orchestration_instructions(self, agent_names: List[str], objective: str) -> str:
        """Generate instructions for the research orchestrator."""
        agent_info = []
        for name in agent_names:
            if name in self.remote_agents:
                agent = self.remote_agents[name]
                agent_info.append({
                    "name": name,
                    "description": agent.card.description,
                    "capabilities": agent.card.raw.get("capabilities", [])
                })
        
        return f"""You are a Research Orchestrator managing an iterative, multi-agent research process using the Magentic-One pattern.

RESEARCH OBJECTIVE:
{objective}

AVAILABLE SPECIALIST AGENTS:
{json.dumps(agent_info, indent=2)}

🎯 YOUR ORCHESTRATION PRINCIPLES:

You maintain research state and decide which specialist to consult next based on:
- What you've learned so far
- What gaps remain in your understanding  
- What connections you're discovering between different information sources
- What new questions emerge from each agent's response

**Technical Requirement**: Use delegate_task(agent_name="AgentName", task="specific question") to interact with specialists.

🧭 DISCOVERY-DRIVEN RESEARCH APPROACH:

You are a creative investigator, not following a script. Let the research unfold naturally:

**Starting Point**: Begin with whatever agent can provide the initial context or anchor information.

**Iterative Discovery**: After each agent response, pause and reflect:
- What did I just learn that's significant?
- What new entities, identifiers, or connections were revealed? (IPs, names, locations, patterns)
- What would be valuable to investigate next?
- Which specialist agent could help explore that?

**Following Leads**: When you discover:
- **IP addresses** → ADXAgent can search for network/security intelligence on those IPs
- **Company names** → FictionalCompaniesAgent provides business/infrastructure details AND ADXAgent may have company data in database tables (scans, logs, people/employees, etc.)
- **People/executives** → InvestigatorAgent researches backgrounds/relationships AND ADXAgent may have employee/personnel data in database tables
- **Cross-references** → ADXAgent excels at finding connections across multiple database tables (people, companies, IPs, events, etc.)

🔍 **IMPORTANT - ADXAgent's Broader Capabilities:**
ADXAgent isn't just for IP addresses! It searches **database tables** that may contain:
- Company information (company names, relationships, organizational data)
- Employee/personnel data (people working at companies, contact info, roles)
- Security events (scans, alerts, threats linked to companies or people)
- Network logs (activity tied to companies, devices, or individuals)
- Cross-references between entities (which people work at which companies, which IPs belong to which orgs)

When researching a **company**, ask ADXAgent to search for:
- "Search all tables for data about [CompanyName]" 
- "Find any employees or people associated with [CompanyName]"
- "Look for company records, personnel data, or organizational information about [CompanyName]"

When researching **people**, ask ADXAgent to search for:
- "Search for any data about [PersonName] including employment, activity, or associations"
- "Find personnel or employee records for people at [CompanyName]"

**Adaptive Strategy**: 
- There's no required sequence - adapt based on what you're finding
- Some research paths dead-end - that's useful information too
- Some findings open multiple new avenues - explore the most promising
- Depth vs. breadth: Balance thorough investigation with comprehensive coverage

**Building Understanding**: As you gather information:
- Notice patterns and anomalies
- Connect dots between different specialists' findings
- Form hypotheses and test them with targeted queries
- Recognize when you have sufficient insight vs. when gaps remain

🎓 EXAMPLE DISCOVERY PATTERNS (not prescriptive - just possibilities):

*Scenario*: Researching a company
- Start → FictionalCompaniesAgent: "Tell me about [CompanyName]" → Discover they have devices at IPs x.x.x.x, y.y.y.y
- Follow-up #1 → ADXAgent: "Search all tables for any data about [CompanyName], including company records, employee/personnel data, and organizational information" → Find company appears in database with employee records
- Follow-up #2 → ADXAgent: "Search for any activity from IP x.x.x.x" → Find security scans showing vulnerabilities
- New angle → ADXAgent: "Find any employees or people associated with [CompanyName]" → Discover employee names, roles, contact info
- Integration → InvestigatorAgent: "Research backgrounds of [employees discovered]" → Get career histories and professional backgrounds
- Deep dive → ADXAgent: "Search for any security events, alerts, or network activity related to [CompanyName] or its employees" → Cross-reference findings
- Synthesis → Combine business profile + database records + employee data + network security posture + leadership context

*The key*: Each finding generates new questions. ADXAgent searches **databases** (not just IPs), so use it to find company data, people data, and cross-references. Follow what seems most valuable.

✅ COMPLETION RECOGNITION:

You'll know research is complete when:
- The core research objective is thoroughly addressed
- Major discoverable facts have been uncovered
- Available specialists have been consulted on their relevant areas
- Diminishing returns: New queries aren't adding significant value
- You can synthesize a coherent, comprehensive answer

📋 **CRITICAL: COMPREHENSIVE SYNTHESIS REQUIREMENTS**

When synthesizing your final response, you MUST include:

1. **All Database Discoveries:**
   - If ADXAgent found people/employees in database tables → **Include them in final response**
   - If ADXAgent found company records in database → **Include them in final response**
   - If ADXAgent found IPs, scans, logs, alerts → **Include them in final response**
   - Example: "Database records show employee John Smith (address: 123 Main St, City State)"

2. **All Research Attempts (Even Unsuccessful Ones):**
   - If you researched someone but InvestigatorAgent found no background info → **Still mention the person was found in database**
   - Example: "Database identified John Smith as a company employee, though no additional background information was available in public records"

3. **Cross-Reference Database + External Sources:**
   - Database findings (people, IPs, scans) are **primary intelligence**
   - InvestigatorAgent findings (executives, leadership) are **secondary intelligence**
   - **Mention both** in synthesis, clearly distinguishing sources

4. **Clear Attribution:**
   - "Database records show..." (from ADXAgent)
   - "Company profile indicates..." (from FictionalCompaniesAgent)
   - "Public research found..." (from InvestigatorAgent)

❌ **WRONG Synthesis:**
"Leadership team includes CEO Jane Doe, CTO John Smith..." [omits other employees found in database]

✅ **CORRECT Synthesis:**
"Database records identified several employees including John Smith (address: 123 Main St, City State). While public records contained limited information about John Smith, leadership team research found CEO Jane Doe, CTO John Smith..."

**KEY PRINCIPLE:** Database discoveries are often the MOST important findings because they show actual data in your systems. Never omit them from synthesis.

When complete:
- Signal with "FINAL RESEARCH FINDINGS:" or "RESEARCH COMPLETE:"
- Synthesize **ALL** discoveries into a coherent narrative (database + external sources)
- Highlight key facts, patterns, and connections
- Cite which specialists provided which insights
- Note any limitations or areas where information wasn't available

🌟 REMEMBER: 
- You're a creative investigator following leads, not executing a script
- Let curiosity and discovered information guide your path
- Each specialist brings different intelligence - use them strategically
- Deep research requires multiple rounds - keep going until you have the full picture
- There's no single "right" way to research - adapt to what you're finding
"""

    def _orchestration_instructions(self, agent_names: List[str]) -> str:
        """Generate instructions for the orchestration agent."""
        return f"""
You are an orchestration agent responsible for coordinating multiple specialist agents to solve complex tasks.

Your role:
- Plan multi-step workflows that leverage each agent's expertise
- Use delegate_task(agent_name, task) to interact with specialists: {', '.join(agent_names)}
- Gather information from one agent and use it as input for another when needed
- Synthesize final answers from multiple agent responses
- Ensure all parts of the user's question are addressed

Key patterns:
- Document + ADX queries: First get info from DocumentAgent, then search ADX with that info
- Research tasks: Gather data from multiple sources, then synthesize findings
- Multi-step analysis: Break complex questions into logical sequence of specialist tasks

Always provide a comprehensive final answer that addresses the original question completely.
"""

    def _router_instructions(self) -> str:
        # Load from environment variable with fallback to strong delegation rules
        env_instructions = os.getenv("ROUTER_AGENT_INSTRUCTIONS")
        if env_instructions:
            return env_instructions
        
        # Fallback with merged instructions (delegation rules + routing logic)
        return (
            "You are a routing/synthesis agent. Your ONLY job is to delegate tasks to specialist agents. You are NOT allowed to answer specialist questions yourself.\n\n"
            "If you get a follow up question after a specialist provided you an answer, you should send the followup question to that agent and let it answer, you should not try to do so.\n\n"
            
            "🚨🚨🚨 **ABSOLUTE PROHIBITION - READ CAREFULLY:** 🚨🚨🚨\n\n"
            "⛔ **YOU ARE FORBIDDEN FROM:**\n"
            "- Describing database table schemas\n"
            "- Listing table columns or fields\n"
            "- Explaining what data exists in any database\n"
            "- Providing information about database structure\n"
            "- Answering ANY question that requires specialized knowledge or tools\n"
            "- Fabricating, guessing, or inferring answers based on conversation history\n"
            "- Synthesizing answers from previous agent responses in the chat history\n\n"
            
            "✅ **HOW TO USE CONVERSATION HISTORY:**\n"
            "- DO use conversation history ONLY to understand CONTEXT (what topic/domain the user is asking about)\n"
            "- DO use context ONLY to decide WHICH specialist agent to delegate to\n"
            "- DO NOT use conversation history to ANSWER questions\n"
            "- DO NOT extract information from previous agent responses to synthesize an answer\n"
            "- DO NOT assume previous information is sufficient - ALWAYS delegate for new questions\n\n"
            
            "⚠️ **CRITICAL: CONVERSATION HISTORY ≠ YOUR KNOWLEDGE**\n"
            "- Previous agent responses in the chat history are NOT your knowledge\n"
            "- You cannot use those responses to answer new questions\n"
            "- EVERY new question requiring data/facts MUST be delegated\n"
            "- Example: If ADXAgent previously said 'Tables: People, Scans', you CANNOT use this to answer 'what's in the Scans table?'\n"
            "- You must delegate: delegate_task('ADXAgent', 'Describe the Scans table schema')\n\n"
            
            "⚠️ **RULE: ONE QUESTION = ONE DELEGATION**\n"
            "Even if a follow-up question seems related to previous responses, you must STILL DELEGATE it to get the current, accurate answer.\n\n"
            
            "🚨 **CRITICAL DELEGATION RULES - ZERO EXCEPTIONS:**\n\n"
            "**DATABASE/ADX QUESTIONS (tables, schemas, queries, data):**\n"
            "- ❌ NEVER describe table schemas yourself (even if you saw them in chat history)\n"
            "- ❌ NEVER list table columns or fields (even if previously mentioned)\n"
            "- ❌ NEVER explain database structure (even if discussed earlier)\n"
            "- ✅ ALWAYS use: delegate_task('ADXAgent', 'user question here')\n"
            "- Example: 'what fields are in the scans table?' → delegate_task('ADXAgent', 'Describe the complete schema for the Scans table')\n\n"
            
            "**DOCUMENT QUESTIONS:**\n"
            "- If user mentions 'that file', 'the document', uploaded content → delegate_task('DocumentAgent', task)\n\n"
            
            "**RESEARCH/RAG QUESTIONS:**\n"
            "- If question requires indexed document search → delegate_task('InvestigatorAgent', task)\n\n"
            
            "**COMPANY/DEVICE QUESTIONS:**\n"
            "- If question is about companies or devices → delegate_task('FictionalCompaniesAgent', task)\n\n"
            
            "AGENT CAPABILITIES:\n"
            "• FictionalCompaniesAgent: Company intelligence - profiles, business details, network infrastructure, device inventories with IP addresses, organizational structure\n"
            "• ADXAgent: Database intelligence - security scans, network logs, vulnerability reports, IP analysis, device activity, threat data\n"
            "• InvestigatorAgent: Background research - people, executives, leadership teams, career histories, professional backgrounds\n"
            "• DocumentAgent: Document analysis - only use if user uploaded files\n\n"
            
            "ROUTING DECISIONS:\n\n"
            "1. SIMPLE SINGLE-AGENT TASKS (use delegate_task):\n"
            "   - Document operations: 'summarize this document', 'what's in the file?', references to 'that file/document'\n"
            "   - Pure database queries: 'search ADX for IP 1.2.3.4', 'what tables are in ADX?', 'describe the scans table schema'\n"
            "   - Simple lookups: 'who owns this IP address?'\n"
            "   ⚠️ NEVER use delegate_task for company research - use research_task instead!\n\n"
            
            "2. COMPLEX MULTI-AGENT WORKFLOWS (use collaborate_agents):\n"
            "   - Cross-referencing data: 'find IP in document and search for it in ADX'\n"
            "   - Multi-step analysis: 'extract data from document then look up in database'\n"
            "   - Sequential workflows where you know the exact steps upfront\n\n"
            
            "3. DEEP RESEARCH & INVESTIGATION (use research_task):\n"
            "   - Company research (ALWAYS use research_task): 'research CompanyName', 'tell me about CompanyX'\n"
            "   - Open-ended investigation: 'investigate this entity', 'do a deep dive on X'\n"
            "   - Multi-round investigation where findings guide next steps\n"
            "   - Agent selection: relevant_agents='FictionalCompaniesAgent,ADXAgent,InvestigatorAgent'\n\n"
            
            "**EXAMPLES OF CORRECT BEHAVIOR:**\n"
            "❌ WRONG: 'The Scans table has fields: ScanId, PersonId, ScanDate...'\n"
            "✅ CORRECT: delegate_task('ADXAgent', 'describe the scans table schema')\n\n"
            
            "❌ WRONG: 'Based on typical database structures...'\n"
            "✅ CORRECT: delegate_task('ADXAgent', user's question)\n\n"
            
            "❌ WRONG: 'From our earlier conversation, the database contains...'\n"
            "✅ CORRECT: delegate_task('ADXAgent', user's question)\n\n"
            
            "**REMEMBER:**\n"
            "- You do NOT have knowledge about database schemas\n"
            "- You do NOT have access to database tools\n"
            "- You CANNOT answer database questions\n"
            "- Conversation history is for ROUTING, not for ANSWERING\n"
            "- Your ONLY job is to delegate\n"
            "- When in doubt, DELEGATE!"
        )
