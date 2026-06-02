# Future Governance And Marking Requirements

## Purpose

This document captures a future-looking governance layer for Junior Workbench.

The goal is not only to tag documents with metadata. The goal is to make the system aware of markings, classification inheritance, policy constraints, audit expectations, and other governance controls that should shape how information is retrieved, combined, displayed, exported, and published.

## Product Context

Junior Workbench is moving toward a document-first agent workflow with:

- workspace-backed files and package documents
- external sources through MCP and Azure AI Search
- staged changes and publish flows
- future identity, catalog, and packaging features

The future governance gap is that information can come from multiple sources with different markings or handling requirements. Once those sources are combined, summarized, or packaged together, the system needs a policy-aware way to determine the resulting marking and govern what actions are allowed.

## Goals

The governance layer should eventually make the system able to:

1. Associate markings and governance metadata with documents, snippets, sources, and generated outputs.
2. Apply inheritance rules when content from multiple sources is combined.
3. Default combined content to the highest applicable marking.
4. Enforce handling rules around preview, retrieval, editing, export, sharing, and publish.
5. Preserve auditability for how governed content was used in agent or user workflows.

## Non-Goals

The following are out of scope for the first governance design pass unless needed for the core model:

- implementing a full enterprise records-management suite
- replacing source-system governance tools already in use elsewhere
- guaranteeing automated classification accuracy for all unstructured content
- building every compliance framework into the first version
- finalizing all organization-specific marking taxonomies up front

## Current State Summary

Current implementation strengths:

- the workspace already has document-centric flows where governance metadata can later attach cleanly
- package workflows already reference data classification as part of seeded content and package expectations
- pending changes, identity work, source provenance work, and publish-readiness checks all provide natural governance seams

Current limitations:

- there is no first-class marking model on workspace files, snippets, agent outputs, or pending changes
- there is no inheritance rule for combining content from multiple sources
- there is no policy engine for allowed actions by marking
- there is no governance-aware audit trail for retrieval, generation, export, or publish
- external sources such as MCP and Azure AI Search do not yet map source governance into the workbench model

## Requirements

### 1. Common Marking And Governance Metadata Model

#### Why it matters

Governance will fail if every subsystem invents its own metadata shape.

#### Requirements

Define a common governance metadata model that can attach to at least:

- workspace files
- linked source documents
- Azure AI Search grounding results
- MCP-returned source records
- agent responses and generated drafts
- pending changes
- published package outputs

The model should support fields such as:

- marking or classification level
- dissemination controls
- caveats or handling instructions
- source system
- source authority or source-of-truth flag
- retention or review metadata
- policy tags
- confidence or derivation metadata when markings are inferred rather than authoritative

The model should distinguish between:

- authoritative source markings coming from the original system
- inherited markings calculated by the workbench
- manually assigned or overridden markings by authorized users

#### Acceptance criteria

- One common governance metadata shape is documented for use across files, sources, and outputs.
- The model distinguishes authoritative, inherited, and manually assigned markings.
- The model is flexible enough for environment-specific taxonomies.

### 2. Highest-Marking Inheritance Rule For Combined Content

#### Why it matters

This is the core behavior you called out: when combining marked information, the result should carry the highest applicable marking.

#### Requirements

Define a composition rule such that:

- when multiple sources are combined into one draft, summary, package section, or answer, the result inherits the highest applicable marking
- the system records which sources contributed to the inherited marking
- derived outputs cannot silently downgrade the marking of their source material
- mixed-source content remains governed even if the output text itself does not explicitly repeat the original markings

The design should support at least:

- file-level combination
- snippet-level combination
- agent answer composition from multiple grounding sources
- pending-change and publish-package marking calculation

The inheritance model should also define how to handle:

- equal markings from multiple sources
- conflicting caveats or dissemination controls
- missing markings on some sources
- manually approved overrides by authorized governance admins

#### Acceptance criteria

- The governance spec explicitly states that combined outputs inherit the highest applicable marking.
- Inherited markings can be traced back to the contributing sources.
- The system does not silently downgrade combined content.

### 3. Governance-Aware Action Controls

#### Why it matters

Marking metadata only matters if it influences what the product allows users and agents to do.

#### Requirements

Define policy-controlled behavior for actions such as:

- previewing a document
- opening original linked sources
- retrieving snippets into agent context
- editing governed content
- copying content out of the app
- exporting template packages or work products
- publishing or approving outputs
- attaching external sources to a workspace

The policy model should allow rules such as:

- some markings may be previewable but not exportable
- some markings may require explicit approval before publish
- some markings may prevent mixing with lower-trust destinations
- some outputs may require banner text or marking headers in the UI and exports

#### Acceptance criteria

- Governance rules affect allowed actions, not only metadata display.
- The model can describe different controls for preview, retrieval, export, and publish.
- Governance behavior can be enforced separately from pure identity or ownership checks.

### 4. Source Mapping For Governance Metadata

#### Why it matters

Governance will be incomplete if external systems provide markings that are dropped when content enters the workbench.

#### Requirements

Define how governance metadata maps from external sources such as:

- workspace files seeded locally
- linked repositories
- Azure AI Search indexed content
- MCP-returned records or documents
- future document-management or records systems

For each integration type, document whether the marking is:

- authoritative from source
- derived during ingestion
- manually supplied during import or linking
- unavailable and therefore treated as unknown or restricted

The workbench should preserve source governance metadata when possible and mark uncertain cases explicitly.

#### Acceptance criteria

- External source governance mapping is part of the design.
- Unknown or unmapped source markings are surfaced clearly.
- Source-provided markings are not discarded during retrieval or preview flows.

### 5. Governance In Agent Retrieval And Generation

