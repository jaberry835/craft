# PixelPress — FCA Print & Digital Media Center

A demo application showcasing an AI-powered assistant for a fictitious Federal Consolidated Agency (FCA) print shop. The assistant helps government employees create media production requests while enforcing compliance with 8 agency directives (~25K tokens of policy loaded in-context).

Built with **React + TypeScript** on the frontend and **Microsoft Agent Framework + Azure OpenAI** on the backend, connected via Server-Sent Events (SSE) for real-time streaming responses.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  React + TypeScript + Vite (Frontend :5173)          │
│  ┌────────────────────┬────────────────────────────┐  │
│  │  Request Wizard    │  Chat Panel (SSE stream)   │  │
│  │  6-step form       │  ← shared FormContext →    │  │
│  └────────────────────┴────────────────────────────┘  │
│            ↓ POST /api/chat (SSE)                     │
├──────────────────────────────────────────────────────┤
│  FastAPI Backend (Python :8000)                      │
│  ┌──────────────────────────────────────────────┐    │
│  │  Microsoft Agent Framework + Azure OpenAI    │    │
│  │  • ChatAgent with 3 tools                    │    │
│  │  • All 8 policy docs loaded in-context       │    │
│  │  • AgentThread-based multi-turn sessions     │    │
│  └──────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────┘
```

### Agent Tools

| Tool | Description |
|------|-------------|
| `update_form_field` | Sets fields on the request form — changes appear instantly in the wizard UI |
| `calculate_cost` | Estimates pricing using DIRECTIVE-1050 cost tables, with priority & classification surcharges |
| `validate_request` | Checks the complete form against all FCA directives; walks the user through fixes one at a time |

### Key Features

- **Bidirectional form sync** — the chat assistant and wizard share state via React Context; the agent can fill in form fields and the wizard reflects changes immediately
- **SSE streaming** — responses stream token-by-token for a responsive feel
- **Policy-aware** — all 8 directive documents are loaded into the system prompt so the agent can cite specific sections and link directly to the in-app policy viewer
- **Guided validation** — when multiple issues are found, the agent shows a summary then walks through each fix one at a time
- **Validate shortcut** — a dedicated button in the chat header triggers form validation with one click

---

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Node.js | ≥ 18 |
| Python | ≥ 3.11 |
| Azure OpenAI deployment | GPT-4o or later recommended |

Authentication options:
- **API key** — set `AZURE_OPENAI_API_KEY` in the `.env` file
- **Azure Identity** — omit the API key and the backend uses `DefaultAzureCredential` (supports Azure CLI login, managed identity, etc.)

---

## Build & Run (Local Development)

### 1. Frontend

```bash
# Install dependencies
npm install

# Start the dev server (hot-reload)
npm run dev
```

The frontend starts at **http://localhost:5173**. It expects the backend at `http://localhost:8000` by default (configurable via `VITE_API_URL` env var).

#### Production build

```bash
npm run build       # outputs to dist/
npm run preview     # preview the production build locally
```

For static `dist/` hosting (no nginx/container), set backend URL at runtime in `dist/runtime-config.js`:

```js
window.__APP_CONFIG__ = {
  API_URL: 'https://YOUR-BACKEND-APP.azurewebsites.net'
};
```

### 2. Backend

```bash
cd backend

# Create and activate a virtual environment
python -m venv .venv

# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

#### Configure environment

```bash
cp .env.example .env
```

Edit `backend/.env` with your Azure OpenAI values:

```env
# Required
AZURE_OPENAI_ENDPOINT=https://YOUR-RESOURCE.openai.azure.com/
AZURE_OPENAI_CHAT_DEPLOYMENT_NAME=gpt-4o

# Auth — choose one:
AZURE_OPENAI_API_KEY=your-key-here        # Option A: API key
# (or omit to use DefaultAzureCredential)  # Option B: Azure Identity
```

#### Start the server

```bash
python main.py       # http://localhost:8000 with auto-reload
```

Verify it's running:

```bash
curl http://localhost:8000/api/health
# → {"status":"ok","service":"pixelpress-ai"}
```

### 3. Use the App

1. Open **http://localhost:5173**
2. The chat panel on the right shows **Online** when connected to the backend
3. Ask the assistant to help create a request, check policy compliance, or estimate costs
4. Click the **Validate** button in the chat header to check the current form against all directives
5. Navigate to **Policies & Directives** in the top nav to browse the 8 FCA directives

---

## Docker

Each service has its own Dockerfile and can be built/run independently. No `docker-compose` required.

### Backend container

```bash
docker build -t pixelpress-backend ./backend
docker run -p 8000:8000 \
  --env-file backend/.env \
  -v ./policies:/app/policies:ro \
  pixelpress-backend
```

The policies directory is mounted as a read-only volume so the agent can load them at startup.

### Frontend container

```bash
docker build -t pixelpress-frontend .
docker run -p 3000:80 \
  -e BACKEND_UPSTREAM=https://YOUR-BACKEND-APP.azurewebsites.net \
  pixelpress-frontend
