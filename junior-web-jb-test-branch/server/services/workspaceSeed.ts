export const seedFiles: Record<string, string> = {
  'package/index.md': `# Contoso Payments Security Approval Package

## Executive Summary

This package is a working draft. Use Junior Workbench to collect evidence, draft controls, and build the approval package files.

## Current Approval Status

- Owner: Unassigned
- System criticality: Medium
- Data classification: Confidential
- Review state: Draft
`,
  'package/system-overview.md': `# System Overview

## Business Purpose

Describe what the system does, who uses it, and what approval is being requested.

## Architecture

Document the Azure services, identities, data stores, and external integrations involved.
`,
  'package/security-controls.md': `# Security Controls

## Identity And Access

- Define managed identities and human access paths.
- Record least-privilege role assignments.

## Data Protection

- Identify sensitive data stores.
- Document encryption, retention, and backup expectations.
`,
  'package/approval-checklist.md': `# Approval Checklist

- [ ] Business owner identified
- [ ] Data classification confirmed
- [ ] Threat model reviewed
- [ ] Required Azure RBAC assignments listed
- [ ] Monitoring and incident response documented
`
};