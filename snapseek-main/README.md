# Azure Snap Seek - Intelligent Image Search Platform

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Azure Snap Seek is a comprehensive, AI-powered image search solution built on Azure services. It combines advanced computer vision, document intelligence, and semantic search capabilities to provide rich, intelligent image discovery.

## 🌟 Features

- **Rich Image Analysis**: Extract visual features, tags, captions, and detected objects using Azure Computer Vision 4.0
- **OCR Extraction**: Extract text from images using Azure Document Intelligence
- **Face Detection**: Detect and analyze faces in images
- **Dual Vector Search**: Support for both text-based embeddings and raw image embeddings
- **Hybrid Search**: Combine keyword and vector search for optimal results
- **Modern UI**: React-based responsive interface with gallery and chat views
- **AI Agent**: Integrate image search into other applications via Azure Agent Framework

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Azure Snap Seek                              │
├─────────────────┬─────────────────┬─────────────────┬──────────────┤
│    Indexer      │    Backend      │    Frontend     │    Agent     │
│   (Python)      │   (FastAPI)     │   (React/TS)    │  (Functions) │
├─────────────────┴─────────────────┴─────────────────┴──────────────┤
│                        Azure Services                               │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌──────────────┐  │
│  │ AI Search   │ │ Computer    │ │ Document    │ │ OpenAI       │  │
│  │             │ │ Vision      │ │ Intelligence│ │ Embeddings   │  │
│  └─────────────┘ └─────────────┘ └─────────────┘ └──────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## 📁 Project Structure

```
snapseek/
├── indexer/                 # Image analysis & indexing pipeline
│   ├── indexer/
│   │   ├── analyzers/       # Azure CV, Doc Intel, Face analyzers
│   │   ├── embeddings/      # Text & image embedding generators
│   │   ├── models/          # Pydantic data models
│   │   └── search/          # Azure Search index management
│   └── requirements.txt
├── backend/                 # FastAPI search API
│   ├── app/
│   │   ├── routers/         # API endpoints
│   │   ├── services/        # Business logic
│   │   └── models/          # Request/response models
│   └── requirements.txt
├── frontend/                # React TypeScript UI
│   ├── src/
│   │   ├── components/      # React components
│   │   ├── hooks/           # Custom hooks
│   │   ├── services/        # API clients
│   │   └── types/           # TypeScript types
│   └── package.json
├── agent/                   # Azure Agent Framework
│   ├── functions/           # Azure Functions
│   └── requirements.txt
├── docker-compose.yml       # Container orchestration
└── infra/                   # Azure deployment (Bicep/Terraform)
```

## 🚀 Quick Start

### Prerequisites

- Python 3.11+
- Node.js 20+
- Azure subscription with:
  - Azure AI Search
  - Azure Computer Vision
  - Azure Document Intelligence
  - Azure OpenAI
  - Azure Face API (optional)

### Environment Setup

1. Clone the repository:
```bash
git clone https://github.com/yourusername/snapseek.git
cd snapseek
```

2. Copy environment files:
```bash
cp indexer/.env.example indexer/.env
cp backend/.env.example backend/.env
cp agent/.env.example agent/.env
```

3. Update `.env` files with your Azure credentials.

### Running Components

#### Indexer
```bash
cd indexer
pip install -r requirements.txt
python -m indexer.main --source /path/to/images
```

#### Backend
```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

#### Frontend
```bash
cd frontend
npm install
npm run dev
```

#### Agent (Azure Functions)
```bash
cd agent
pip install -r requirements.txt
func start
```

### Docker Deployment
```bash
docker-compose up --build
```

## 🔧 Configuration

### Azure AI Search Index Schema

The search index supports:
- **Text fields**: filename, caption, tags, detected_text, objects
- **Vector fields**: 
  - `description_vector` (1536 dims) - OpenAI text embedding
  - `image_vector` (768 dims) - Direct image embedding
- **Facets**: tags, objects, has_faces, has_text

### Embedding Models

1. **Text Embeddings** (OpenAI `text-embedding-3-small`):
   - Generates vectors from image descriptions
   - 1536 dimensions

2. **Image Embeddings** (imgbeddings/CLIP):
   - Direct image-to-vector conversion
   - 768 dimensions

## 📖 API Reference

### Backend Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/search` | POST | Hybrid search with filters |
| `/api/images/{id}` | GET | Get image details |
| `/api/images` | GET | List all images with pagination |
| `/api/chat` | POST | Chat-based image search |
| `/api/facets` | GET | Get available filter facets |

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Azure AI Services
- OpenAI
- imgbeddings library
- FastAPI
- React & Vite
