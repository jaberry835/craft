# Fictional Company Document Generator

A Python application that generates fictional company documents using Azure OpenAI's GPT-4o endpoint. The application creates comprehensive business documents including financial reports, board of directors information, and key personnel data in multiple languages, outputting them as professional PDF documents.

## Features

- **AI-Powered Content Generation**: Uses Azure OpenAI GPT-4o to create realistic fictional company data in natural language format
- **Multi-Language Support**: Generates documents in Chinese, Russian, Arabic, Korean, Spanish, and French
- **Professional PDF Output**: Creates well-formatted PDF documents with tables and styling
- **Multiple Document Types**:
  - Financial Reports (revenue, profit margins, quarterly data)
  - Board of Directors Reports (CEO and board member information)
  - Key Personnel Reports (executive team and department heads)
- **Azure Security Best Practices**: Uses API key authentication for Azure OpenAI
- **Batch Generation**: Can generate multiple companies across different languages

## Prerequisites

- Python 3.8 or higher
- Azure OpenAI resource with GPT-4o model deployed
- Azure authentication (managed identity recommended for production)

## Installation

1. **Clone/Download the project** (if not already in your workspace)

2. **Install Python dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

3. **Set up environment variables**:
   
   Copy the example environment file:
   ```bash
   copy ".env copy.example" .env
   ```
   
   Edit `.env` and set your Azure OpenAI credentials:
   ```
   AZURE_OPENAI_ENDPOINT=https://your-resource-name.openai.azure.com/
   AZURE_OPENAI_API_KEY=your-api-key-here
   ```

## Authentication Setup

The application uses Azure OpenAI API key authentication.

### Getting Your API Key
1. Go to your Azure OpenAI resource in the Azure portal
2. Navigate to "Keys and Endpoint" in the left sidebar
3. Copy one of the API keys (Key 1 or Key 2)
4. Set the `AZURE_OPENAI_API_KEY` environment variable with this key

### Environment Variables
Set these in your `.env` file:
```
AZURE_OPENAI_ENDPOINT=https://your-resource-name.openai.azure.com/
AZURE_OPENAI_API_KEY=your-api-key-here
```

## Usage

### Quick Start
Run the simple example to generate one company's documents:

```bash
python example.py
```

### Full Application
Run the main application to generate multiple companies:

```bash
python document_generator.py
```

### Custom Usage
You can also import and use the classes in your own scripts:

```python
import asyncio
from dotenv import load_dotenv
import os
from document_generator import DocumentGenerator

load_dotenv()

async def my_custom_generation():
    endpoint = os.getenv("AZURE_OPENAI_ENDPOINT")
    api_key = os.getenv("AZURE_OPENAI_API_KEY")
    
    generator = DocumentGenerator(endpoint, api_key)
    
    # Generate documents for a French healthcare company
    documents = await generator.generate_company_documents(
        language="french",
        company_type="healthcare"
    )
    
    print("Generated documents:", documents)

asyncio.run(my_custom_generation())
```

## Configuration Options

### Supported Languages
- `chinese` - 中文
- `russian` - Русский
- `arabic` - العربية
- `korean` - 한국어
- `spanish` - Español
- `french` - Français

### Supported Company Types
- `technology` - Tech companies
- `finance` - Financial services
- `healthcare` - Healthcare organizations
- `manufacturing` - Manufacturing companies
- `retail` - Retail businesses

### Environment Variables
- `AZURE_OPENAI_ENDPOINT` (required) - Your Azure OpenAI endpoint URL
- `AZURE_OPENAI_API_KEY` (required) - Your Azure OpenAI API key
- `AZURE_OPENAI_API_VERSION` (optional) - API version, defaults to "2024-02-01"
- `AZURE_OPENAI_DEPLOYMENT_NAME` (optional) - Model deployment name, defaults to "gpt-4o"
- `OUTPUT_DIRECTORY` (optional) - Output directory for PDFs, defaults to "output"
- `LOG_LEVEL` (optional) - Logging level, defaults to "INFO"

## Output

The application creates three types of PDF documents for each company:

1. **Financial Report** (`financial_report_CompanyName_language.pdf`)
   - Company overview (industry, founded, headquarters, employees, revenue)
   - Financial performance data
   - Quarterly revenues and profit margins

2. **Board Report** (`board_report_CompanyName_language.pdf`)
   - CEO information
   - Board of directors with titles and backgrounds

3. **Personnel Report** (`personnel_report_CompanyName_language.pdf`)
   - Executive team members
   - Key personnel with positions and departments

All documents are saved in the `output` directory by default.

## Security Considerations

- **API Key Security**: Store your API key securely in environment variables, never in code
- **Fictional Data Only**: All generated content is clearly fictional and not based on real companies
- **Secure Communication**: All Azure API calls use HTTPS
- **Error Handling**: Comprehensive error handling and logging for debugging

## Troubleshooting

### Common Issues

1. **"AZURE_OPENAI_ENDPOINT environment variable is required"**
   - Set the environment variable with your Azure OpenAI endpoint URL

2. **"AZURE_OPENAI_API_KEY environment variable is required"**
   - Set the environment variable with your Azure OpenAI API key from the Azure portal

3. **Authentication errors**
   - Verify your API key is correct and hasn't expired
   - Check that your Azure OpenAI resource is active

3. **Model not found errors**
   - Verify your GPT-4o model is deployed in your Azure OpenAI resource
   - Check the deployment name matches your configuration

4. **PDF generation errors**
   - Ensure the output directory exists and is writable
   - Check for sufficient disk space

### Logging
The application creates detailed logs in `document_generator.log`. Check this file for debugging information.

## Development

### Project Structure
```
fake_generation/
├── document_generator.py    # Main application
├── example.py              # Simple usage example
├── requirements.txt        # Python dependencies
├── .env.example           # Environment variable template
├── output/                # Generated PDF files
├── .github/
│   └── copilot-instructions.md
└── README.md
```

### Adding New Languages
To add support for new languages:

1. Add the language code to `supported_languages` list in `DocumentGenerator`
2. Add the language instruction to `language_instructions` dict in `generate_company_data`
3. Test with a sample generation

### Adding New Document Types
To add new document types:

1. Create a new method in `PDFGenerator` class
2. Add the method call to `generate_company_documents`
3. Update the data structures if needed

## License

This project is for educational and demonstration purposes. Ensure compliance with your organization's policies when using AI-generated content.

## Contributing

1. Follow Azure SDK best practices
2. Implement proper error handling
3. Add logging for debugging
4. Test with multiple languages
5. Update documentation for new features
