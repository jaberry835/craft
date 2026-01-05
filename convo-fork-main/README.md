# Government Contract Financial Assistant

A React/TypeScript application for government contracting officers to analyze project finances, budgets, and spending patterns using Azure AI Search (RAG) and Azure OpenAI (GPT-4o).

## Features
- Split-pane UI: left for conversation, right for AI financial analysis insights
- Dynamic RAG-powered financial assistant responses
- Project-based query types: financial, WBS, personnel, timeline analysis
- Budget tracking with spending summaries and percentage calculations
- AI-driven financial analysis suggestions with detailed recommendations
- Project selection with WBS numbers
- Multi-language support for international operations
- Auto-scroll to latest messages
- Accessible controls and professional government-appropriate interface

## Prerequisites
- Node.js (v16+) and npm installed
- Azure OpenAI resource with a deployed model
- Azure Cognitive Search index populated with government contract and financial data

## Getting Started
1. Clone this repository:
   ```bash
   git clone https://github.com/your-org/government-contract-financial-assistant.git
   cd government-contract-financial-assistant
   ```
2. Copy the sample environment file and provide your Azure credentials:
   ```bash
   cp .env.sample .env
   # Edit .env and fill in your endpoint, API keys, and index name
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Run the development server:
   ```bash
   npm start
   ```
   The app will open at [http://localhost:3000](http://localhost:3000).

## Build for Production
```bash
npm run build
```
Bundle files are generated in the `build/` folder, ready for deployment.

## How It Works
1. **Project Selection**: Choose a government project from the dropdown with its associated WBS number.
2. **Query Input**: Enter your financial query about the project (e.g., "Show me the budget breakdown" or "What are the current spending patterns?").
3. **AI Analysis**: The assistant uses Azure OpenAI with RAG to provide data-driven insights based on project financial data.
4. **Financial Insights**: The right panel provides financial analysis suggestions, budget summaries, and actionable recommendations.
5. **Multi-language Support**: Switch between English, Spanish, French, and German for international operations.

## Sample Query Types
- **Financial**: "What's the current budget status?" or "Show me spending by category"
- **WBS Analysis**: "Break down costs by WBS elements" or "Which WBS items are over budget?"
- **Personnel**: "What are the personnel costs?" or "Show me staffing allocations"
- **Timeline**: "What are the upcoming financial milestones?" or "Show me the spending timeline"

## Next Steps
- Add real-time budget dashboards
- Integrate with government financial systems
- Expand analytics capabilities
- Deploy to Azure Government Cloud

## License
MIT
