# Python Flask MCP Server
# Multi-Agent Orchestration with Azure Services

A Python Flask implementation of the multi-agent MCP server with identical capabilities to the C# version.

## Features

- **Multi-Agent Orchestration**: Specialized LLM agents for different domains
- **Azure OpenAI Integration**: Each agent uses Azure OpenAI with Semantic Kernel
- **MCP Protocol Support**: Compatible with Model Context Protocol
- **Real-time SignalR**: Agent activity streaming to frontend
- **Azure Services Integration**: Documents, Search, ADX, Maps, Storage
- **RAG Workflows**: Documents → ADX cross-referencing
- **Smart Routing**: ADX → Maps address lookup and directions

## Agents

1. **Core Agent**: General queries and system operations
2. **ADX Agent**: Azure Data Explorer queries and database operations
3. **Maps Agent**: Azure Maps geocoding, routing, and visualization
4. **Documents Agent**: Document upload, search, and RAG operations
5. **Resources Agent**: Azure resource management

## Installation

```bash
cd Python-MCP-Server
pip install -r requirements.txt
```

## Configuration

Copy `config.example.json` to `config.json` and fill in your Azure service credentials.

## Run

```bash
python app.py
```

## API Endpoints

- `POST /api/chat/completions` - Main chat endpoint
- `POST /api/chat/message` - Save message
- `GET /api/chat/history` - Get chat history
- `POST /api/documents/upload` - Upload documents
- `GET /api/mcp/server/info` - MCP server information
- `GET /api/agents/status` - Agent health status

## WebSocket

- `/ws/agent-activity` - Real-time agent interactions
