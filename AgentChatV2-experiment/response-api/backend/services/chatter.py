"""
Chatter Events
Data types and helpers for real-time agent activity streaming to the UI.
Extracted from agent_manager.py for maintainability.
"""
from typing import Optional, Any
from dataclasses import dataclass, field
from enum import Enum
import logging
import re
import time

logger = logging.getLogger(__name__)


class ChatterEventType(str, Enum):
    """Types of agent chatter events streamed to the UI."""
    THINKING = "thinking"           # Agent is processing
    TOOL_CALL = "tool_call"         # Agent is calling a tool/function
    TOOL_RESULT = "tool_result"     # Tool returned a result
    DELEGATION = "delegation"       # Orchestrator delegating to specialist
    CONTENT = "content"             # Actual content/text output
    REASONING = "reasoning"         # Model reasoning/chain-of-thought tokens (o-series, gpt-5.x)
    HTML_PREVIEW = "html_preview"   # Agent wants to show an HTML preview panel


_PROGRESS_BLOCK_RE = re.compile(r"```progress(?:_update)?\s*\n(.*?)```", re.DOTALL | re.IGNORECASE)
_PROGRESS_START_MARKERS = ("```progress_update", "```progress")


def extract_progress_updates(text: str) -> tuple[str, list[str]]:
    """Strip progress directive blocks from text and return their messages."""
    updates: list[str] = []

    def _replace(match: re.Match) -> str:
        message = match.group(1).strip()
        if message:
            updates.append(message)
        return ""

    cleaned = _PROGRESS_BLOCK_RE.sub(_replace, text)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return cleaned, updates


class ProgressDirectiveBuffer:
    """Incrementally extracts agent-authored progress directives from streamed text."""

    def __init__(self) -> None:
        self._buffer = ""

    def push(self, chunk: str) -> tuple[str, list[str]]:
        if not chunk:
            return "", []

        self._buffer += chunk
        safe_text, updates, remainder = self._consume(self._buffer)
        self._buffer = remainder
        return safe_text, updates

    def finalize(self) -> str:
        safe_text, _updates, _remainder = self._consume(self._buffer, final=True)
        self._buffer = ""
        return safe_text

    def _consume(self, text: str, final: bool = False) -> tuple[str, list[str], str]:
        output_parts: list[str] = []
        updates: list[str] = []
        cursor = 0

        for match in _PROGRESS_BLOCK_RE.finditer(text):
            output_parts.append(text[cursor:match.start()])
            message = match.group(1).strip()
            if message:
                updates.append(message)
            cursor = match.end()

        remainder = text[cursor:]

        if final:
            cleaned_remainder, trailing_updates = extract_progress_updates(remainder)
            updates.extend(trailing_updates)
            output_parts.append(cleaned_remainder)
            return "".join(output_parts), updates, ""

        partial_start = self._find_partial_progress_start(remainder)
        if partial_start != -1:
            output_parts.append(remainder[:partial_start])
            return "".join(output_parts), updates, remainder[partial_start:]

        output_parts.append(remainder)
        return "".join(output_parts), updates, ""

    def _find_partial_progress_start(self, text: str) -> int:
        candidates = [text.rfind(marker) for marker in _PROGRESS_START_MARKERS]
        return max(candidates)


