# Copilot Instructions

<!-- Use this file to provide workspace-specific custom instructions to Copilot. For more details, visit https://code.visualstudio.com/docs/copilot/copilot-customization#_use-a-githubcopilotinstructionsmd-file -->

## Project Overview
This is a Python project that generates fictional company documents using Azure OpenAI's GPT-4o endpoint. The project creates fake financial reports, board of directors information, and key personnel data in multiple languages and outputs them as PDF documents.

## Key Guidelines
- Use Azure OpenAI API key authentication for secure access
- Store API keys securely in environment variables, never hardcode them
- Implement proper error handling and retry logic for Azure OpenAI calls
- Generate content in the specified languages: Chinese, Russian, Arabic, Korean, Spanish, French
- Create professional-looking PDF documents with proper formatting
- Ensure all generated companies and personnel are clearly fictional
- Use appropriate PDF libraries for multi-language text rendering
