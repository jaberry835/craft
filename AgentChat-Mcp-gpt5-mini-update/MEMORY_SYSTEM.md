# Memory System Documentation

This document describes the new memory capabilities added to AgentChat using Semantic Kernel's ChatHistory functionality with CosmosDB persistence.

## Overview

The memory system provides conversation context and continuity across chat sessions by:

1. **Using Semantic Kernel's ChatHistory** for managing conversation context
2. **Persisting chat history** to CosmosDB for long-term storage
3. **Managing memory efficiently** with automatic truncation and reduction
4. **Supporting tool calls and function results** in conversation context
5. **Providing context awareness** for agents to understand previous conversations

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Chat Session  │    │  Memory Service │    │   CosmosDB      │
│                 │    │                 │    │                 │
│ User Messages   │◄──►│ ChatHistory     │◄──►│ Serialized      │
│ Agent Responses │    │ Management      │    │ Chat History    │
│ Tool Calls      │    │ Serialization   │    │ Storage         │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## Key Components

### 1. MemoryService (`src/services/memory_service.py`)

The core service that manages chat history and provides memory functionality:

- **ChatHistory Management**: Creates and manages Semantic Kernel ChatHistory objects
- **Message Operations**: Add user, assistant, and tool messages
- **Serialization**: Convert ChatHistory to/from JSON for storage
- **Memory Reduction**: Automatic truncation to manage memory size
- **Context Summaries**: Generate conversation summaries

### 2. Enhanced CosmosDBService

Updated to integrate with the memory service:

- **Session Creation**: Automatically initializes memory for new sessions
- **Memory Persistence**: Saves/loads chat history to/from CosmosDB
- **Session Management**: Handles memory cleanup and archiving

### 3. Enhanced MultiAgentSystem

Updated to use conversation context:

- **Context Loading**: Loads existing conversation context for sessions
- **Memory Integration**: Adds messages to memory after processing
- **Context Injection**: Provides conversation context to agents
- **Memory Management**: Automatic reduction when conversations get large

## Features

### Conversation Context

The system maintains context across the entire conversation:

```python
# Example conversation flow with context
Session 1:
User: "Calculate the factorial of 5"
Assistant: "5! = 120"

User: "What about the factorial of that result?"
Assistant: "I'll calculate the factorial of 120 (the previous result)..."
```

### Automatic Memory Management

- **Truncation**: Automatically reduces conversation history when it gets too large
- **Preservation**: Keeps important system messages and recent context
- **Efficiency**: Balances context retention with performance

### Tool Call Memory

The system remembers tool calls and their results:

```python
# Tool call memory example
User: "Get company info for IP 192.168.1.100"
[Tool Call: get_company_info(ip="192.168.1.100")]
[Tool Result: "TechCorp Limited - Technology Services"]
Assistant: "Based on the lookup, that IP belongs to TechCorp Limited..."

User: "Tell me more about that company"
Assistant: "TechCorp Limited (from the previous lookup) is a technology services company..."
```

### Persistence

Chat history is automatically saved to CosmosDB:

- **Serialization**: Converts ChatHistory to JSON format
- **Storage**: Saves as part of session metadata
- **Loading**: Restores ChatHistory when session is accessed
- **Backup**: Maintains conversation history even if memory cache is cleared

## API Endpoints

### Memory Management Endpoints

#### Load Session Memory
```http
POST /api/chat/session/{sessionId}/memory/load
Content-Type: application/json

{
  "userId": "user-123"
}
```

#### Save Session Memory
```http
POST /api/chat/session/{sessionId}/memory/save
Content-Type: application/json

{
  "userId": "user-123"
}
```

#### Reduce Session Memory
```http
POST /api/chat/session/{sessionId}/memory/reduce
Content-Type: application/json

{
  "userId": "user-123",
  "targetCount": 30
}
```

#### Get Context Summary
```http
GET /api/chat/session/{sessionId}/context?maxChars=1000
```

## Usage Examples

### Basic Memory Operations

