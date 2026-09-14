[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [pscustomobject]$Settings,

    [Parameter(Mandatory)]
    [string]$BaselinePath,

    [Parameter(Mandatory)]
    [string]$OverlayPath,

    [Parameter(Mandatory)]
    [string]$ExceptionsPath,

    [Parameter(Mandatory)]
    [string]$TemplateFile,

    [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Ensure-ResourceGroup {
    param([string]$Name, [string]$Location)
    $group = Get-AzResourceGroup -Name $Name -ErrorAction SilentlyContinue
    if (-not $group) {
        $group = New-AzResourceGroup -Name $Name -Location $Location
    }
    return $group
}

function Ensure-StorageAccount {
    param([pscustomobject]$Settings)
    $account = Get-AzStorageAccount -ResourceGroupName $Settings.resourceGroupName -Name $Settings.stagingStorageAccountName -ErrorAction SilentlyContinue
    if (-not $account) {
        $account = New-AzStorageAccount `
            -ResourceGroupName $Settings.resourceGroupName `
            -Name $Settings.stagingStorageAccountName `
            -Location $Settings.location `
            -SkuName Standard_LRS `
            -Kind StorageV2 `
            -AllowBlobPublicAccess $false
    }

    $container = Get-AzStorageContainer -Name $Settings.stagingContainerName -Context $account.Context -ErrorAction SilentlyContinue
    if (-not $container) {
        New-AzStorageContainer -Name $Settings.stagingContainerName -Context $account.Context -Permission Off | Out-Null
    }

    return $account
}

function Publish-StagingFile {
    param(
        [Microsoft.Azure.Commands.Management.Storage.Models.PSStorageAccount]$StorageAccount,
        [string]$ContainerName,
        [string]$LocalPath,
        [string]$BlobName
    )

    Set-AzStorageBlobContent `
        -File $LocalPath `
        -Container $ContainerName `
        -Blob $BlobName `
        -Context $StorageAccount.Context `
        -Force | Out-Null

    $expiry = (Get-Date).ToUniversalTime().AddHours(12)
    $sas = New-AzStorageBlobSASToken `
        -Container $ContainerName `
        -Blob $BlobName `
        -Permission r `
        -ExpiryTime $expiry `
        -Context $StorageAccount.Context

    return "https://$($StorageAccount.StorageAccountName).blob.core.windows.net/$ContainerName/$BlobName$sas"
}

function Ensure-RoleAssignment {
    param(
        [string]$ObjectId,
        [string]$RoleDefinitionName,
        [string]$Scope
    )

    $assignment = Get-AzRoleAssignment -ObjectId $ObjectId -RoleDefinitionName $RoleDefinitionName -Scope $Scope -ErrorAction SilentlyContinue
    if (-not $assignment) {
        New-AzRoleAssignment -ObjectId $ObjectId -RoleDefinitionName $RoleDefinitionName -Scope $Scope | Out-Null
    }
}

function New-BootstrapScript {
    param(
        [string]$OutputPath,
        [hashtable]$ScriptUris,
        [string]$BaselineUri,
        [string]$OverlayUri,
        [string]$ExceptionsUri
    )

    $downloadLines = foreach ($entry in $ScriptUris.GetEnumerator()) {
        "Invoke-WebRequest -Uri '$($entry.Value)' -OutFile (Join-Path `$workDir '$($entry.Key)')"
    }

    @"
`$ErrorActionPreference = 'Stop'
`$workDir = 'C:\StigBuild'
New-Item -Path `$workDir -ItemType Directory -Force | Out-Null

$($downloadLines -join "`r`n")
Invoke-WebRequest -Uri '$BaselineUri' -OutFile (Join-Path `$workDir 'baseline.json')
Invoke-WebRequest -Uri '$OverlayUri' -OutFile (Join-Path `$workDir 'overlay.json')
Invoke-WebRequest -Uri '$ExceptionsUri' -OutFile (Join-Path `$workDir 'exceptions.json')

& (Join-Path `$workDir 'apply-stig.ps1') `
    -BaselinePath (Join-Path `$workDir 'baseline.json') `
    -OverlayPath (Join-Path `$workDir 'overlay.json') `
    -ExceptionsPath (Join-Path `$workDir 'exceptions.json') `
    -WorkDir `$workDir
"@ | Set-Content -LiteralPath $OutputPath -Encoding UTF8
}

Ensure-ResourceGroup -Name $Settings.resourceGroupName -Location $Settings.location | Out-Null
$storageAccount = Ensure-StorageAccount -Settings $Settings

$repoRoot = Split-Path -Parent $PSScriptRoot
$stagingDir = Join-Path $repoRoot 'staging'
New-Item -Path $stagingDir -ItemType Directory -Force | Out-Null

$scriptNames = @(
    'apply-stig.ps1',
    'apply-security-policy.ps1',
    'apply-registry-policy.ps1',
    'apply-audit-policy.ps1',
    'apply-services-policy.ps1',
    'apply-firewall-policy.ps1',
    'apply-defender-policy.ps1'
)

$scriptUris = @{}
foreach ($scriptName in $scriptNames) {
    $scriptUris[$scriptName] = Publish-StagingFile -StorageAccount $storageAccount -ContainerName $Settings.stagingContainerName -LocalPath (Join-Path $PSScriptRoot $scriptName) -BlobName $scriptName
}

$baselineUri = Publish-StagingFile -StorageAccount $storageAccount -ContainerName $Settings.stagingContainerName -LocalPath $BaselinePath -BlobName 'baseline.json'
$overlayUri = Publish-StagingFile -StorageAccount $storageAccount -ContainerName $Settings.stagingContainerName -LocalPath $OverlayPath -BlobName 'overlay.json'
$exceptionsUri = Publish-StagingFile -StorageAccount $storageAccount -ContainerName $Settings.stagingContainerName -LocalPath $ExceptionsPath -BlobName 'exceptions.json'

$bootstrapApply = Join-Path $stagingDir 'bootstrap-apply-stig.ps1'
New-BootstrapScript -OutputPath $bootstrapApply -ScriptUris $scriptUris -BaselineUri $baselineUri -OverlayUri $overlayUri -ExceptionsUri $exceptionsUri

$applyScriptUri = Publish-StagingFile -StorageAccount $storageAccount -ContainerName $Settings.stagingContainerName -LocalPath $bootstrapApply -BlobName 'bootstrap-apply-stig.ps1'
$validateScriptUri = Publish-StagingFile -StorageAccount $storageAccount -ContainerName $Settings.stagingContainerName -LocalPath (Join-Path $PSScriptRoot 'validate-stig.ps1') -BlobName 'validate-stig.ps1'
$sysprepScriptUri = Publish-StagingFile -StorageAccount $storageAccount -ContainerName $Settings.stagingContainerName -LocalPath (Join-Path $PSScriptRoot 'sysprep.ps1') -BlobName 'sysprep.ps1'

$identity = Get-AzUserAssignedIdentity -ResourceGroupName $Settings.resourceGroupName -Name $Settings.managedIdentityName -ErrorAction SilentlyContinue
if (-not $identity) {
    $identity = New-AzUserAssignedIdentity -ResourceGroupName $Settings.resourceGroupName -Name $Settings.managedIdentityName -Location $Settings.location
}

$resourceGroup = Get-AzResourceGroup -Name $Settings.resourceGroupName
Ensure-RoleAssignment -ObjectId $identity.PrincipalId -RoleDefinitionName 'Contributor' -Scope $resourceGroup.ResourceId
Ensure-RoleAssignment -ObjectId $identity.PrincipalId -RoleDefinitionName 'Storage Blob Data Reader' -Scope $storageAccount.Id

$gallery = Get-AzGallery -ResourceGroupName $Settings.resourceGroupName -Name $Settings.galleryName -ErrorAction SilentlyContinue
if (-not $gallery) {
    $gallery = New-AzGallery -ResourceGroupName $Settings.resourceGroupName -Name $Settings.galleryName -Location $Settings.location
}

$definition = Get-AzGalleryImageDefinition -ResourceGroupName $Settings.resourceGroupName -GalleryName $Settings.galleryName -Name $Settings.galleryImageDefinitionName -ErrorAction SilentlyContinue
if (-not $definition) {
    $definition = New-AzGalleryImageDefinition `
        -ResourceGroupName $Settings.resourceGroupName `
        -GalleryName $Settings.galleryName `
        -Name $Settings.galleryImageDefinitionName `
        -Location $Settings.location `
        -Publisher 'internal' `
        -Offer 'windows-stig' `
        -Sku 'win11' `
        -OsState generalized `
        -OsType Windows `
        -HyperVGeneration V2
}

$templateParameters = @{
    imageTemplateName = $Settings.imageTemplateName
    location = $Settings.location
    userAssignedIdentityId = $identity.Id
    vmSize = $Settings.vmSize
    sourcePublisher = $Settings.source.publisher
    sourceOffer = $Settings.source.offer
    sourceSku = $Settings.source.sku
    sourceVersion = $Settings.source.version
    applyScriptUri = $applyScriptUri
    validateScriptUri = $validateScriptUri
    sysprepScriptUri = $sysprepScriptUri
    galleryImageId = $definition.Id
    requestedImageVersion = $Settings.galleryImageVersion
    galleryRunOutputName = "win11-stig-$($Settings.galleryImageVersion)"
}

New-AzResourceGroupDeployment `
    -ResourceGroupName $Settings.resourceGroupName `
    -TemplateFile $TemplateFile `
    -TemplateParameterObject $templateParameters `
    -Name "deploy-$($Settings.imageTemplateName)-$(Get-Date -Format yyyyMMddHHmmss)" | Out-Null

if (-not $SkipBuild) {
    Invoke-AzResourceAction `
        -ResourceGroupName $Settings.resourceGroupName `
        -ResourceType 'Microsoft.VirtualMachineImages/imageTemplates' `
        -ResourceName $Settings.imageTemplateName `
        -Action Run `
        -ApiVersion '2022-07-01' `
        -Force | Out-Null
}
