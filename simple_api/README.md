# Simple Echo API

A simple Python API built with FastAPI that includes Swagger documentation and an echo functionality.

## Features

- **FastAPI**: Modern, fast web framework for building APIs
- **Automatic Swagger Documentation**: Interactive API docs at `/docs`
- **Echo Functionality**: Simple endpoint to echo back messages
- **Clean and Simple Code**: Easy to understand and extend
- **Azure Deployment Ready**: PowerShell script for easy deployment to Azure App Service

## Installation

1. Install the required dependencies:
```bash
pip install -r requirements.txt
```

## Running the API

1. Start the server:
```bash
python main.py
```

Or using uvicorn directly:
```bash
uvicorn main:app --reload
```

2. The API will be available at:
   - **API Base URL**: http://localhost:8000
   - **Swagger UI**: http://localhost:8000/docs
   - **ReDoc**: http://localhost:8000/redoc

## API Endpoints

### GET /
Returns a welcome message.

### POST /echo
Echo endpoint that accepts JSON payload.

**Request Body:**
```json
{
  "message": "Hello, World!"
}
```

**Response:**
```json
{
  "echo": "Hello, World!",
  "original_message": "Hello, World!"
}
```

### GET /echo/{message}
Simple GET echo endpoint that returns the message from the URL path.

**Example:** `GET /echo/hello` returns:
```json
{
  "echo": "hello",
  "original_message": "hello",
  "method": "GET"
}
```

## Testing the API

You can test the API using:
1. The interactive Swagger UI at http://localhost:8000/docs
2. curl commands
3. Any HTTP client like Postman

### Example curl commands:

```bash
# Test root endpoint
curl http://localhost:8000/

# Test POST echo
curl -X POST "http://localhost:8000/echo" \
     -H "Content-Type: application/json" \
     -d '{"message": "Hello, API!"}'

# Test GET echo
curl http://localhost:8000/echo/HelloWorld
```

## Deployment to Azure App Service

This project includes PowerShell scripts for deploying to an existing Azure App Service.

### Prerequisites

1. **Azure CLI**: Install from https://docs.microsoft.com/en-us/cli/azure/install-azure-cli
2. **Azure Login**: Run `az login` to authenticate
3. **Existing Azure App Service**: You need an existing App Service (Python runtime)

### Deployment Options

#### Option 1: Quick Deploy (Recommended)
1. Edit `quick-deploy.ps1` and update the variables:
   ```powershell
   $AppServiceName = "your-app-service-name"
   $ResourceGroupName = "your-resource-group-name"
   ```

2. Run the deployment:
   ```powershell
   .\quick-deploy.ps1
   ```

#### Option 2: Manual Deploy with Parameters
```powershell
.\deploy.ps1 -AppServiceName "your-app-service" -ResourceGroupName "your-resource-group"
```

#### Option 3: Deploy with Custom Pip Configuration
If you need to use a private Python package repository:

```powershell
.\deploy.ps1 -AppServiceName "your-app-service" -ResourceGroupName "your-resource-group" -PipIndexUrl "https://your-repo.com/simple" -PipTrustedHost "your-repo.com"
```

### Deployment Script Features

- ✅ **Excludes Virtual Environment**: Only deploys application code
- ✅ **Custom Pip Configuration**: Supports private package repositories
- ✅ **Automatic Zip Deployment**: Uses Azure's zip deployment method
- ✅ **Error Handling**: Checks prerequisites and provides clear error messages
- ✅ **Cleanup**: Automatically removes temporary files after deployment

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `AppServiceName` | Yes | Name of your Azure App Service |
| `ResourceGroupName` | Yes | Resource group containing the App Service |
| `SubscriptionId` | No | Azure subscription ID (uses current if not specified) |
| `PipIndexUrl` | No | Custom pip index URL for private repositories |
| `PipTrustedHost` | No | Trusted host for pip (used with private repositories) |

### After Deployment

Your API will be available at:
- **API Base**: `https://your-app-service.azurewebsites.net`
- **Swagger UI**: `https://your-app-service.azurewebsites.net/docs`
- **ReDoc**: `https://your-app-service.azurewebsites.net/redoc`
