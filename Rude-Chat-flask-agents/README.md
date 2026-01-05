# Rude Chat

A ChatGPT-style Angular application with Azure integrations for enterprise-grade conversational AI.

## Features

🤖 **ChatGPT-Style UI** - Modern conversational interface with message bubbles and typing indicators  
🔐 **Azure Entra ID Authentication** - Secure user login and session management  
☁️ **Azure OpenAI Integration** - Powered by Azure OpenAI Service for chat completions  
📚 **RAG with Azure AI Search** - Upload documents for personalized knowledge retrieval  
🛠️ **MCP Server Integration** - Advanced tooling capabilities via Azure Functions  
💾 **Chat History Management** - Persistent conversation sessions per user  
📱 **Responsive Design** - Works seamlessly on desktop and mobile devices  

## Development

### Start Development Server
```bash
npm start
# or
ng serve
```

Navigate to `http://localhost:4200`. The application will automatically reload when you change any source files.

### Build for Production
```bash
npm run build
# or
ng build --configuration production
```

### Running Tests
```bash
npm test
# or
ng test
```

## Configuration Required

Before running the application, you need to configure Azure services in the environment files:

1. **Azure Entra ID** - Create an App Registration and configure redirect URIs
2. **Azure OpenAI Service** - Deploy GPT model and note endpoint/deployment name
3. **Azure AI Search** - Create search service and document index
4. **Azure Functions** - Deploy backend APIs for chat, documents, and MCP integration

Update `src/environments/environment.ts` and `src/environments/environment.prod.ts` with your Azure service configurations.
