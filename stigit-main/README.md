# Windows STIG Image Pipeline

This repository is a source-only starter pipeline for building hardened Windows images in an air-gapped Azure environment.

The first target is Windows 11. The same script engine is designed to support Windows Server baselines later by swapping the image source and baseline JSON.

## Design

The image is rebuilt from code:

```text
Azure base image + STIG baseline JSON + organization overlay JSON + exceptions JSON
  -> native PowerShell hardening
  -> validation gate
  -> sysprep
  -> Azure Compute Gallery image version
```

No compiled hardening tools, DISA GPO backup binaries, Registry.pol files, zips, installers, or imported executables are required in Git.

## Important DISA note

This starter does not check in DISA GPO backups. Use DISA STIG content as the authoritative reference, then represent approved control settings as text in `stig\baselines\*.json`. The pipeline applies those settings using native Windows tools such as PowerShell, `secedit.exe`, `auditpol.exe`, and built-in Windows cmdlets.

## Repository layout

```text
image-builder\              Azure Image Builder deployment wrapper and template
scripts\                    Native PowerShell apply, validate, sysprep scripts
stig\baselines\             OS baseline settings
stig\overlays\              Organization-specific overlays
stig\exceptions\            Approved exceptions
tests\                      Source-only validation tests
```

## Build flow

1. Sync this repository into the air-gapped Azure environment.
2. Ensure the runner has Azure PowerShell available.
3. Customize `image-builder\parameters.win11.json`.
4. Run:

```powershell
.\scripts\build-image.ps1 -ParameterFile .\image-builder\parameters.win11.json
```

## Updating cadence

Rebuild monthly from the latest approved base image. When DISA releases a new STIG version, update the baseline JSON, review changed controls, and rebuild a new Azure Compute Gallery image version.

The image version should include enough metadata to trace:

```text
base image version
baseline file and version
overlay file and version
exceptions file and version
build timestamp
```

## Password policy

The organization password policy lives in `stig\overlays\org-password-policy.json`. It intentionally overrides baseline values so your site-specific requirements remain explicit across DISA baseline updates.
