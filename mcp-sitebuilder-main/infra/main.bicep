targetScope = 'subscription'

@minLength(1)
param environmentName string
param location string = deployment().location
param principalId string = ''
@description('CIDR allowed to call the private REST/MCP service, for example 10.0.0.0/8.')
param apiAllowedIpCidr string

var resourceGroupName = 'rg-${environmentName}'

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
}

module application './resources.bicep' = {
  name: 'mcp-sitebuilder-resources'
  scope: resourceGroup
  params: {
    environmentName: environmentName
    location: location
    apiAllowedIpCidr: apiAllowedIpCidr
  }
}

output SERVICE_SITEBUILDER_NAME string = application.outputs.appName
output AZURE_STORAGE_ACCOUNT_NAME string = application.outputs.storageAccountName
output STATIC_WEBSITE_URL string = application.outputs.staticWebsiteUrl
output APPLICATIONINSIGHTS_CONNECTION_STRING string = application.outputs.applicationInsightsConnectionString
output SERVICE_SITEBUILDER_URI string = application.outputs.appUrl
