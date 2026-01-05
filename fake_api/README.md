# Fictional Information API

A Python FastAPI application that provides fictional information about companies and IP addresses using Azure OpenAI GPT-4. This API is designed for testing, development, and educational purposes only.

## 🚀 Features

- **IP to Company Information**: Get fictional company details for any IP address
- **Company Device Information**: Get fictional device lists and network details for companies
- **Company Summary**: Get comprehensive fictional company profiles
- **Azure OpenAI Integration**: Uses GPT-4 for generating realistic fictional content
- **Swagger UI Documentation**: Interactive API documentation and testing interface
- **Secure Authentication**: Azure Managed Identity and Azure CLI credential support

## 📋 Prerequisites

- Python 3.8 or higher
- Azure OpenAI service with GPT-4 deployment
- Azure CLI (for local development)
- Git

## 🛠️ Installation

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd fake_api
   ```

2. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

3. **Configure environment variables**:
   ```bash
   cp .env.example .env
   ```
   
   Edit the `.env` file with your Azure OpenAI credentials:
   ```env
   AZURE_OPENAI_ENDPOINT=https://your-resource-name.openai.azure.com/
   AZURE_OPENAI_API_KEY=your-api-key-here
   AZURE_OPENAI_API_VERSION=2024-02-01
   AZURE_OPENAI_DEPLOYMENT_NAME=gpt-4o
   ```

## 🏃‍♂️ Running the Application

### Local Development

1. **Start the server**:
   ```bash
   python run.py
   ```

2. **Access the API**:
   - **API Documentation**: http://localhost:8000/docs
   - **Health Check**: http://localhost:8000/health
   - **OpenAPI Schema**: http://localhost:8000/openapi.json

### Alternative Start Method

```bash
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

## 📚 API Endpoints

### Health Check
- **GET** `/health` - API health status

### IP Information
- **GET** `/api/v1/ip-company/{ip_address}` - Get company info for IP address
- **POST** `/api/v1/ip-company` - Get company info for IP address (JSON body)

### Company Devices
- **GET** `/api/v1/company-devices/{company_name}` - Get device info for company
- **POST** `/api/v1/company-devices` - Get device info for company (JSON body)

### Company Summary
- **GET** `/api/v1/company-summary/{company_name}` - Get company summary
- **POST** `/api/v1/company-summary` - Get company summary (JSON body)

## 🔧 Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI service endpoint | Required |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI API key | Optional (uses managed identity) |
| `AZURE_OPENAI_API_VERSION` | Azure OpenAI API version | `2024-02-01` |
| `AZURE_OPENAI_DEPLOYMENT_NAME` | GPT-4 deployment name | `gpt-4o` |
| `APP_NAME` | Application name | `Fictional Information API` |
| `DEBUG` | Enable debug mode | `True` |
| `LOG_LEVEL` | Logging level | `INFO` |
| `HOST` | Server host | `0.0.0.0` |
| `PORT` | Server port | `8000` |

## 🔐 Authentication

The API supports multiple authentication methods:

1. **Managed Identity** (Recommended for Azure deployment)
2. **Azure CLI Credentials** (For local development)
3. **API Key** (Fallback option)

### Local Development Setup

1. **Login to Azure CLI**:
   ```bash
   az login
   ```

2. **Set subscription** (if needed):
   ```bash
   az account set --subscription <subscription-id>
   ```

## 📖 Usage Examples

### Get Company Info for IP Address

```bash
curl -X GET "http://localhost:8000/api/v1/ip-company/192.168.1.100"
```

### Get Company Devices

```bash
curl -X POST "http://localhost:8000/api/v1/company-devices" \
  -H "Content-Type: application/json" \
  -d '{"company_name": "TechCorp Solutions"}'
```

### Get Company Summary

```bash
curl -X GET "http://localhost:8000/api/v1/company-summary/Acme%20Industries"
```

## 🏗️ Project Structure

```
fake_api/
├── main.py                    # FastAPI application
├── config.py                  # Configuration settings
├── models.py                  # Pydantic models
├── azure_openai_service.py    # Azure OpenAI service
├── swagger_config.py          # Swagger UI configuration
├── run.py                     # Application startup script
├── requirements.txt           # Python dependencies
├── .env.example              # Environment variables template
├── .github/
│   └── copilot-instructions.md # Copilot customization
└── README.md                 # This file
```

## 🧪 Testing

The API includes comprehensive error handling and validation:

- **Input Validation**: All inputs are validated using Pydantic models
- **IP Address Validation**: IPv4 format validation
- **Error Responses**: Consistent error response format
- **Logging**: Comprehensive logging for debugging and monitoring

## 🚀 Deployment

### Azure App Service

1. **Create Azure App Service**
2. **Configure environment variables** in the Azure portal
3. **Deploy using Azure CLI**:
   ```bash
   az webapp up --name <app-name> --resource-group <resource-group>
   ```

### Azure Container Apps

1. **Build container image**
2. **Push to Azure Container Registry**
3. **Deploy to Azure Container Apps**

## 📊 Monitoring

The API includes:

- **Health check endpoint** for monitoring
- **Structured logging** with timestamps
- **Error tracking** with detailed error messages
- **Request/response logging** for debugging

## ⚠️ Important Notes

- **All information is fictional** - Do not use for real-world decision making
- **Companies are non-US only** - All generated companies are located outside the United States
- **IP addresses are fictional** - Generated IP addresses are not real network addresses
- **For development use only** - This API is intended for testing and educational purposes

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📝 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 📞 Support

For support and questions:
- Check the API documentation at `/docs`
- Review the logs for error details
- Ensure Azure OpenAI credentials are properly configured


## Notes on Deployment
az webapp deployment source config-zip --name fictionalapi --resource-group j-ai-rg --src deployment.zip
az webapp config set --name fictionalapi --resource-group  j-ai-rg --startup-file "python startup.py"

az webapp config appsettings set --name fictionalapi --resource-group j-ai-rg --settings AZURE_OPENAI_API_KEY=your-api-key AZURE_OPENAI_ENDPOINT=your-endpoint AZURE_OPENAI_API_VERSION=2023-12-01-preview AZURE_OPENAI_DEPLOYMENT_NAME=gpt-4o