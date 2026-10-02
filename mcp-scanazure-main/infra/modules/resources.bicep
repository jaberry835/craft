targetScope = 'resourceGroup'

param name string
param location string = resourceGroup().location
param tags object = {}
param entraServerClientId string
param entraAllowedClientIds string
param corsAllowedOrigins string
param appServiceDnsSuffix string
param azureCloudProfile string
param npmRegistry string
param subnetResourceId string
param routeAllOutbound bool
param appServiceSkuName string
param appServiceSkuTier string

var resourceSuffix = take(uniqueString(subscription().id, resourceGroup().id, name), 6)
var appName = take('${name}-app-${resourceSuffix}', 60)
var planName = take('${name}-plan-${resourceSuffix}', 40)
var identityName = take('${name}-id-${resourceSuffix}', 128)
var workspaceName = take('${name}-log-${resourceSuffix}', 63)
var insightsName = take('${name}-appi-${resourceSuffix}', 260)
var resourceUri = 'https://${appName}.${appServiceDnsSuffix}'
var baseAppSettings = [
  {
    name: 'AUTH_MODE'
    value: 'obo'
  }
  {
    name: 'HOST'
    value: '0.0.0.0'
  }
  {
    name: 'PORT'
    value: '3001'
  }
  {
    name: 'NODE_ENV'
    value: 'production'
  }
  {
    name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
    value: 'true'
  }
  {
    name: 'ENABLE_ORYX_BUILD'
    value: 'true'
  }
  {
    name: 'AZURE_CLOUD_PROFILE'
    value: azureCloudProfile
  }
  {
    name: 'AZURE_TENANT_ID'
    value: tenant().tenantId
  }
  {
    name: 'MANAGED_IDENTITY_CLIENT_ID'
    value: managedIdentity.properties.clientId
  }
  {
    name: 'ENTRA_SERVER_CLIENT_ID'
    value: entraServerClientId
  }
  {
    name: 'ENTRA_ALLOWED_CLIENT_IDS'
    value: entraAllowedClientIds
  }
  {
    name: 'ENTRA_RESOURCE_URI'
    value: resourceUri
  }
  {
    name: 'CORS_ALLOWED_ORIGINS'
    value: corsAllowedOrigins
  }
  {
    name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
    value: applicationInsights.properties.ConnectionString
  }
]
var appSettings = empty(npmRegistry)
  ? baseAppSettings
  : concat(baseAppSettings, [
      {
        name: 'NPM_CONFIG_REGISTRY'
        value: npmRegistry
      }
      {
        name: 'NPM_CONFIG_REPLACE_REGISTRY_HOST'
        value: 'always'
      }
    ])
var networkProperties = empty(subnetResourceId)
  ? {}
  : {
      virtualNetworkSubnetId: subnetResourceId
      outboundVnetRouting: {
        allTraffic: routeAllOutbound
      }
    }

resource managedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: identityName
  location: location
  tags: tags
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2025-02-01' = {
  name: workspaceName
  location: location
  tags: tags
  properties: {
    retentionInDays: 30
    sku: {
      name: 'PerGB2018'
    }
  }
}

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: insightsName
  location: location
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
    DisableIpMasking: false
    DisableLocalAuth: true
    IngestionMode: 'LogAnalytics'
    WorkspaceResourceId: logAnalytics.id
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource monitoringPublisher 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(applicationInsights.id, managedIdentity.id, 'monitoring-metrics-publisher')
  scope: applicationInsights
  properties: {
    principalId: managedIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '3913510d-42f4-4e42-8a64-420c390055eb'
    )
  }
}

resource appServicePlan 'Microsoft.Web/serverfarms@2024-11-01' = {
  name: planName
  location: location
  kind: 'linux'
  tags: tags
  sku: {
    name: appServiceSkuName
    tier: appServiceSkuTier
    capacity: 1
  }
  properties: {
    reserved: true
  }
}

resource webApp 'Microsoft.Web/sites@2024-11-01' = {
  name: appName
  location: location
  kind: 'app,linux'
  tags: union(tags, {
    'azd-service-name': 'mcp'
  })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentity.id}': {}
    }
  }
  properties: union({
    clientAffinityEnabled: false
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    serverFarmId: appServicePlan.id
    siteConfig: {
      alwaysOn: true
      appCommandLine: 'npm start'
      appSettings: appSettings
      ftpsState: 'Disabled'
      healthCheckPath: '/healthz'
      http20Enabled: true
      linuxFxVersion: 'NODE|24-lts'
      minTlsVersion: '1.2'
      remoteDebuggingEnabled: false
      scmIpSecurityRestrictionsUseMain: true
      vnetRouteAllEnabled: routeAllOutbound
      webSocketsEnabled: false
    }
  }, networkProperties)
}

resource webAppDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: '${webApp.name}-diagnostics'
  scope: webApp
  properties: {
    workspaceId: logAnalytics.id
    logs: [
      {
        category: 'AppServiceHTTPLogs'
        enabled: true
      }
      {
        category: 'AppServiceConsoleLogs'
        enabled: true
      }
      {
        category: 'AppServiceAppLogs'
        enabled: true
      }
      {
        category: 'AppServiceAuditLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

output apiUrl string = resourceUri
output appServiceName string = webApp.name
output managedIdentityClientId string = managedIdentity.properties.clientId
output managedIdentityPrincipalId string = managedIdentity.properties.principalId
output applicationInsightsName string = applicationInsights.name
output logAnalyticsWorkspaceId string = logAnalytics.id