```

The frontend image uses a multi-stage build (Node → nginx). The included `nginx.conf` serves the SPA and proxies `/api/` requests to the backend.

> **Note:** The nginx config reads `BACKEND_UPSTREAM` at container startup. In Azure
> App Service (frontend), set `BACKEND_UPSTREAM` to your backend base URL.

---

## Project Structure

```
PrintShopDemo/
├── src/                        # React frontend
│   ├── components/
│   │   ├── ChatPanel.tsx       # Live chat with SSE streaming
│   │   ├── ChatPanel.css       # Chat bubble & message styles
│   │   ├── Navbar.tsx          # Top navigation bar
│   │   ├── MainContent.tsx     # Landing page / dashboard
│   │   ├── ResizablePane.tsx   # Draggable chat sidebar
│   │   ├── PolicyIndex.tsx     # Policy directory grid
│   │   ├── PolicyViewer.tsx    # Markdown policy reader with TOC
│   │   └── wizard/             # 6-step request form
│   │       ├── RequestWizard.tsx
│   │       ├── StepType.tsx
│   │       ├── StepSubType.tsx
│   │       ├── StepDetails.tsx
│   │       ├── StepContact.tsx
│   │       ├── StepDelivery.tsx
│   │       └── StepReview.tsx
│   ├── contexts/
│   │   └── FormContext.tsx     # Shared form state (wizard ↔ chat)
│   ├── types/
│   │   └── request.ts          # TypeScript types & constants
│   ├── data/
│   │   └── policies.ts         # Policy metadata registry
│   ├── App.tsx                 # Root component with routing
│   └── main.tsx                # Entry point (BrowserRouter)
├── policies/                   # 8 FCA directive markdown files
│   ├── directive-925.md        # Brand Identity & Visual Standards
│   ├── directive-940.md        # Accessibility Standards
│   ├── directive-1000.md       # Print Services
│   ├── directive-1010.md       # Publication Design & Layout
│   ├── directive-1020.md       # Digital Media Production
│   ├── directive-1050.md       # Cost Estimation & Billing
│   ├── directive-1100.md       # Inventory Management
│   └── directive-1200.md       # Security Classification & Handling
├── backend/
│   ├── main.py                 # FastAPI app, SSE /api/chat endpoint
│   ├── agent_config.py         # ChatAgent, tools, system prompt, cost tables
│   ├── requirements.txt        # Python dependencies (pinned)
│   ├── .env.example            # Environment variable template
│   └── Dockerfile              # Python 3.12 slim container
├── Dockerfile                  # Frontend multi-stage build (Node → nginx)
├── nginx.conf                  # SPA routing + API reverse proxy
├── package.json                # Node dependencies & scripts
├── tsconfig.json               # TypeScript config
└── vite.config.ts              # Vite build config
```

---

## API Reference

### `POST /api/chat`

Streams an AI response via SSE.

**Request body:**
```json
{
  "message": "I need 500 business cards",
  "session_id": "uuid-string",
  "form_data": { "category": "print", "subType": "business-cards", ... }
}
```

**SSE events:**

| Event | Data | Description |
|-------|------|-------------|
| `token` | `{"text": "..."}` | Incremental text chunk from the agent |
| `tool_call` | `{"action": "update_field", "field": "quantity", "value": "500"}` | Agent updated a form field |
| `done` | `{"session_id": "..."}` | Stream complete |
| `error` | `{"message": "..."}` | Error occurred |

### `GET /api/health`

Returns `{"status": "ok", "service": "pixelpress-ai"}`.

---

## Policy Documents

| Directive | Title | Key Rules |
|-----------|-------|-----------|
| DIRECTIVE-925 | Brand Identity & Visual Standards | Logo usage, color palettes, typography |
| DIRECTIVE-940 | Accessibility Standards | WCAG compliance, alt text, contrast ratios |
| DIRECTIVE-1000 | Print Services — Requests & QC | Submission requirements, 50-char min description |
| DIRECTIVE-1010 | Publication Design & Layout | Poster max 48×72", typography standards |
| DIRECTIVE-1020 | Digital Media Production | Video ≤3 min, file formats, social specs |
| DIRECTIVE-1050 | Cost Estimation & Billing | Pricing tiers, priority/classification surcharges |
| DIRECTIVE-1100 | Inventory Management | Supply chain, stock levels |
| DIRECTIVE-1200 | Security Classification & Handling | CUI/FOUO rules, Super Classified requires GS-15+ |

---

## Tech Stack

- **Frontend:** React 19, TypeScript, Vite 7, react-router-dom, react-markdown, remark-gfm, lucide-react
- **Backend:** Python 3.12, FastAPI, uvicorn, python-dotenv
- **AI:** Microsoft Agent Framework (`agent-framework-core` + `agent-framework-azure-ai`), Azure OpenAI
- **Auth:** azure-identity (DefaultAzureCredential) or API key
- **Containers:** Docker (Python 3.12 slim + Node 20 alpine / nginx alpine)
