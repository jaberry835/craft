targetScope = 'subscription'

@minLength(2)
@maxLength(24)
param environmentName string

param location string

@description('Entra application client ID exposed by the MCP API.')
param entraServerClientId string

@description('Comma-separated SPA client IDs allowed in the azp claim.')
param entraAllowedClientIds string

@description('Comma-separated exact SPA origins allowed by application CORS.')
param corsAllowedOrigins string

@description('App Service DNS suffix for the target cloud.')
param appServiceDnsSuffix string = 'azurewebsites.net'

@description('Path to the static cloud profile in the deployed package.')
param azureCloudProfile string = 'cloud-profiles/azurecloud.json'

@description('Optional internal npm registry used by App Service build automation.')
param npmRegistry string = ''

@description('Optional existing delegated subnet resource ID for outbound VNet integration.')
param subnetResourceId string = ''

@description('Route all App Service outbound traffic through the integrated VNet.')
@allowed([
  'true'
  'false'
])
param routeAllOutbound string = 'false'

param appServiceSkuName string = 'S1'
param appServiceSkuTier string = 'Standard'

var normalizedEnvironmentName = toLower(replace(environmentName, '-', ''))
var resourceSuffix = take(uniqueString(subscription().id, environmentName, location), 6)
var resourceGroupName = 'rg-${environmentName}-${resourceSuffix}'
var tags = {
  'azd-env-name': environmentName
  workload: 'mcp-scanazure'
  'managed-by': 'azd'
}

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-11-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module resources './modules/resources.bicep' = {
  name: 'mcp-scanazure-resources'
  scope: resourceGroup
  params: {
    name: 'mcpscan-${take(normalizedEnvironmentName, 12)}'
    location: location
    tags: tags
    entraServerClientId: entraServerClientId
    entraAllowedClientIds: entraAllowedClientIds
    corsAllowedOrigins: corsAllowedOrigins
    appServiceDnsSuffix: appServiceDnsSuffix
    azureCloudProfile: azureCloudProfile
    npmRegistry: npmRegistry
    subnetResourceId: subnetResourceId
    routeAllOutbound: toLower(routeAllOutbound) == 'true'
    appServiceSkuName: appServiceSkuName
    appServiceSkuTier: appServiceSkuTier
  }
}

output AZURE_RESOURCE_GROUP string = resourceGroup.name
output AZURE_LOCATION string = location
output API_URL string = resources.outputs.apiUrl
output APP_SERVICE_NAME string = resources.outputs.appServiceName
output MANAGED_IDENTITY_CLIENT_ID string = resources.outputs.managedIdentityClientId
output MANAGED_IDENTITY_PRINCIPAL_ID string = resources.outputs.managedIdentityPrincipalId
output APPLICATIONINSIGHTS_NAME string = resources.outputs.applicationInsightsName
output AZURE_LOG_ANALYTICS_WORKSPACE_ID string = resources.outputs.logAnalyticsWorkspaceId
