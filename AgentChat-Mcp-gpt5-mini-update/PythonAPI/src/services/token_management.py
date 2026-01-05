"""Token management service to prevent exceeding GPT-4o's 128K token limit."""

from typing import List, Dict, Any, Optional, Tuple
from datetime import datetime, timezone
import re

try:
    from ..utils.logging import get_logger
except ImportError:
    from src.utils.logging import get_logger

logger = get_logger(__name__)


class TokenManager:
    """Manages token counting and optimization for GPT-4o (128K token limit)."""
    
    # GPT-4o token limits (conservative estimates)
    MAX_TOKENS = 128000
    SAFE_LIMIT = 120000  # Leave buffer for response
    CONTEXT_RESERVE = 8000  # Reserve for system prompts, tools, etc.
    AVAILABLE_FOR_HISTORY = SAFE_LIMIT - CONTEXT_RESERVE  # ~112K for conversation history
    
    def __init__(self):
        """Initialize token manager with pure Python token estimation."""
        logger.info("Using pure Python token estimation (production-safe)")
    
    def count_tokens(self, text: str) -> int:
        """Count tokens in a text string using character-based estimation.
        
        This uses a more accurate estimation than simple character division:
        - Average English: ~4 characters per token
        - Code/JSON: ~3.5 characters per token  
        - Numbers/symbols: ~2.5 characters per token
        
        Args:
            text: Text to count tokens for
            
        Returns:
            int: Number of tokens (estimated)
        """
        if not text:
            return 0
        
        # More sophisticated estimation based on content type
        text_length = len(text)
        
        # Count different character types for better estimation
        alpha_chars = sum(1 for c in text if c.isalpha())
        digit_chars = sum(1 for c in text if c.isdigit())
        space_chars = sum(1 for c in text if c.isspace())
        symbol_chars = text_length - alpha_chars - digit_chars - space_chars
        
        # Different ratios for different content types
        estimated_tokens = (
            alpha_chars / 4.0 +       # Regular text: ~4 chars per token
            digit_chars / 2.5 +       # Numbers: ~2.5 chars per token
            space_chars / 1.0 +       # Spaces usually create token boundaries
            symbol_chars / 3.0        # Symbols/punctuation: ~3 chars per token
        )
        
        # Add overhead for special tokens, formatting, etc.
        estimated_tokens *= 1.1
        
        return max(1, int(estimated_tokens))
    
    def count_message_tokens(self, message: Dict[str, Any]) -> int:
        """Count tokens in a chat message.
        
        Args:
            message: Chat message with role, content, etc.
            
        Returns:
            int: Number of tokens including formatting overhead
        """
        tokens = 0
        
        # Count role
        if 'role' in message:
            tokens += self.count_tokens(message['role'])
        
        # Count content
        if 'content' in message:
            content = str(message['content'])
            tokens += self.count_tokens(content)
        
        # Count name if present
        if 'name' in message:
            tokens += self.count_tokens(message['name'])
        
        # Add formatting overhead (role, name, content markers)
        tokens += 10
        
        return tokens
    
    def count_messages_tokens(self, messages: List[Dict[str, Any]]) -> int:
        """Count total tokens in a list of messages.
        
        Args:
            messages: List of chat messages
            
        Returns:
            int: Total token count
        """
        total = 0
        for message in messages:
            total += self.count_message_tokens(message)
        
        # Add conversation formatting overhead
        total += len(messages) * 3
        
        return total
    
    def optimize_messages_for_tokens(self, messages: List[Dict[str, Any]], 
                                   max_tokens: Optional[int] = None) -> List[Dict[str, Any]]:
        """Optimize message list to fit within token limits.
        
        Args:
            messages: List of chat messages
            max_tokens: Maximum tokens allowed (defaults to AVAILABLE_FOR_HISTORY)
            
        Returns:
            List[Dict[str, Any]]: Optimized message list
        """
        if max_tokens is None:
            max_tokens = self.AVAILABLE_FOR_HISTORY
        
        current_tokens = self.count_messages_tokens(messages)
        
        if current_tokens <= max_tokens:
            logger.debug(f"✅ Messages fit within limit: {current_tokens}/{max_tokens} tokens")
            return messages
        
        logger.info(f"⚠️ Messages exceed limit: {current_tokens}/{max_tokens} tokens - optimizing...")
        
        # Strategy 1: Remove oldest messages while preserving recent context
        optimized = self._truncate_oldest_messages(messages, max_tokens)
        
        # Strategy 2: Summarize long messages if still too long
        if self.count_messages_tokens(optimized) > max_tokens:
            optimized = self._summarize_long_messages(optimized, max_tokens)
        
        # Strategy 3: Final truncation if still too long
        if self.count_messages_tokens(optimized) > max_tokens:
            optimized = self._final_truncation(optimized, max_tokens)
        
        final_tokens = self.count_messages_tokens(optimized)
        logger.info(f"📉 Optimized from {current_tokens} to {final_tokens} tokens")
        
        return optimized
    
    def _truncate_oldest_messages(self, messages: List[Dict[str, Any]], 
                                max_tokens: int) -> List[Dict[str, Any]]:
        """Remove oldest messages while preserving system and recent messages."""
        if not messages:
            return messages
        
        # Always preserve system messages and the last few messages
        system_messages = [msg for msg in messages if msg.get('role') == 'system']
        recent_messages = messages[-5:]  # Keep last 5 messages
        
        # Calculate tokens for preserved messages
        preserved_tokens = (self.count_messages_tokens(system_messages) + 
                          self.count_messages_tokens(recent_messages))
        
        if preserved_tokens >= max_tokens:
            # If even preserved messages are too long, just keep system + last 2
            return system_messages + messages[-2:]
        
        # Add messages from newest to oldest until we hit the limit
        available_tokens = max_tokens - preserved_tokens
        result = system_messages[:]
        
        # Add messages from the middle, working backwards
        middle_messages = messages[len(system_messages):-5]
        for msg in reversed(middle_messages):
            msg_tokens = self.count_message_tokens(msg)
            if msg_tokens <= available_tokens:
                result.append(msg)
                available_tokens -= msg_tokens
            else:
                break
        
        # Sort middle messages back to chronological order
        middle_part = sorted([msg for msg in result if msg not in system_messages], 
                           key=lambda x: messages.index(x))
        
        # Add recent messages
        result = system_messages + middle_part + recent_messages
        
        return result
    
    def _summarize_long_messages(self, messages: List[Dict[str, Any]], 
                               max_tokens: int) -> List[Dict[str, Any]]:
        """Summarize individual messages that are too long."""
        result = []
        
        for message in messages:
            msg_tokens = self.count_message_tokens(message)
            
            # If message is longer than 2000 tokens, summarize it
            if msg_tokens > 2000:
                content = str(message.get('content', ''))
                summarized_content = self._summarize_content(content, max_length=1000)
                
                summarized_message = message.copy()
                summarized_message['content'] = f"[Summarized] {summarized_content}"
                result.append(summarized_message)
            else:
                result.append(message)
        
        return result
    
    def _summarize_content(self, content: str, max_length: int = 1000) -> str:
        """Summarize long content to fit within token limits."""
        if len(content) <= max_length:
            return content
        
        # Extract key information patterns
        sentences = re.split(r'[.!?]+', content)
        
        # Keep first and last sentences, plus any sentences with keywords
        keywords = ['result', 'error', 'success', 'found', 'data', 'analysis', 'summary']
        important_sentences = []
        
        # Always include first sentence
        if sentences:
            important_sentences.append(sentences[0])
        
        # Include sentences with keywords
        for sentence in sentences[1:-1]:
            if any(keyword in sentence.lower() for keyword in keywords):
                important_sentences.append(sentence.strip())
        
        # Always include last sentence
        if len(sentences) > 1:
            important_sentences.append(sentences[-1])
        
        summarized = '. '.join(important_sentences).strip()
        
        # If still too long, truncate
        if len(summarized) > max_length:
            summarized = summarized[:max_length-3] + "..."
        
        return summarized
    
    def _final_truncation(self, messages: List[Dict[str, Any]], 
                        max_tokens: int) -> List[Dict[str, Any]]:
        """Final aggressive truncation if other methods failed."""
        if not messages:
            return messages
        
        # Keep system messages and last user/assistant pair
        system_messages = [msg for msg in messages if msg.get('role') == 'system']
        last_messages = messages[-2:] if len(messages) >= 2 else messages[-1:]
        
        result = system_messages + last_messages
        
        # If still too long, truncate content of non-system messages
        current_tokens = self.count_messages_tokens(result)
        if current_tokens > max_tokens:
            for i, msg in enumerate(result):
                if msg.get('role') != 'system':
                    content = str(msg.get('content', ''))
                    if len(content) > 500:
                        result[i] = msg.copy()
                        result[i]['content'] = content[:500] + "...[truncated]"
        
        return result
    
    def optimize_rag_context(self, rag_results: List[Dict[str, Any]], 
                           max_tokens: int = 4000) -> str:
        """Optimize RAG context to fit within token limits.
        
        Args:
            rag_results: List of RAG search results
            max_tokens: Maximum tokens for RAG context
            
        Returns:
            str: Optimized RAG context
        """
        if not rag_results:
            return ""
        
        # Sort by relevance score if available
        sorted_results = sorted(rag_results, 
                              key=lambda x: x.get('score', 0), 
                              reverse=True)
        
        context_parts = []
        used_tokens = 0
        
        for result in sorted_results:
            document_id = result.get('documentId', 'Unknown')
            content = result.get('content', '')
            score = result.get('score', 0)
            
            # Create context entry
            entry = f"Document: {document_id} (Score: {score:.3f})\nContent: {content}\n"
            entry_tokens = self.count_tokens(entry)
            
            if used_tokens + entry_tokens <= max_tokens:
                context_parts.append(entry)
                used_tokens += entry_tokens
            else:
                # Try to fit a truncated version
                remaining_tokens = max_tokens - used_tokens - 50  # Buffer
                if remaining_tokens > 100:
                    max_content_chars = remaining_tokens * 3  # Rough estimate
                    truncated_content = content[:max_content_chars] + "...[truncated]"
                    truncated_entry = f"Document: {document_id} (Score: {score:.3f})\nContent: {truncated_content}\n"
                    context_parts.append(truncated_entry)
                break
        
        context = "\n".join(context_parts)
        actual_tokens = self.count_tokens(context)
        
        logger.info(f"📄 RAG context optimized: {actual_tokens}/{max_tokens} tokens from {len(rag_results)} results")
        
        return context
    
    def get_token_stats(self, messages: List[Dict[str, Any]], 
                       rag_context: str = "", 
                       system_prompt: str = "") -> Dict[str, int]:
        """Get detailed token usage statistics.
        
        Args:
            messages: Chat messages
            rag_context: RAG context content
            system_prompt: System prompt content
            
        Returns:
            Dict with token usage breakdown
        """
        stats = {
            'messages_tokens': self.count_messages_tokens(messages),
            'rag_tokens': self.count_tokens(rag_context),
            'system_tokens': self.count_tokens(system_prompt),
            'total_tokens': 0,
            'available_tokens': 0,
            'usage_percentage': 0
        }
        
        stats['total_tokens'] = (stats['messages_tokens'] + 
                               stats['rag_tokens'] + 
                               stats['system_tokens'])
        
        stats['available_tokens'] = self.SAFE_LIMIT - stats['total_tokens']
        stats['usage_percentage'] = int((stats['total_tokens'] / self.SAFE_LIMIT) * 100)
        
        return stats
    
    def truncate_large_adx_results(self, adx_results: str, max_tokens: int = 30000) -> str:
        """Truncate large ADX result sets to prevent token overflow.
        
        This method identifies large ADX query results and truncates them
        to prevent Azure OpenAI API failures from token limit exceeded errors.
        
        Args:
            adx_results: Raw ADX query results (could be large JSON/tabular data)
            max_tokens: Maximum tokens allowed for ADX results
            
        Returns:
            str: Truncated ADX results with warning if truncated
        """
        try:
            if not adx_results:
                return adx_results
                
            current_tokens = self.count_tokens(adx_results)
            
            if current_tokens <= max_tokens:
                return adx_results
            
            logger.warning(f"🚨 ADX results ({current_tokens:,} tokens) exceed limit ({max_tokens:,})")
            logger.info("✂️ Truncating ADX results to prevent token overflow")
            
            # Split into lines and truncate intelligently
            lines = adx_results.split('\n')
            truncated_lines = []
            used_tokens = 0
            header_preserved = False
            
            for i, line in enumerate(lines):
                line_tokens = self.count_tokens(line)
                
                # Always preserve first few lines (likely headers/metadata)
                if i < 5 and not header_preserved:
                    truncated_lines.append(line)
                    used_tokens += line_tokens
                    if i == 4:
                        header_preserved = True
                    continue
                
                # Check if we can fit this line
                if used_tokens + line_tokens <= max_tokens - 500:  # Leave buffer for warning
                    truncated_lines.append(line)
                    used_tokens += line_tokens
                else:
                    break
            
            # Add truncation warning
            remaining_lines = len(lines) - len(truncated_lines)
            remaining_tokens = current_tokens - used_tokens
            
            truncation_warning = (
                f"\n\n... [RESULTS TRUNCATED - {remaining_lines:,} lines / "
                f"~{remaining_tokens:,} tokens omitted due to size limits. "
                f"Consider refining your query for more specific results.]"
            )
            
            truncated_result = '\n'.join(truncated_lines) + truncation_warning
            final_tokens = self.count_tokens(truncated_result)
            
            logger.info(f"✂️ ADX results truncated from {current_tokens:,} to {final_tokens:,} tokens")
            
            return truncated_result
            
        except Exception as e:
            logger.error(f"❌ Error truncating ADX results: {e}")
            # Emergency fallback - hard truncate
            return adx_results[:10000] + "\n\n... [TRUNCATED DUE TO ERROR]"
    
    def check_synthesis_feasibility(self, specialist_responses: List[str], 
                                  coordinator_response: str = "") -> Tuple[bool, int]:
        """Check if responses can be synthesized within token limits.
        
        Args:
            specialist_responses: List of specialist agent responses
            coordinator_response: Coordinator agent response
            
        Returns:
            Tuple[bool, int]: (is_feasible, total_tokens)
        """
        try:
            # Combine all content for token counting
            all_content = []
            if coordinator_response and coordinator_response.strip():
                all_content.append(coordinator_response)
            all_content.extend([r for r in specialist_responses if r and r.strip()])
            
            total_content = "\n\n".join(all_content)
            total_tokens = self.count_tokens(total_content)
            
            # Reserve space for synthesis prompt overhead (~1000 tokens)
            synthesis_overhead = 1000
            available_for_synthesis = self.SAFE_LIMIT - synthesis_overhead
            
            is_feasible = total_tokens <= available_for_synthesis
            
            if not is_feasible:
                logger.warning(f"🚨 SYNTHESIS TOKEN OVERFLOW: {total_tokens:,} tokens exceed synthesis limit")
            
            return is_feasible, total_tokens
            
        except Exception as e:
            logger.error(f"❌ Error checking synthesis feasibility: {e}")
            return False, 0
    
    def prepare_emergency_synthesis(self, specialist_responses: List[str], 
                                  coordinator_response: str = "") -> str:
        """Prepare emergency synthesis when token limit exceeded.
        
        This method provides a fallback when LLM synthesis would exceed token limits.
        It performs simple concatenation with basic deduplication.
        
        Args:
            specialist_responses: List of specialist agent responses
            coordinator_response: Coordinator agent response
            
        Returns:
            str: Emergency-synthesized response
        """
        try:
            logger.info("🔄 Using emergency synthesis (token limit exceeded)")
            
            all_responses = []
            
            # Add coordinator response if substantial and not just routing
            if coordinator_response and len(coordinator_response.strip()) > 10:
                # Skip coordinator responses that are just routing instructions
                routing_keywords = ["specialist", "defer", "better suited", "route this", "delegate"]
                if not any(keyword in coordinator_response.lower() for keyword in routing_keywords):
                    all_responses.append(coordinator_response.strip())
            
            # Process specialist responses
            for response in specialist_responses:
                if not response or len(response.strip()) <= 10:
                    continue
                    
                cleaned_response = response.strip()
                
                # Remove agent name prefixes (e.g., "[DocumentAgent] content...")
                if cleaned_response.startswith("[") and "] " in cleaned_response:
                    cleaned_response = cleaned_response.split("] ", 1)[1].strip()
                elif ":" in cleaned_response and len(cleaned_response.split(":", 1)[0]) < 20:
                    # Remove short prefixes like "Agent: content"
                    cleaned_response = cleaned_response.split(":", 1)[1].strip()
                
                if cleaned_response and len(cleaned_response) > 10:
                    all_responses.append(cleaned_response)
            
            if not all_responses:
                return "No detailed response available due to processing constraints."
            
            # Simple concatenation with separators
            emergency_response = "\n\n".join(all_responses)
            
            # Add a note about emergency mode
            emergency_note = "\n\n[Note: Response assembled in emergency mode due to size constraints]"
            final_response = emergency_response + emergency_note
            
            final_tokens = self.count_tokens(final_response)
            logger.info(f"🆘 Emergency synthesis completed: {final_tokens:,} tokens")
            
            return final_response
            
        except Exception as e:
            logger.error(f"❌ Emergency synthesis failed: {e}")
            return f"Response processing encountered an error: {str(e)}"
    
    def optimize_for_agent_context(self, content: str, agent_type: str = "general", 
                                 max_tokens: int = 8000) -> str:
        """Optimize content for specific agent context.
        
        Args:
            content: Content to optimize
            agent_type: Type of agent (adx, document, investigator, fictional)
            max_tokens: Maximum tokens allowed
            
        Returns:
            str: Optimized content
        """
        current_tokens = self.count_tokens(content)
        
        if current_tokens <= max_tokens:
            return content
        
        logger.info(f"🔧 Optimizing {agent_type} content: {current_tokens:,} → {max_tokens:,} tokens")
        
        # Agent-specific optimization strategies
        if agent_type.lower() == "adx":
            return self._optimize_adx_content(content, max_tokens)
        elif agent_type.lower() == "document":
            return self._optimize_document_content(content, max_tokens)
        else:
            return self._optimize_general_content(content, max_tokens)
    
    def _optimize_adx_content(self, content: str, max_tokens: int) -> str:
        """Optimize ADX query results."""
        # For ADX, preserve structure but limit rows
        lines = content.split('\n')
        
        # Keep headers and first portion of data
        header_lines = []
        data_lines = []
        
        for i, line in enumerate(lines):
            if i < 10 or any(keyword in line.lower() for keyword in ['query', 'table', 'result']):
                header_lines.append(line)
            else:
                data_lines.append(line)
        
        # Add data lines until we hit the limit
        optimized_lines = header_lines[:]
        used_tokens = self.count_tokens('\n'.join(header_lines))
        
        for line in data_lines:
            line_tokens = self.count_tokens(line)
            if used_tokens + line_tokens <= max_tokens - 100:
                optimized_lines.append(line)
                used_tokens += line_tokens
            else:
                break
        
        if len(data_lines) > len(optimized_lines) - len(header_lines):
            omitted = len(data_lines) - (len(optimized_lines) - len(header_lines))
            optimized_lines.append(f"... [{omitted} rows omitted due to size limits]")
        
        return '\n'.join(optimized_lines)
    
    def _optimize_document_content(self, content: str, max_tokens: int) -> str:
        """Optimize document content."""
        # For documents, preserve beginning and key sections
        if len(content) <= max_tokens * 3:  # Rough character estimate
            return content
        
        # Split into paragraphs
        paragraphs = content.split('\n\n')
        
        # Keep first few paragraphs and any with keywords
        keywords = ['summary', 'conclusion', 'result', 'important', 'key', 'analysis']
        important_paragraphs = []
        used_tokens = 0
        
        # Always include first paragraph
        if paragraphs:
            important_paragraphs.append(paragraphs[0])
            used_tokens += self.count_tokens(paragraphs[0])
        
        # Add paragraphs with keywords
        for para in paragraphs[1:]:
            para_tokens = self.count_tokens(para)
            has_keywords = any(keyword in para.lower() for keyword in keywords)
            
            if (has_keywords or len(important_paragraphs) < 5) and used_tokens + para_tokens <= max_tokens:
                important_paragraphs.append(para)
                used_tokens += para_tokens
        
        result = '\n\n'.join(important_paragraphs)
        if len(paragraphs) > len(important_paragraphs):
            result += "\n\n... [Document content truncated for brevity]"
        
        return result
    
    def _optimize_general_content(self, content: str, max_tokens: int) -> str:
        """General content optimization."""
        target_chars = max_tokens * 3  # Rough estimate
        
        if len(content) <= target_chars:
            return content
        
        # Try to find a good break point
        sentences = content.split('. ')
        result = []
        used_chars = 0
        
        for sentence in sentences:
            if used_chars + len(sentence) <= target_chars - 50:
                result.append(sentence)
                used_chars += len(sentence)
            else:
                break
        
        if len(sentences) > len(result):
            result.append("... [Content truncated]")
        
        return '. '.join(result)


# Global token manager instance
token_manager = TokenManager()