def _get_friendly_tool_description(tool_name: str, tool_args: Optional[dict] = None) -> str:
    """
    Generate a user-friendly description of what a tool is doing.
    Converts technical tool names into human-readable activity descriptions.
    """
    # Common tool name patterns -> friendly descriptions
    tool_patterns = {
        # Database/Query operations
        'query': 'Querying data',
        'search': 'Searching for information',
        'lookup': 'Looking up information',
        'get': 'Retrieving data',
        'fetch': 'Fetching information',
        'list': 'Listing available items',
        'read': 'Reading data',
        
        # Write operations
        'create': 'Creating a new record',
        'insert': 'Adding new data',
        'update': 'Updating information',
        'delete': 'Removing data',
        'write': 'Writing data',
        
        # Analysis operations
        'analyze': 'Analyzing data',
        'calculate': 'Running calculations',
        'aggregate': 'Aggregating results',
        'summarize': 'Summarizing information',
        'compare': 'Comparing data',
        
        # Data retrieval
        'database': 'Querying the database',
        'table': 'Accessing table data',
        'execute': 'Executing operation',
        'run': 'Running operation',
        
        # API operations
        'api': 'Calling external service',
        'request': 'Making a request',
        'call': 'Making a call',
        
        # Document operations
        'document': 'Processing documents',
        'file': 'Accessing files',
        'content': 'Retrieving content',
    }
    
    tool_lower = tool_name.lower()
    
    # Try to match patterns
    for pattern, description in tool_patterns.items():
        if pattern in tool_lower:
            # Add context from args if available
            if tool_args:
                if 'query' in tool_args:
                    query_preview = str(tool_args['query'])[:50]
                    if len(str(tool_args['query'])) > 50:
                        query_preview += '...'
                    return f"{description}: \"{query_preview}\""
                elif 'table' in tool_args or 'table_name' in tool_args:
                    table = tool_args.get('table') or tool_args.get('table_name')
                    return f"{description} from {table}"
                elif 'database' in tool_args or 'db' in tool_args:
                    db = tool_args.get('database') or tool_args.get('db')
                    return f"{description} in {db}"
            return description
    
    # Fallback: humanize the tool name
    # Convert snake_case or camelCase to readable text
    import re
    readable_name = tool_name.replace('_', ' ').replace('-', ' ')
    # Add spaces before capitals in camelCase
    readable_name = re.sub(r'([a-z])([A-Z])', r'\1 \2', readable_name)
    return f"Running {readable_name.lower()}"


def _get_friendly_result_summary(tool_name: str, result_text: str, original_length: int | None = None) -> str:
    """
    Generate a user-friendly summary of a tool result.
    """
    # Count approximate items if result looks like a list or table
    if not result_text:
        return "Completed successfully"
    
    # Check if result has multiple lines (could be rows of data)
    lines = result_text.strip().split('\n')
    if len(lines) > 2:
        return f"Retrieved {len(lines)} results"
    
    # Check for JSON array-like patterns
    if result_text.count('[') > 0 and result_text.count(']') > 0:
        # Try to estimate count
        comma_count = result_text.count(',')
        if comma_count > 0:
            return f"Retrieved approximately {comma_count + 1} items"
    
    # Short result - just say completed
    char_count = original_length if original_length is not None else len(result_text)
    if char_count < 100:
        return "Completed"
    
    return f"Retrieved {char_count} characters of data"


