# Apply Windows 11 STIG Hardening Directly to a VM

This guide explains how to apply this repository's Windows 11 hardening settings directly to an existing VM. It does not use Azure Image Builder, Azure Compute Gallery, or a managed identity.

> [!IMPORTANT]
> The included `stig\baselines\win11.json` is a starter baseline with a small set of example controls. Replace it with the organization's approved DISA Windows 11 STIG mapping and validate the result with approved compliance tooling before describing the VM as STIG compliant.

## What this workflow applies

The direct workflow applies settings from:

- `stig\baselines\win11.json` — baseline controls
- `stig\overlays\org-password-policy.json` — organization password and account-lockout overrides
- `stig\exceptions\win11.exceptions.json` — approved control exceptions

The organization overlay takes precedence over baseline password and account-lockout values.

The scripts can configure:

- Local password and account-lockout policy
- Registry policy
- Audit policy
- Windows services
- Windows Firewall profiles
- Microsoft Defender preferences

## Requirements

### Target VM

- Windows 11
- Windows PowerShell 5.1
- Local administrator access
- Microsoft Defender available if Defender controls are enabled
- A tested recovery method, snapshot, or backup

Run the scripts from **Windows PowerShell 5.1 as Administrator**. No downloadable PowerShell modules, Azure modules, Compute Gallery, or managed identity are required on the VM.

The scripts use Windows-provided components:

- `Microsoft.PowerShell.Management`
- `Microsoft.PowerShell.Security`
- `CimCmdlets`
- `NetSecurity`
- `Defender`
- `secedit.exe`
- `auditpol.exe`

Verify the required components in an elevated Windows PowerShell session:

```powershell
$requiredModules = @(
    'Microsoft.PowerShell.Management',
    'Microsoft.PowerShell.Security',
    'CimCmdlets',
    'NetSecurity',
    'Defender'
)

$requiredModules | ForEach-Object {
    [pscustomobject]@{
        Module    = $_
        Available = [bool](Get-Module -ListAvailable -Name $_)
    }
}

Get-Command secedit.exe, auditpol.exe, Set-MpPreference, Set-NetFirewallProfile
```

## Before hardening

1. Use a disposable test VM first.
2. Create a snapshot or confirm the VM can be restored.
3. Confirm emergency administrative access.
4. Review the baseline, overlay, and exceptions.
5. Confirm that firewall, service, and authentication changes will not remove required access.
6. Record the baseline, overlay, and exception versions being applied.

Hardening can disable services or change authentication and firewall behavior. Do not apply an unreviewed baseline directly to a production VM.

## Step 1: Copy the repository to the VM

Copy the complete repository to the target VM. This guide assumes this location:

```text
C:\Stig
```

Keep the contents of the `scripts` directory together because `apply-stig.ps1` invokes the individual policy scripts relative to its own location.

Expected files include:

```text
C:\Stig\
├── scripts\
│   ├── apply-stig.ps1
│   ├── apply-security-policy.ps1
│   ├── apply-registry-policy.ps1
│   ├── apply-audit-policy.ps1
│   ├── apply-services-policy.ps1
│   ├── apply-firewall-policy.ps1
│   ├── apply-defender-policy.ps1
│   └── validate-stig.ps1
└── stig\
    ├── baselines\win11.json
    ├── overlays\org-password-policy.json
    └── exceptions\win11.exceptions.json
```

## Step 2: Validate the source files

From an elevated Windows PowerShell session:

```powershell
Set-Location C:\Stig
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

.\tests\test-stig-controls.ps1
```

This checks the JSON structure, required control properties, duplicate control IDs, and exception structure. It does not inspect the VM or prove STIG compliance.

## Step 3: Apply the hardening settings

Run:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

C:\Stig\scripts\apply-stig.ps1 `
    -BaselinePath C:\Stig\stig\baselines\win11.json `
    -OverlayPath C:\Stig\stig\overlays\org-password-policy.json `
    -ExceptionsPath C:\Stig\stig\exceptions\win11.exceptions.json `
    -WorkDir C:\StigBuild
