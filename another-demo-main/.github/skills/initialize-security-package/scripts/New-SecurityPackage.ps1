[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Position = 0)]
    [ValidateNotNullOrEmpty()]
    [string]$Destination = "security-package",

    [ValidateNotNullOrEmpty()]
    [string[]]$ControlFamilies = @("AU", "SC"),

    [string]$PackageName,

    [string]$SystemName,

    [string]$PortalBaseUrl,

    [string]$DocumentationBaseUrl,

    [switch]$Overwrite
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$templateRoot = [System.IO.Path]::GetFullPath(
    (Join-Path $PSScriptRoot "..\assets\security-package-template")
)

if (-not (Test-Path -LiteralPath $templateRoot -PathType Container)) {
    throw "Security package template was not found at '$templateRoot'."
}

$destinationPath = if ([System.IO.Path]::IsPathRooted($Destination)) {
    [System.IO.Path]::GetFullPath($Destination)
}
else {
    [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $Destination))
}

if ($destinationPath -eq $templateRoot) {
    throw "Destination cannot be the bundled template directory."
}

$normalizedFamilies = @(
    $ControlFamilies |
        ForEach-Object { $_.Trim().ToUpperInvariant() } |
        Where-Object { $_ } |
        Sort-Object -Unique
)

if ($normalizedFamilies.Count -eq 0) {
    throw "At least one control family is required."
}

foreach ($family in $normalizedFamilies) {
    if ($family -notmatch '^[A-Z][A-Z0-9-]{1,15}$') {
        throw "Invalid control family '$family'. Use 2-16 uppercase letters, numbers, or hyphens."
    }
}

$created = [System.Collections.Generic.List[string]]::new()
$updated = [System.Collections.Generic.List[string]]::new()
$preserved = [System.Collections.Generic.List[string]]::new()

if (-not (Test-Path -LiteralPath $destinationPath)) {
    if ($PSCmdlet.ShouldProcess($destinationPath, "Create package directory")) {
        New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null
        $created.Add($destinationPath)
    }
}

foreach ($item in Get-ChildItem -LiteralPath $templateRoot -Recurse -Force) {
    $relativePath = $item.FullName.Substring($templateRoot.Length).TrimStart(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $targetPath = Join-Path $destinationPath $relativePath

    if ($item.PSIsContainer) {
        if (-not (Test-Path -LiteralPath $targetPath)) {
            if ($PSCmdlet.ShouldProcess($targetPath, "Create directory")) {
                New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
                $created.Add($targetPath)
            }
        }
        continue
    }

    if ((Test-Path -LiteralPath $targetPath) -and -not $Overwrite) {
        $preserved.Add($targetPath)
        continue
    }

    if ($PSCmdlet.ShouldProcess($targetPath, "Copy template file")) {
        $targetParent = Split-Path -Parent $targetPath
        if (-not (Test-Path -LiteralPath $targetParent)) {
            New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
        }
        $alreadyExists = Test-Path -LiteralPath $targetPath
        Copy-Item -LiteralPath $item.FullName -Destination $targetPath -Force
        if ($alreadyExists) {
            $updated.Add($targetPath)
        }
        else {
            $created.Add($targetPath)
        }
    }
}

$configPath = Join-Path $destinationPath "package-config.json"
if (-not (Test-Path -LiteralPath $configPath)) {
    throw "Template initialization did not create '$configPath'."
}

$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$existingFamilies = @($config.controlFamilies | ForEach-Object { [string]$_ })
$config.controlFamilies = @($existingFamilies + $normalizedFamilies | Sort-Object -Unique)

if ($PSBoundParameters.ContainsKey("PackageName")) {
    $config.packageName = $PackageName
}
if ($PSBoundParameters.ContainsKey("SystemName")) {
    $config.systemName = $SystemName
}
if ($PSBoundParameters.ContainsKey("PortalBaseUrl")) {
    $config.portalBaseUrl = if ($PortalBaseUrl) { $PortalBaseUrl } else { $null }
}
if ($PSBoundParameters.ContainsKey("DocumentationBaseUrl")) {
    $config.documentationBaseUrl = if ($DocumentationBaseUrl) { $DocumentationBaseUrl } else { $null }
}

if ($PSCmdlet.ShouldProcess($configPath, "Update package configuration")) {
    $config | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configPath -Encoding utf8
    if (-not $created.Contains($configPath)) {
        $updated.Add($configPath)
    }
}

foreach ($family in $normalizedFamilies) {
    $familyPath = Join-Path $destinationPath (Join-Path "control-responses" $family)
    if (-not (Test-Path -LiteralPath $familyPath)) {
        if ($PSCmdlet.ShouldProcess($familyPath, "Create control family directory")) {
            New-Item -ItemType Directory -Path $familyPath -Force | Out-Null
            $created.Add($familyPath)
        }
    }

    $familyReadme = Join-Path $familyPath "README.md"
    if (-not (Test-Path -LiteralPath $familyReadme)) {
        if ($PSCmdlet.ShouldProcess($familyReadme, "Create control family README")) {
            @"
# $family Control Responses

Generated $family control responses belong in this directory. Use one Markdown file per control.
"@ | Set-Content -LiteralPath $familyReadme -Encoding utf8
            $created.Add($familyReadme)
        }
    }
    else {
        $preserved.Add($familyReadme)
    }
}

[pscustomobject]@{
    Destination = $destinationPath
    Families = $normalizedFamilies -join ", "
    Created = $created.Count
    Updated = $updated.Count
    Preserved = $preserved.Count
} | Format-List