#### Why it matters

The agent loop will often be the first place where governed information is combined. Governance rules need to apply there, not only at publish time.

#### Requirements

The future agent design should support:

- filtering retrieval by marking and policy where required
- tagging grounded snippets with governance metadata
- calculating inherited output marking for generated answers or drafts
- warning when the agent is combining content with incompatible handling constraints
- carrying resulting marking metadata into pending changes and review flows

The planner and response model should be able to surface:

- why an output received a given marking
- which sources drove the highest marking
- whether a requested action is blocked by governance policy

#### Acceptance criteria

- Governance is applied during retrieval and generation, not only after content is produced.
- Agent outputs can explain inherited marking decisions.
- Pending changes can carry resulting governance metadata.

### 6. Review, Approval, And Publish Governance

#### Why it matters

Review and publish are the highest-risk moments for governed content. The product should make those constraints obvious.

#### Requirements

Define governance-aware review and publish behavior such that:

- pending changes display resulting marking or policy banners
- reviewers can see contributing source markings when needed
- publish readiness includes governance checks in addition to document completeness
- exported or published outputs include required markings, labels, or handling caveats
- some publish paths may require elevated approval depending on marking level

The publish model should support future rules such as:

- preventing export to lower-trust destinations
- requiring explicit acknowledgment for high-marking packages
- blocking publish when required source markings are missing or unresolved

#### Acceptance criteria

- Governance considerations are part of review and publish readiness.
- Published outputs can include required marking labels or controls.
- High-marking outputs can require stricter approval behavior.

### 7. Governance Audit And Lineage

#### Why it matters

Governed systems need to explain how sensitive outputs were produced and who handled them.

#### Requirements

Define an audit and lineage model that can eventually record:

- who viewed governed content
- who staged, approved, exported, or published governed outputs
- which sources were retrieved into agent context
- which markings were inherited into resulting outputs
- when manual overrides or downgrades were attempted or approved

The design should prioritize event types such as:

- retrieval events
- preview events
- edit and approval events
- export events
- publish events
- governance override events

#### Acceptance criteria

- Governance lineage and audit requirements are explicitly documented.
- The design links inherited markings to source usage history.
- Future overrides or exceptions are auditable.

### 8. Governance Suggestions For Future Build-Outs

#### Why it matters

You asked for broader governance suggestions beyond classification inheritance. The design should leave room for them now instead of bolting them on later.

#### Requirements

Include future governance extension points such as:

- retention and disposition policies
- legal hold or preservation flags
- export control or dissemination restrictions
- need-to-know or compartment-style access tags
- data residency constraints
- source trust levels and confidence scoring
- mandatory banners, watermarks, or footer markings
- policy-driven redaction or masking
- restricted use of agent tools on highly governed content
- prohibition on sending certain content to specific models or external services
- environment-specific governance rule packs

The governance layer should remain policy-driven so different environments can apply different control sets without rewriting the entire application model.

#### Acceptance criteria

- The requirements doc includes a concrete list of future governance extensions.
- The design remains environment-aware and policy-driven.
- Governance can evolve beyond simple classification labels.

### 9. Environment-Specific Governance Profiles

#### Why it matters

Different deployments will likely use different marking taxonomies, handling rules, and approval structures.

#### Requirements

Define support for environment-specific governance profiles that can specify:

- local marking taxonomy
- ordering or precedence rules for highest-marking calculation
- handling caveats and dissemination controls
- action restrictions by marking
- required approval levels
- required labeling or export behaviors

This profile-driven approach should allow the same product to run in different environments without hard-coding a single governance scheme.

#### Acceptance criteria

- Governance rules can vary by environment.
- Highest-marking calculation is profile-driven rather than globally hard-coded.
- The model supports multiple marking taxonomies.

### 10. Validation And Test Coverage

#### Why it matters

Governance features are easy to get wrong and difficult to trust without explicit validation.

#### Requirements

Future validation should cover:

- highest-marking inheritance across mixed-source inputs
- policy enforcement for preview, retrieval, export, and publish
- source metadata mapping from MCP, Azure AI Search, and workspace files
- audit event generation for governed actions
- environment-specific profile behavior
- blocking or warning flows for unresolved or conflicting markings

#### Acceptance criteria

- Governance behavior is described in ways that are executable and testable later.
- Highest-marking inheritance and action-policy rules are validation targets, not just prose.
- Environment-specific governance profiles can be tested independently.

## Recommended Implementation Order

Recommended future sequence for this work:

1. Define the common governance metadata model.
2. Define highest-marking inheritance and profile-driven precedence rules.
3. Add governance metadata to source, retrieval, and pending-change contracts.
4. Add action-policy rules for preview, export, and publish.
5. Add review, publish, and audit lineage behavior.
6. Expand into retention, dissemination, redaction, and other advanced governance controls.

## Risks And Open Questions

- Some environments may require strict, organization-specific marking taxonomies that cannot be generalized without a profile model.
- External systems may provide incomplete or conflicting governance metadata.
- Automatically inferred markings may be useful but should not be treated as authoritative without explicit policy.
- Governance rules may eventually intersect with model-routing decisions, especially where some content cannot be sent to particular services.
- Overly rigid governance enforcement could make authoring and review unusable unless the UX clearly explains why actions are blocked.

## Definition Of Done

This future work is well-defined when:

- a common marking and governance metadata model is documented
- combined outputs are defined to inherit the highest applicable marking
- governance rules influence preview, retrieval, export, review, and publish behavior
- source governance can map in from workspace, MCP, and Azure AI Search inputs
- audit and lineage requirements are defined for governed content handling
- future governance extensions are documented in a policy-driven, environment-aware way