@dataclass
class ChatterEvent:
    """Intermediate event during agent execution for streaming to UI."""
    type: ChatterEventType
    agent_name: str
    agent_id: Optional[str] = None
    content: str = ""
    tool_name: Optional[str] = None
    tool_args: Optional[dict] = None
    call_id: Optional[str] = None  # Underlying framework tool-call ID for correlation
    timestamp: float = field(default_factory=time.time)
    duration_ms: Optional[float] = None  # Duration of tool execution
    tokens_input: Optional[int] = None   # Input tokens used (for LLM calls)
    tokens_output: Optional[int] = None  # Output tokens used (for LLM calls)
    friendly_message: Optional[str] = None  # User-friendly description of the action
    render_hint: Optional[str] = None  # Hint for frontend rendering: 'json', 'table', 'text'
    
    @staticmethod
    def extract_result_text(result: Any) -> str:
        """
        Extract text from various result types.
        Handles Content objects with type='text', lists, dicts, and primitives.
        """
        if result is None:
            return ""
        
        # Handle Content objects with text attribute
        if hasattr(result, 'text'):
            return str(result.text)
        
        # Handle lists (of Content or other items)
        if isinstance(result, list):
            parts = []
            for item in result:
                if hasattr(item, 'text'):
                    parts.append(str(item.text))
                elif isinstance(item, str):
                    parts.append(item)
                else:
                    parts.append(str(item))
            return " ".join(parts)
        
        # Handle dicts
        if isinstance(result, dict):
            if 'text' in result:
                return str(result['text'])
            return str(result)
        
        # Default to string conversion
        return str(result)
    
    def to_dict(self) -> dict:
        """Convert to dict for JSON serialization."""
        result = {
            "type": self.type.value,
            "agent_name": self.agent_name,
            "content": self.content,
            "timestamp": self.timestamp
        }
        if self.agent_id:
            result["agent_id"] = self.agent_id
        if self.tool_name:
            result["tool_name"] = self.tool_name
        if self.tool_args:
            result["tool_args"] = self.tool_args
        if self.call_id:
            result["call_id"] = self.call_id
        if self.duration_ms is not None:
            result["duration_ms"] = round(self.duration_ms, 1)
        if self.tokens_input is not None:
            result["tokens_input"] = self.tokens_input
        if self.tokens_output is not None:
            result["tokens_output"] = self.tokens_output
        if self.friendly_message:
            result["friendly_message"] = self.friendly_message
        if self.render_hint:
            result["render_hint"] = self.render_hint
        return result


def _detect_render_hint(text: str) -> Optional[str]:
    """
    Detect the best rendering format for a tool result.
    Returns 'json', 'table', or None (plain text, no special rendering).
    """
    stripped = text.strip()
    if not stripped:
        return None

    # JSON object or array
    if (stripped.startswith('{') and stripped.endswith('}')) or \
       (stripped.startswith('[') and stripped.endswith(']')):
        try:
            import json as _json
            _json.loads(stripped)
            return "json"
        except (ValueError, TypeError):
            pass

    # Markdown / ASCII table heuristics:
    # lines with pipes (| col | col |) or tab-separated rows
    lines = stripped.split('\n')
    if len(lines) >= 2:
        pipe_lines = sum(1 for ln in lines if ln.count('|') >= 2)
        if pipe_lines >= 2:
            return "table"
        tab_lines = sum(1 for ln in lines if ln.count('\t') >= 1)
        if tab_lines >= 2:
            return "table"

    return None


