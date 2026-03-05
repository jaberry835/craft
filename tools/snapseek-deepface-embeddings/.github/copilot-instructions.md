# Azure Snap Seek - Intelligent Image Search Platform

## Project Overview
Azure Snap Seek is a multi-component intelligent image search solution powered by Azure AI services. It provides rich image indexing, semantic search, and an AI agent interface.

## Architecture Components

### 1. Image Indexer (`/indexer`)
- **Purpose**: Intelligent image analysis and indexing pipeline
- **Technologies**: Python, Azure Computer Vision, Azure Document Intelligence, Face API, OpenAI embeddings
- **Features**:
  - Extract visual features, tags, captions using Azure CV
  - OCR text extraction via Document Intelligence
  - Face detection and analysis
  - Dual embedding support (text description + raw image vectors)
  - Batch processing capabilities

### 2. Backend API (`/backend`)
- **Purpose**: FastAPI service for search queries and data retrieval
- **Technologies**: Python, FastAPI, Azure AI Search SDK
- **Features**:
  - Hybrid search (keyword + vector)
  - Faceted filtering
  - Image metadata retrieval
  - Chat interface integration

### 3. Frontend (`/frontend`)
- **Purpose**: Modern React-based user interface
- **Technologies**: React, TypeScript, TailwindCSS, Vite
- **Features**:
  - Image gallery with search
  - Detailed image info panels
  - Chat-based search interface
  - Responsive design

### 4. Azure Agent (`/agent`)
- **Purpose**: AI Agent for programmatic search integration
- **Technologies**: Python, Azure Agent Framework, Azure Functions
- **Features**:
  - Tool-based search interface
  - Conversational image discovery
  - Integration with other applications

## Development Guidelines

### Python Code Style
- Use Python 3.11+
- Follow PEP 8 guidelines
- Use type hints for all functions
- Use async/await for I/O operations
- Use pydantic for data validation

### React/TypeScript Style
- Use functional components with hooks
- Use TypeScript strict mode
- Use TailwindCSS for styling
- Follow React best practices

### Azure Services
- Azure AI Search for indexing and search
- Azure Computer Vision 4.0 for image analysis
- Azure Document Intelligence for OCR
- Azure Face API for face detection
- Azure OpenAI for embeddings and chat
- Azure Functions for agent hosting

### Environment Variables
All services require proper Azure credentials. See `.env.example` files in each component.

## Running the Project

### Prerequisites
- Python 3.11+
- Node.js 20+
- Azure subscription with required services
- Docker (optional, for containerized deployment)

### Local Development
```bash
# Indexer
cd indexer && pip install -r requirements.txt && python -m indexer.main

# Backend
cd backend && pip install -r requirements.txt && uvicorn app.main:app --reload

# Frontend
cd frontend && npm install && npm run dev

# Agent
cd agent && pip install -r requirements.txt && func start
```

### Docker Deployment
```bash
docker-compose up --build
```
