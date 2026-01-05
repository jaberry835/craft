# Azure Environment Variables Configuration Script (PowerShell)
# This script helps you set all the required environment variables for your Azure App Service
# It can read from azure-env.env file or prompt for input

param(
    [string]$AppName = "",
    [string]$ResourceGroup = "",
    [switch]$UseEnvFile = $false,
    [string]$EnvFilePath = "azure-env.env"
)

# Color functions for output
function Write-Info { param([string]$Message) Write-Host "[INFO] $Message" -ForegroundColor Blue }
function Write-Success { param([string]$Message) Write-Host "[SUCCESS] $Message" -ForegroundColor Green }
function Write-Warning { param([string]$Message) Write-Host "[WARNING] $Message" -ForegroundColor Yellow }
function Write-Error { param([string]$Message) Write-Host "[ERROR] $Message" -ForegroundColor Red }

# Function to read environment file
function Read-EnvFile {
    param([string]$FilePath)
    
    if (!(Test-Path $FilePath)) {
        Write-Error "Environment file not found: $FilePath"
        return $null
    }
    
    Write-Info "Reading environment variables from: $FilePath"
    
    $envVars = @{}
    $content = Get-Content $FilePath
    
    foreach ($line in $content) {
        # Skip comments and empty lines
        if ($line.Trim() -eq "" -or $line.Trim().StartsWith("#")) {
            continue
        }
        
        # Parse KEY=VALUE pairs
        if ($line -match "^([^=]+)=(.*)$") {
            $key = $matches[1].Trim()
            $value = $matches[2].Trim()
            
            # Remove quotes if present
            if ($value.StartsWith('"') -and $value.EndsWith('"')) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            
            $envVars[$key] = $value
        }
    }
    
    Write-Success "Loaded $($envVars.Count) environment variables from file"
    return $envVars
}

# Function to get environment variable with fallback to prompt
function Get-EnvVarOrPrompt {
    param(
        [hashtable]$EnvVars,
        [string]$Key,
        [string]$Prompt,
        [string]$DefaultValue = ""
    )
    
    if ($EnvVars -and $EnvVars.ContainsKey($Key) -and ![string]::IsNullOrEmpty($EnvVars[$Key])) {
        return $EnvVars[$Key]
    }
    else {
        return Read-InputWithDefault $Prompt $DefaultValue
    }
}
function Read-InputWithDefault {
    param(
        [string]$Prompt,
        [string]$DefaultValue = ""
    )
    
    if ($DefaultValue) {
        $userInput = Read-Host "$Prompt [$DefaultValue]"
        if ([string]::IsNullOrEmpty($userInput)) {
            return $DefaultValue
        }
        return $userInput
    }
    else {
        return Read-Host $Prompt
    }
}