```python
from services.memory_service import memory_service

# Create new chat history for a session
session_id = "chat-session-123"
chat_history = memory_service.create_chat_history(session_id)

# Add messages
memory_service.add_user_message(session_id, "Hello!", "user-123")
memory_service.add_assistant_message(session_id, "Hi there!", "CoordinatorAgent")

# Get context summary
summary = memory_service.get_context_summary(session_id, 500)

# Save to persistent storage
await memory_service.save_chat_history(session_id, "user-123")
```

### Integration with Multi-Agent System

The multi-agent system automatically uses memory:

```python
# Process question with memory context
response = await agent_system.process_question(
    question="What was my previous question about?",
    session_id="chat-session-123",
    user_id="user-123"
)
# The system will load conversation history and provide context-aware response
```

### Memory Reduction

```python
# Reduce memory when conversation gets large
was_reduced = await memory_service.reduce_chat_history(
    session_id="chat-session-123",
    target_count=30  # Keep last 30 messages
)
```

## Configuration

### Memory Settings

Default settings in `MemoryService`:

- **Max Messages**: 50 messages per session (with truncation at 60)
- **Target Reduction**: 30 messages when reduction is triggered
- **Context Summary**: 1000 characters maximum
- **Auto-Save**: Enabled after each conversation turn

### Performance Considerations

- **Memory Usage**: ChatHistory objects are kept in memory for active sessions
- **Storage**: Serialized histories are stored in CosmosDB session documents
- **Cleanup**: Memory is automatically cleared for inactive sessions
- **Reduction**: Large conversations are automatically truncated to maintain performance

## Best Practices

### 1. Session Management

```python
# Always provide session_id and user_id for memory persistence
response = await agent_system.process_question(
    question="Your question here",
    session_id=session_id,  # Required for memory
    user_id=user_id        # Required for persistence
)
```

### 2. Memory Monitoring

```python
# Check memory size periodically
chat_history = memory_service.get_chat_history(session_id)
if chat_history and len(chat_history.messages) > 40:
    await memory_service.reduce_chat_history(session_id, 30)
```

### 3. Context Utilization

```python
# Use context summaries for debugging and monitoring
context = memory_service.get_context_summary(session_id, 500)
logger.info(f"Conversation context: {context}")
```

## Migration Guide

### For Existing Sessions

Existing sessions without memory will automatically:

1. **Initialize Memory**: Create new ChatHistory when first accessed
2. **Load Messages**: Convert existing messages to ChatHistory format
3. **Enable Features**: Gain access to all memory features

### For New Development

When creating new features:

1. **Use Session Context**: Always provide session_id for context-aware responses
2. **Check Memory**: Verify if session has existing context
3. **Add to Memory**: Ensure new messages are added to memory
4. **Save Changes**: Persist memory changes to storage

## Troubleshooting

### Common Issues

1. **Memory Not Loading**: Check session_id and user_id are provided
2. **Large Memory Usage**: Enable automatic reduction or manually reduce
3. **Serialization Errors**: Check for circular references in custom message types
4. **Performance Issues**: Reduce memory size or enable truncation

### Debugging

```python
# Debug memory state
chat_history = memory_service.get_chat_history(session_id)
if chat_history:
    print(f"Messages in memory: {len(chat_history.messages)}")
    for msg in chat_history.messages[-5:]:  # Last 5 messages
        print(f"{msg.role}: {str(msg.content)[:100]}...")
```

## Testing

Use the provided test script to verify memory functionality:

```bash
cd PythonAPI
python test_memory_system.py
```

This will test:
- Memory creation and management
- Serialization and deserialization
- Context summaries
- Memory reduction
- Tool call integration
- Integration scenarios

## Future Enhancements

Planned improvements:

1. **Memory Search**: Semantic search within conversation history
2. **Smart Summarization**: AI-powered conversation summarization
3. **Memory Sharing**: Share context between related sessions
4. **Advanced Reduction**: Context-aware memory reduction strategies
5. **Analytics**: Memory usage analytics and optimization

## Conclusion

The memory system provides powerful conversation context capabilities while maintaining performance and storage efficiency. It seamlessly integrates with the existing AgentChat architecture and provides a foundation for more advanced conversational AI features.
