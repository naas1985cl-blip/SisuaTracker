// =============================================================================
// Project Tracking Dashboard — Infrastructure as Code
// One resource group provisions everything: PostgreSQL, Storage, App Insights,
// Key Vault, Function App, and Static Web App. Managed Identity wiring
// throughout — no secrets land in outputs.
//
// Deploy:
//   az group create -n rg-project-tracker -l eastus
//   az deployment group create -g rg-project-tracker \
//     -f infra/main.bicep -p @infra/main.parameters.json
// =============================================================================

targetScope = 'resourceGroup'

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

@description('Azure region for all resources.')
param location string = 'eastus'

@description('Short prefix used to name resources (lowercase letters/numbers).')
@minLength(3)
@maxLength(11)
param namePrefix string = 'projtrack'

@description('PostgreSQL administrator login name.')
param dbAdminLogin string = 'pgadmin'

@description('PostgreSQL administrator password.')
@secure()
param dbAdminPassword string

@description('GitHub repository URL for the Static Web App (e.g. https://github.com/org/repo).')
param repositoryUrl string = ''

@description('GitHub branch the Static Web App deploys from.')
param repositoryBranch string = 'main'

// A short deterministic suffix keeps globally-unique names (storage, KV,
// function app) from colliding while remaining stable across redeploys.
var suffix = take(uniqueString(resourceGroup().id), 6)
var pgServerName = '${namePrefix}-pg-${suffix}'
var databaseName = 'projecttracker'
var storageName = toLower('${namePrefix}st${suffix}')
var lawName = '${namePrefix}-law-${suffix}'
var appiName = '${namePrefix}-appi-${suffix}'
var kvName = take('${namePrefix}kv${suffix}', 24)
var planName = '${namePrefix}-plan-${suffix}'
var funcName = '${namePrefix}-func-${suffix}'
var swaName = '${namePrefix}-swa-${suffix}'

// Built-in role definition ID: "Key Vault Secrets User"
var kvSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

// ---------------------------------------------------------------------------
// 1. PostgreSQL Flexible Server (Burstable B1ms, PG 16)
// ---------------------------------------------------------------------------

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = {
  name: pgServerName
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16' // PG 16 deliberately — 17 has cron/known-issues for us
    administratorLogin: dbAdminLogin
    administratorLoginPassword: dbAdminPassword
    storage: {
      storageSizeGB: 32
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled' // cost
    }
    highAvailability: {
      mode: 'Disabled'
    }
  }

  resource database 'databases' = {
    name: databaseName
  }

  // Allow Azure services (the Function App) to reach the server. The special
  // 0.0.0.0/0.0.0.0 range means "Azure internal services only".
  resource allowAzure 'firewallRules' = {
    name: 'AllowAllAzureIps'
    properties: {
      startIpAddress: '0.0.0.0'
      endIpAddress: '0.0.0.0'
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Storage Account (required by the Function App runtime)
// ---------------------------------------------------------------------------

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
  }
}

// ---------------------------------------------------------------------------
// 3. Log Analytics workspace + Application Insights
// ---------------------------------------------------------------------------

resource law 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: lawName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appiName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: law.id
  }
}

// ---------------------------------------------------------------------------
// 4. Key Vault (Standard, RBAC authorization)
// Holds: pipedrive-token, clickup-token, clickup-team-id, db-connection-string
// ---------------------------------------------------------------------------

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true // no access policies — pure RBAC
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
  }
}

// ---------------------------------------------------------------------------
// 5. Function App (Linux, Node 20, Consumption / Y1 plan)
// ---------------------------------------------------------------------------

resource hostingPlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: planName
  location: location
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  kind: 'linux'
  properties: {
    reserved: true // required for Linux
  }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: funcName
  location: location
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned' // Managed Identity for Key Vault access
  }
  properties: {
    serverFarmId: hostingPlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|20'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      cors: {
        // Locked to the SWA origin once known. SWA hostname is added post-deploy
        // (it isn't resolvable until the SWA is created); '*' kept off in prod.
        allowedOrigins: [
          'https://${swa.properties.defaultHostname}'
        ]
      }
      appSettings: [
        {
          name: 'AzureWebJobsStorage'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};EndpointSuffix=${environment().suffixes.storage};AccountKey=${storage.listKeys().keys[0].value}'
        }
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'FUNCTIONS_WORKER_RUNTIME'
          value: 'node'
        }
        {
          name: 'WEBSITE_NODE_DEFAULT_VERSION'
          value: '~20'
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: appInsights.properties.ConnectionString
        }
        {
          name: 'KEY_VAULT_URI'
          value: keyVault.properties.vaultUri
        }
      ]
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Static Web App (Standard tier — gives us Entra ID auth)
// ---------------------------------------------------------------------------

resource swa 'Microsoft.Web/staticSites@2023-12-01' = {
  name: swaName
  location: location
  sku: {
    name: 'Standard'
    tier: 'Standard'
  }
  properties: {
    // If repositoryUrl is supplied, SWA wires up GitHub Actions automatically.
    // Otherwise we deploy via the build-output deploy token (CI workflow).
    repositoryUrl: empty(repositoryUrl) ? null : repositoryUrl
    branch: empty(repositoryUrl) ? null : repositoryBranch
    buildProperties: {
      appLocation: 'web'
      apiLocation: '' // standalone Function App, not SWA-managed API
      outputLocation: 'dist'
    }
  }
}

// ---------------------------------------------------------------------------
// 7. Role assignment — Function App identity → Key Vault Secrets User
// ---------------------------------------------------------------------------

resource kvRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, functionApp.id, kvSecretsUserRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUserRoleId)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------------------------------------------------------------------------
// Outputs (no secrets)
// ---------------------------------------------------------------------------

output functionAppName string = functionApp.name
output functionAppHostname string = functionApp.properties.defaultHostName
output staticWebAppName string = swa.name
output staticWebAppHostname string = swa.properties.defaultHostname
output keyVaultUri string = keyVault.properties.vaultUri
output postgresFqdn string = postgres.properties.fullyQualifiedDomainName
output postgresServerName string = postgres.name
output databaseName string = databaseName
