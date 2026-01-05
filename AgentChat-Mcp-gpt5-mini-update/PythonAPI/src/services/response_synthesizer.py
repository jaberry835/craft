"""Response synthesis service for coordinating multiple agent responses."""

from typing import List, Dict, Any, Optional
import json

try:
    from ..utils.logging import get_logger
    from .token_management import token_manager
except ImportError:
    from src.utils.logging import get_logger
    from src.services.token_management import token_manager

logger = get_logger(__name__)


class ResponseSynthesizer:
    """Handles synthesis of multiple agent responses with token management."""
    
    def __init__(self):
        """Initialize the response synthesizer."""
        self.token_manager = token_manager
    
    async def synthesize_responses(self, 
                                 specialist_responses: List[str], 
                                 coordinator_response: str = "", 
                                 original_question: str = "",
                                 use_llm_synthesis: bool = True) -> str:
        """
        Synthesize multiple agent responses with token limit protection.
        
        Args:
            specialist_responses: List of responses from specialist agents
            coordinator_response: Response from coordinator agent
            original_question: Original user question for context
            use_llm_synthesis: Whether to use LLM for synthesis (vs emergency mode)
            
        Returns:
            str: Synthesized response
        """
        try:
            logger.info(f"🧠 Synthesizing {len(specialist_responses)} specialist responses")
            
            # Check if synthesis is feasible within token limits
            is_feasible, total_tokens = self.token_manager.check_synthesis_feasibility(
                specialist_responses, coordinator_response
            )
            
            if not is_feasible or not use_llm_synthesis:
                # Use emergency synthesis for large responses
                logger.info(f"⚠️ Using emergency synthesis (feasible={is_feasible}, tokens={total_tokens:,})")
                return self.token_manager.prepare_emergency_synthesis(
                    specialist_responses, coordinator_response
                )
            
            # Use LLM synthesis for manageable responses
            logger.info(f"✅ Using LLM synthesis (tokens={total_tokens:,})")
            return await self._llm_synthesis(
                specialist_responses, coordinator_response, original_question
            )
            
        except Exception as e:
            logger.error(f"❌ Synthesis error: {e}")
            # Fallback to emergency synthesis
            return self.token_manager.prepare_emergency_synthesis(
                specialist_responses, coordinator_response
            )
    
    async def _llm_synthesis(self, 
                           specialist_responses: List[str], 
                           coordinator_response: str, 
                           original_question: str) -> str:
        """
        Use LLM to synthesize responses intelligently.
        
        This method would ideally use an LLM to create a cohesive response
        from multiple agent outputs. For now, it performs intelligent concatenation.
        
        Args:
            specialist_responses: List of specialist responses
            coordinator_response: Coordinator response
            original_question: Original question
            
        Returns:
            str: Synthesized response
        """
        try:
            # For now, use intelligent concatenation
            # TODO: Implement actual LLM synthesis when we have access to synthesis LLM
            return self._intelligent_concatenation(
                specialist_responses, coordinator_response, original_question
            )
            
        except Exception as e:
            logger.error(f"❌ LLM synthesis failed: {e}")
            return self.token_manager.prepare_emergency_synthesis(
                specialist_responses, coordinator_response
            )
    
    def _intelligent_concatenation(self, 
                                 specialist_responses: List[str], 
                                 coordinator_response: str, 
                                 original_question: str) -> str:
        """
        Intelligently concatenate responses with deduplication and formatting.
        
        Args:
            specialist_responses: List of specialist responses
            coordinator_response: Coordinator response
            original_question: Original question
            
        Returns:
            str: Concatenated and formatted response
        """
        try:
            response_sections = []
            
            # Add coordinator response if it's substantial and not just routing
            if coordinator_response and len(coordinator_response.strip()) > 20:
                routing_indicators = [
                    "delegating", "routing", "forwarding", "specialist", 
                    "better suited", "defer", "appropriate agent"
                ]
                
                if not any(indicator in coordinator_response.lower() for indicator in routing_indicators):
                    response_sections.append({
                        "source": "coordinator",
                        "content": coordinator_response.strip(),
                        "priority": 1
                    })
            
            # Process specialist responses
            for i, response in enumerate(specialist_responses):
                if not response or len(response.strip()) <= 20:
                    continue
                
                cleaned_response = self._clean_specialist_response(response)
                
                if cleaned_response:
                    response_sections.append({
                        "source": f"specialist_{i}",
                        "content": cleaned_response,
                        "priority": 2
                    })
            
            if not response_sections:
                return "No substantial response available from the agents."
            
            # Sort by priority and remove duplicates
            response_sections.sort(key=lambda x: x["priority"])
            unique_sections = self._remove_duplicate_content(response_sections)
            
            # Format the final response
            if len(unique_sections) == 1:
                return unique_sections[0]["content"]
            else:
                # Multiple responses - format nicely
                formatted_parts = []
                for section in unique_sections:
                    content = section["content"]
                    # Don't add headers for now - just clean content
                    formatted_parts.append(content)
                
                return "\n\n".join(formatted_parts)
                
        except Exception as e:
            logger.error(f"❌ Intelligent concatenation failed: {e}")
            # Fallback to simple joining
            all_content = [coordinator_response] + specialist_responses
            return "\n\n".join([c for c in all_content if c and c.strip()])
    
    def _clean_specialist_response(self, response: str) -> str:
        """Clean specialist response by removing agent prefixes and formatting."""
        try:
            cleaned = response.strip()
            
            # Remove agent name prefixes like "[DocumentAgent]" or "DocumentAgent:"
            if cleaned.startswith("[") and "] " in cleaned:
                cleaned = cleaned.split("] ", 1)[1].strip()
            elif ":" in cleaned:
                prefix = cleaned.split(":", 1)[0]
                # Only remove if prefix looks like an agent name (short, no spaces)
                if len(prefix) < 30 and " " not in prefix and "Agent" in prefix:
                    cleaned = cleaned.split(":", 1)[1].strip()
            
            # Remove common agent response prefixes
            prefixes_to_remove = [
                "Based on the document analysis:",
                "According to the search results:",
                "From the database query:",
                "Analysis shows:",
                "The results indicate:"
            ]
            
            for prefix in prefixes_to_remove:
                if cleaned.lower().startswith(prefix.lower()):
                    cleaned = cleaned[len(prefix):].strip()
                    break
            
            return cleaned
            
        except Exception as e:
            logger.error(f"❌ Error cleaning specialist response: {e}")
            return response
    
    def _remove_duplicate_content(self, sections: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Remove sections with duplicate or very similar content."""
        try:
            if len(sections) <= 1:
                return sections
            
            unique_sections = []
            seen_content = set()
            
            for section in sections:
                content = section["content"]
                
                # Create a normalized version for comparison
                normalized = self._normalize_for_comparison(content)
                
                # Check if we've seen very similar content
                is_duplicate = False
                for seen in seen_content:
                    if self._calculate_similarity(normalized, seen) > 0.8:
                        is_duplicate = True
                        break
                
                if not is_duplicate:
                    unique_sections.append(section)
                    seen_content.add(normalized)
            
            return unique_sections
            
        except Exception as e:
            logger.error(f"❌ Error removing duplicates: {e}")
            return sections
    
    def _normalize_for_comparison(self, content: str) -> str:
        """Normalize content for similarity comparison."""
        try:
            # Convert to lowercase and remove extra whitespace
            normalized = " ".join(content.lower().split())
            
            # Remove common punctuation
            chars_to_remove = ".,!?;:()[]{}\"'"
            for char in chars_to_remove:
                normalized = normalized.replace(char, " ")
            
            # Remove extra spaces
            normalized = " ".join(normalized.split())
            
            return normalized
            
        except Exception as e:
            logger.error(f"❌ Error normalizing content: {e}")
            return content.lower()
    
    def _calculate_similarity(self, text1: str, text2: str) -> float:
        """Calculate similarity between two texts (0.0 to 1.0)."""
        try:
            # Simple word-based similarity
            words1 = set(text1.split())
            words2 = set(text2.split())
            
            if not words1 and not words2:
                return 1.0
            if not words1 or not words2:
                return 0.0
            
            intersection = words1.intersection(words2)
            union = words1.union(words2)
            
            return len(intersection) / len(union)
            
        except Exception as e:
            logger.error(f"❌ Error calculating similarity: {e}")
            return 0.0
    
    def format_multi_agent_response(self, 
                                  responses: List[Dict[str, Any]], 
                                  include_sources: bool = False) -> str:
        """
        Format multiple agent responses with optional source attribution.
        
        Args:
            responses: List of response dicts with 'agent', 'content', etc.
            include_sources: Whether to include agent source information
            
        Returns:
            str: Formatted response
        """
        try:
            if not responses:
                return "No responses available."
            
            if len(responses) == 1:
                # Single response - just return the content
                return responses[0].get("content", "")
            
            # Multiple responses - format with sections
            formatted_parts = []
            
            for response in responses:
                agent_name = response.get("agent", "Unknown")
                content = response.get("content", "")
                
                if not content or len(content.strip()) <= 10:
                    continue
                
                if include_sources:
                    # Include source attribution
                    formatted_parts.append(f"**{agent_name}:**\n{content}")
                else:
                    # Just the content
                    formatted_parts.append(content)
            
            return "\n\n".join(formatted_parts)
            
        except Exception as e:
            logger.error(f"❌ Error formatting multi-agent response: {e}")
            # Fallback to simple concatenation
            contents = [r.get("content", "") for r in responses if r.get("content")]
            return "\n\n".join(contents)


# Global response synthesizer instance
response_synthesizer = ResponseSynthesizer()