def extract_chatter_from_update(
    update,
    agent_name: str,
    seen_tool_calls: set[str],
    seen_tool_results: set[str],
    pending_tool_calls: dict[str, tuple[float, str, Optional[dict]]],
    token_accumulator: dict[str, int],
) -> list[ChatterEvent]:
    """
    Extract ChatterEvent objects from an AgentResponseUpdate's contents.

    Shared by execute_single, _call_specialist_local, and the workflow
    event processor so the logic is defined once.
    """
    events: list[ChatterEvent] = []
    if not hasattr(update, 'contents') or not update.contents:
        return events

    # Trace non-text content items so we can confirm whether reasoning
    # summaries (text_reasoning) are arriving from the model. Text deltas
    # are skipped to keep the log readable.
    if logger.isEnabledFor(logging.INFO):
        try:
            interesting = [getattr(c, "type", "?") for c in update.contents
                           if getattr(c, "type", "?") != "text"]
            if interesting:
                logger.info(f"[CHATTER] agent={agent_name} non_text_contents={interesting}")
        except Exception:
            pass

    for content_item in update.contents:
        if content_item.type == 'function_call':
            call_id = getattr(content_item, 'call_id', None)
            tool_name = getattr(content_item, 'name', None)
            tool_args = getattr(content_item, 'arguments', None)
            if call_id and tool_name and call_id not in seen_tool_calls:
                seen_tool_calls.add(call_id)
                args_dict = tool_args if isinstance(tool_args, dict) else None
                pending_tool_calls[call_id] = (time.time(), tool_name, args_dict)
                friendly_msg = _get_friendly_tool_description(tool_name, args_dict)
                events.append(ChatterEvent(
                    type=ChatterEventType.TOOL_CALL,
                    agent_name=agent_name,
                    content=f"Calling {tool_name}",
                    tool_name=tool_name,
                    tool_args=args_dict,
                    call_id=call_id,
                    friendly_message=friendly_msg,
                ))

        elif content_item.type == 'function_result':
            call_id = getattr(content_item, 'call_id', None)
            result = getattr(content_item, 'result', None)
            if call_id and call_id not in seen_tool_results:
                seen_tool_results.add(call_id)
                duration_ms = None
                tool_name_result = None
                if call_id in pending_tool_calls:
                    st, tool_name_result, _ = pending_tool_calls[call_id]
                    duration_ms = (time.time() - st) * 1000
                result_display = ChatterEvent.extract_result_text(result)
                original_length = len(result_display)
                render_hint = _detect_render_hint(result_display)
                if len(result_display) > 300:
                    result_display = result_display[:300] + "..."
                friendly_msg = _get_friendly_result_summary(tool_name_result or "", result_display, original_length)
                events.append(ChatterEvent(
                    type=ChatterEventType.TOOL_RESULT,
                    agent_name=agent_name,
                    content=result_display or "Result received",
                    tool_name=tool_name_result,
                    call_id=call_id,
                    duration_ms=duration_ms,
                    friendly_message=friendly_msg,
                    render_hint=render_hint,
                ))

        elif content_item.type == 'text_reasoning':
            reasoning_text = getattr(content_item, 'text', None)
            protected_data = getattr(content_item, 'protected_data', None)
            summary_text = None

            if isinstance(reasoning_text, str) and reasoning_text.strip():
                summary_text = reasoning_text.strip()
            elif isinstance(protected_data, str) and protected_data.strip():
                summary_text = "Working through the next step..."

            if summary_text:
                logger.info(
                    f"[REASONING] agent={agent_name} delta_len={len(summary_text)} "
                    f"preview={summary_text[:120]!r}"
                )
                events.append(ChatterEvent(
                    type=ChatterEventType.REASONING,
                    agent_name=agent_name,
                    content=summary_text,
                    friendly_message="Reasoning...",
                ))

        elif content_item.type == 'usage':
            details = getattr(content_item, 'usage_details', None)
            if details:
                uc_in = details.get('input_token_count') if isinstance(details, dict) else getattr(details, 'input_token_count', None)
                uc_out = details.get('output_token_count') if isinstance(details, dict) else getattr(details, 'output_token_count', None)
                if uc_in:
                    token_accumulator["input"] = token_accumulator.get("input", 0) + uc_in
                if uc_out:
                    token_accumulator["output"] = token_accumulator.get("output", 0) + uc_out
                if uc_in or uc_out:
                    # Build a context-aware thinking message based on
                    # what happened recently (tool results → analyzing,
                    # tool calls pending → planning, otherwise generic)
                    if seen_tool_results and not (pending_tool_calls.keys() - seen_tool_results):
                        # All pending tool calls have results — agent
                        # is analyzing the data it received
                        friendly = "Analyzing results and forming response..."
                    elif pending_tool_calls and (pending_tool_calls.keys() - seen_tool_results):
                        # Still have tool calls without results
                        friendly = "Processing information..."
                    elif seen_tool_calls:
                        friendly = "Planning next steps..."
                    else:
                        friendly = "Thinking..."
                    events.append(ChatterEvent(
                        type=ChatterEventType.THINKING,
                        agent_name=agent_name,
                        content=f"LLM call: {uc_in or 0} input, {uc_out or 0} output tokens",
                        tokens_input=uc_in,
                        tokens_output=uc_out,
                        friendly_message=friendly,
                    ))
    return events