# Function to set Azure app settings
function Set-AppSettings {
    param(
        [string]$AppName,
        [string]$ResourceGroup,
        [string[]]$Settings
    )
    
    Write-Info "Setting application settings..."
    
    # Execute the Azure CLI command
    az webapp config appsettings set `
        --name $AppName `
        --resource-group $ResourceGroup `
        --settings $Settings | Out-Null
    
    if ($LASTEXITCODE -eq 0) {
        Write-Success "Application settings updated successfully!"
        return $true
    }
    else {
        Write-Error "Failed to update application settings"
        return $false
    }
}

# Main configuration function
function Main {
    Write-Host "========================================================"
    Write-Host "Azure App Service Environment Variables Configuration"
    Write-Host "========================================================"
    Write-Host ""
    
    # Read environment file if specified
    $envVars = $null
    if ($UseEnvFile -or (Test-Path $EnvFilePath)) {
        if (Test-Path $EnvFilePath) {
            $response = "y"
            if (!$UseEnvFile) {
                $response = Read-Host "Found $EnvFilePath file. Do you want to use it? (Y/n)"
            }
            
            if ($response -ne "n" -and $response -ne "N") {
                $envVars = Read-EnvFile $EnvFilePath
                if ($envVars) {
                    Write-Info "Using environment file: $EnvFilePath"
                    Write-Host ""
                }
            }
        }
        elseif ($UseEnvFile) {
            Write-Warning "Environment file not found: $EnvFilePath"
            Write-Info "Falling back to interactive prompts"
            Write-Host ""
        }
    }
    
    # Get App Service details
    Write-Info "Enter your Azure App Service details:"
    if ([string]::IsNullOrEmpty($AppName)) {
        $AppName = Read-Host "App Service Name"
    }
    if ([string]::IsNullOrEmpty($ResourceGroup)) {
        $ResourceGroup = Read-Host "Resource Group Name"
    }
    
    if ([string]::IsNullOrEmpty($AppName) -or [string]::IsNullOrEmpty($ResourceGroup)) {
        Write-Error "App Service name and Resource Group are required"
        exit 1
    }
    
    # Verify app exists
    Write-Info "Verifying App Service exists..."
    $appExists = az webapp show --name $AppName --resource-group $ResourceGroup --query "name" --output tsv 2>$null
    if ([string]::IsNullOrEmpty($appExists)) {
        Write-Error "App Service '$AppName' not found in resource group '$ResourceGroup'"
        exit 1
    }
    
    Write-Success "App Service found!"
    Write-Host ""
    
    # Collect environment variables
    if ($envVars) {
        Write-Info "Using values from environment file (you can override any by entering a new value):"
    }
    else {
        Write-Info "Please provide your Azure service details:"
    }
    Write-Host ""
    
    # Azure OpenAI
    Write-Info "Azure OpenAI Configuration:"
    $openaiEndpoint = Get-EnvVarOrPrompt $envVars "AZURE_OPENAI_ENDPOINT" "OpenAI Endpoint" "https://rudeaoai-gov.openai.azure.us/"
    $openaiApiKey = Get-EnvVarOrPrompt $envVars "AZURE_OPENAI_API_KEY" "OpenAI API Key"
    $openaiDeployment = Get-EnvVarOrPrompt $envVars "AZURE_OPENAI_DEPLOYMENT" "OpenAI Deployment Name" "gpt-4o"
    $openaiEmbeddingDeployment = Get-EnvVarOrPrompt $envVars "AZURE_OPENAI_EMBEDDING_DEPLOYMENT" "OpenAI Embedding Deployment Name" "text-embedding-ada-002"
    
    Write-Host ""
    
    # Azure Cosmos DB
    Write-Info "Azure Cosmos DB Configuration:"
    $cosmosEndpoint = Get-EnvVarOrPrompt $envVars "AZURE_COSMOS_DB_ENDPOINT" "Cosmos DB Endpoint" "https://chat-db.documents.azure.us:443/"
    $cosmosKey = Get-EnvVarOrPrompt $envVars "AZURE_COSMOS_DB_KEY" "Cosmos DB Primary Key"
    $cosmosDatabase = Get-EnvVarOrPrompt $envVars "AZURE_COSMOS_DB_DATABASE" "Cosmos DB Database Name" "ChatDatabase"
    $cosmosSessionsContainer = Get-EnvVarOrPrompt $envVars "AZURE_COSMOS_DB_SESSIONS_CONTAINER" "Sessions Container Name" "Sessions"
    $cosmosMessagesContainer = Get-EnvVarOrPrompt $envVars "AZURE_COSMOS_DB_MESSAGES_CONTAINER" "Messages Container Name" "Messages"
    
    Write-Host ""
    
    # Azure Blob Storage
    Write-Info "Azure Blob Storage Configuration:"
    $storageAccountName = Get-EnvVarOrPrompt $envVars "AZURE_STORAGE_ACCOUNT_NAME" "Storage Account Name" "rudechatstore"
    $storageConnectionString = Get-EnvVarOrPrompt $envVars "AZURE_STORAGE_CONNECTION_STRING" "Storage Connection String"
    $storageContainerName = Get-EnvVarOrPrompt $envVars "AZURE_STORAGE_CONTAINER_NAME" "Storage Container Name" "documents"
    
    Write-Host ""
    
    # Azure AI Search
    Write-Info "Azure AI Search Configuration:"
    $searchEndpoint = Get-EnvVarOrPrompt $envVars "AZURE_SEARCH_ENDPOINT" "Search Service Endpoint" "https://rude-search.search.azure.us"
    $searchKey = Get-EnvVarOrPrompt $envVars "AZURE_SEARCH_KEY" "Search Admin Key"
    $searchIndexName = Get-EnvVarOrPrompt $envVars "AZURE_SEARCH_INDEX_NAME" "Search Index Name" "chat-documents"
    
    Write-Host ""
    
    # Azure Document Intelligence (optional)
    Write-Info "Azure Document Intelligence Configuration (optional):"
    $docIntelEndpoint = Get-EnvVarOrPrompt $envVars "DOCUMENT_INTELLIGENCE_ENDPOINT" "Document Intelligence Endpoint (optional)"
    $docIntelKey = Get-EnvVarOrPrompt $envVars "DOCUMENT_INTELLIGENCE_KEY" "Document Intelligence Key (optional)"
    
    Write-Host ""
    
    # Azure Data Explorer (optional)
    Write-Info "Azure Data Explorer Configuration (optional):"
    $adxClusterUrl = Get-EnvVarOrPrompt $envVars "ADX_CLUSTER_URL" "ADX Cluster URL (optional)"
    
    Write-Host ""
    
    # Confirm settings
    Write-Info "Configuration Summary:"
    Write-Host "App Service: $AppName"
    Write-Host "Resource Group: $ResourceGroup"
    Write-Host "OpenAI Endpoint: $openaiEndpoint"
    Write-Host "Cosmos DB Database: $cosmosDatabase"
    Write-Host "Storage Account: $storageAccountName"
    Write-Host "Search Service: $searchEndpoint"
    Write-Host ""
    
    $confirm = Read-Host "Apply these settings to your App Service? (y/N)"
    if ($confirm -ne "y" -and $confirm -ne "Y") {
        Write-Warning "Configuration cancelled"
        exit 0
    }
    
    # Build settings array with corrected variable names for Azure App Service
    $settings = @(
        "AZURE_OPENAI_ENDPOINT=$openaiEndpoint",
        "AZURE_OPENAI_API_KEY=$openaiApiKey",
        "AZURE_OPENAI_DEPLOYMENT=$openaiDeployment",
        "AZURE_OPENAI_EMBEDDING_DEPLOYMENT=$openaiEmbeddingDeployment",
        "AZURE_COSMOS_DB_ENDPOINT=$cosmosEndpoint",
        "AZURE_COSMOS_DB_KEY=$cosmosKey",
        "AZURE_COSMOS_DB_DATABASE=$cosmosDatabase",
        "AZURE_COSMOS_DB_SESSIONS_CONTAINER=$cosmosSessionsContainer",
        "AZURE_COSMOS_DB_MESSAGES_CONTAINER=$cosmosMessagesContainer",
        "AZURE_STORAGE_ACCOUNT_NAME=$storageAccountName",
        "AZURE_STORAGE_CONNECTION_STRING=$storageConnectionString",
        "AZURE_STORAGE_CONTAINER_NAME=$storageContainerName",
        "AZURE_SEARCH_ENDPOINT=$searchEndpoint",
        "AZURE_SEARCH_KEY=$searchKey",
        "AZURE_SEARCH_INDEX_NAME=$searchIndexName"
    )
    
    # Add optional settings if provided
    if (![string]::IsNullOrEmpty($docIntelEndpoint)) {
        $settings += "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT=$docIntelEndpoint"
    }
    
    if (![string]::IsNullOrEmpty($docIntelKey)) {
        $settings += "AZURE_DOCUMENT_INTELLIGENCE_KEY=$docIntelKey"
    }
    
    if (![string]::IsNullOrEmpty($adxClusterUrl)) {
        $settings += "ADX_CLUSTER_URL=$adxClusterUrl"
    }
    
    # Apply settings
    $success = Set-AppSettings -AppName $AppName -ResourceGroup $ResourceGroup -Settings $settings
    
    if ($success) {
        Write-Host ""
        Write-Success "Configuration completed successfully!"
        Write-Info "Your application should now be fully configured."
        Write-Info "Visit https://$AppName.azurewebsites.us to test your application."
        Write-Host ""
        Write-Warning "Don't forget to restart your app service if needed:"
        Write-Host "az webapp restart --name $AppName --resource-group $ResourceGroup"
    }
}

# Run main function
Main