```

The command stops on the first terminating error. Review all console output and do not continue if application fails.

## Step 4: Validate before reboot

Run:

```powershell
C:\Stig\scripts\validate-stig.ps1 `
    -BaselinePath C:\Stig\stig\baselines\win11.json `
    -OverlayPath C:\Stig\stig\overlays\org-password-policy.json `
    -ExceptionsPath C:\Stig\stig\exceptions\win11.exceptions.json `
    -ReportPath C:\StigBuild\stig-validation-report-pre-reboot.json
```

A checked control failure causes the validation script to return an error. Preserve the generated JSON report as build evidence.

## Step 5: Reboot and validate again

Some Windows policy settings require a restart:

```powershell
Restart-Computer -Force
```

After reconnecting, open Windows PowerShell as Administrator and run:

```powershell
C:\Stig\scripts\validate-stig.ps1 `
    -BaselinePath C:\Stig\stig\baselines\win11.json `
    -OverlayPath C:\Stig\stig\overlays\org-password-policy.json `
    -ExceptionsPath C:\Stig\stig\exceptions\win11.exceptions.json `
    -ReportPath C:\StigBuild\stig-validation-report-post-reboot.json
```

Review the report summary:

```powershell
$report = Get-Content C:\StigBuild\stig-validation-report-post-reboot.json -Raw |
    ConvertFrom-Json

$report.summary
$report.results | Format-Table id, type, status, expected, actual -AutoSize
```

## Optional: Run remotely with Azure VM Run Command

Azure VM Run Command can start the local hardening process through the Azure VM Agent. The target VM does not need a managed identity. The repository must already be present at `C:\Stig`.

Run this from a management workstation with `Az.Accounts` and `Az.Compute` installed:

```powershell
Connect-AzAccount
Set-AzContext -Subscription '<subscription-name-or-id>'

$script = @'
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

& 'C:\Stig\scripts\apply-stig.ps1' `
    -BaselinePath 'C:\Stig\stig\baselines\win11.json' `
    -OverlayPath 'C:\Stig\stig\overlays\org-password-policy.json' `
    -ExceptionsPath 'C:\Stig\stig\exceptions\win11.exceptions.json' `
    -WorkDir 'C:\StigBuild'

& 'C:\Stig\scripts\validate-stig.ps1' `
    -BaselinePath 'C:\Stig\stig\baselines\win11.json' `
    -OverlayPath 'C:\Stig\stig\overlays\org-password-policy.json' `
    -ExceptionsPath 'C:\Stig\stig\exceptions\win11.exceptions.json' `
    -ReportPath 'C:\StigBuild\stig-validation-report-pre-reboot.json'
'@

Invoke-AzVMRunCommand `
    -ResourceGroupName '<resource-group>' `
    -VMName '<vm-name>' `
    -CommandId 'RunPowerShellScript' `
    -ScriptString $script
```

Run Command executes through the VM Agent as `LocalSystem`. Use least-privilege Azure RBAC for the operator invoking it.

## Password-policy behavior

The password and account-lockout settings are local security policy. If the VM is domain joined or managed by Intune, centrally assigned policies can override these settings.

- Domain password policy governs domain accounts.
- Local password policy primarily governs local accounts.
- Group Policy or Intune can cause the VM to drift after validation.
- Validate again after domain join and after policy refresh.

## Validation limitations

The built-in validator currently checks registry, service state, firewall, and local password-policy values. Some control types, including audit-policy and Defender controls, are currently reported as `NotChecked`. Service validation also does not fully enforce startup type.

For production approval:

1. Run the organization's approved DISA SCAP/STIG assessment tool.
2. Compare findings with approved exceptions.
3. Preserve validation evidence.
4. Remediate unexplained findings.
5. Promote the VM only after security review and approval.

## Troubleshooting

### Scripts are blocked

Use process-scoped bypass rather than changing the machine-wide execution policy:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
```

### Access is lost after hardening

Restore the snapshot or use the approved emergency access method. Review firewall, service, and authentication controls before trying again.

### Password policy does not remain applied

Check for domain Group Policy or Intune policy overriding the local policy:

```powershell
gpresult.exe /h C:\StigBuild\gpresult.html
```

### Defender commands are unavailable

Confirm Microsoft Defender is installed and not replaced or disabled by another endpoint-protection product:

```powershell
Get-Command Set-MpPreference
Get-MpComputerStatus
```

### Validation reports `NotChecked`

This means the validator does not yet implement verification for that control type. It does not mean that the setting passed or failed. Verify it with approved compliance tooling.
