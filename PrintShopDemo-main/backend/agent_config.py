"""
PixelPress AI — Agent configuration, tools & system prompt.

Uses Microsoft Agent Framework with Azure OpenAI to power the
PixelPress chat assistant.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Annotated

from agent_framework import ChatAgent, AgentThread
from agent_framework.azure import AzureOpenAIChatClient
from azure.identity import DefaultAzureCredential

# ── Cost tables from DIRECTIVE-1050 ──────────────────────────
COST_TABLE: dict[str, dict[int, float]] = {
    "posters":          {1: 45, 10: 180, 25: 375, 50: 600, 100: 1000},
    "banners":          {1: 120, 5: 500, 10: 850},
    "copies":           {100: 25, 250: 50, 500: 85, 1000: 150},
    "business-cards":   {100: 35, 250: 85, 500: 150, 1000: 250},
    "brochures":        {100: 125, 250: 275, 500: 500, 1000: 850},
    "letterhead":       {100: 65, 250: 135, 500: 225, 1000: 400},
    "large-format":     {1: 175, 5: 750, 10: 1300},
    "booklets":         {25: 200, 50: 350, 100: 600, 250: 1200},
    "graphics":         {1: 150},
    "logo-design":      {1: 500},
    "social-media":     {1: 75, 5: 300, 10: 500},
    "web-banners":      {1: 85, 5: 350, 10: 600},
    "email-templates":  {1: 200},
    "presentations":    {1: 250, 5: 1000},
    "infographics":     {1: 300},
    "video-motion":     {1: 800},
}

PRIORITY_SURCHARGE = {"standard": 0.0, "expedited": 0.25, "rush": 0.50}
CLASSIFICATION_SURCHARGE = {
    "unclassified": 0.0,
    "fouo": 0.0,
    "cui": 0.10,
    "super-classified": 0.25,
}

# ── Shared mutable list to capture tool calls during a stream ─
_pending_tool_calls: list[dict] = []


def drain_tool_calls() -> list[dict]:
    """Return and clear accumulated tool call events."""
    calls = list(_pending_tool_calls)
    _pending_tool_calls.clear()
    return calls


# ── Tools ────────────────────────────────────────────────────

def update_form_field(
    field_name: Annotated[str, "The form field to update. Valid fields: category, subType, projectTitle, description, quantity, dimensions, colorRequirements, classificationLevel, distribution, requestorName, requestorEmail, requestorPhone, department, officeSymbol, buildingLocation, roomNumber, supervisorName, supervisorEmail, fundCite, costCenter, priority, requestedDate, deliveryMethod, deliveryAddress, specialInstructions"],
    value: Annotated[str, "The value to set. Use the exact enum value for enum fields (e.g. 'print', 'digital', 'standard', 'rush', 'unclassified', 'cui', 'pickup', etc). For numbers, pass as string."],
) -> str:
    """Update a single field on the user's request form. The change will be applied in the UI automatically."""
    _pending_tool_calls.append({
        "action": "update_field",
        "field": field_name,
        "value": value,
    })
    return f"✓ Updated '{field_name}' to '{value}' on the request form."


def calculate_cost(
    product_type: Annotated[str, "Product sub-type id, e.g. 'business-cards', 'posters', 'social-media'"],
    quantity: Annotated[int, "Number of items requested"],
    priority: Annotated[str, "Priority level: standard, expedited, or rush"],
    classification: Annotated[str, "Classification level: unclassified, fouo, cui, or super-classified"],
) -> str:
    """Calculate the estimated cost for a print or digital media request based on DIRECTIVE-1050 cost tables."""
    table = COST_TABLE.get(product_type)
    if not table:
        return f"No cost data available for product type '{product_type}'. Please refer to DIRECTIVE-1050 for pricing."

    # Find the closest tier (round up to next available quantity)
    sorted_tiers = sorted(table.keys())
    base_per_unit = None
    matched_tier = None
    for tier in sorted_tiers:
        if quantity <= tier:
            base_per_unit = table[tier] / tier
            matched_tier = tier
            break
    if base_per_unit is None:
        # Above max tier — extrapolate from largest
        largest = sorted_tiers[-1]
        base_per_unit = table[largest] / largest
        matched_tier = largest

    base_cost = round(base_per_unit * quantity, 2)

    pri_rate = PRIORITY_SURCHARGE.get(priority, 0.0)
    cls_rate = CLASSIFICATION_SURCHARGE.get(classification, 0.0)
    pri_amount = round(base_cost * pri_rate, 2)
    cls_amount = round(base_cost * cls_rate, 2)
    total = round(base_cost + pri_amount + cls_amount, 2)

    lines = [
        f"**Cost Estimate** (DIRECTIVE-1050)",
        f"Product: {product_type} × {quantity}",
        f"Pricing tier: {matched_tier}-unit rate",
        f"Base cost: ${base_cost:,.2f}",
    ]
    if pri_rate:
        lines.append(f"Priority surcharge ({priority}, +{int(pri_rate*100)}%): +${pri_amount:,.2f}")
    if cls_rate:
        lines.append(f"Classification surcharge ({classification}, +{int(cls_rate*100)}%): +${cls_amount:,.2f}")
    lines.append(f"**Estimated total: ${total:,.2f}**")

    return "\n".join(lines)


def validate_request(
    form_json: Annotated[str, "The current form data as a JSON string"],
) -> str:
    """Validate the current request form against FCA directives. Returns a list of issues found or confirmation that the request looks good."""
    try:
        form = json.loads(form_json)
    except json.JSONDecodeError:
        return "Could not parse form data."

    issues: list[str] = []

    # DIRECTIVE-1000: description minimum 50 chars
    desc = form.get("description", "")
    if desc and len(desc) < 50:
        issues.append(f"Description is {len(desc)} characters — DIRECTIVE-1000 §3.1 requires at least 50 characters.")

    # DIRECTIVE-1000: fund cite format
    fund_cite = form.get("fundCite", "")
    if fund_cite and not fund_cite.startswith("FCA-"):
        issues.append(f"Fund cite '{fund_cite}' does not match the FCA-XXXX-BAx-XXXX-XXXX-XXXXXX format (DIRECTIVE-1050 §3.3).")

    # DIRECTIVE-1200: super-classified requires GS-15/SES + Security Director
    classification = form.get("classificationLevel", "")
    if classification == "super-classified":
        issues.append("Super Classified requests require Security Director approval and the requestor must be GS-15 or SES (DIRECTIVE-1200 §2.1).")

    # DIRECTIVE-1200: unclassified cannot name orgs below Directorate
    if classification == "unclassified":
        desc_lower = (desc or "").lower()
        if any(word in desc_lower for word in ["branch", "division", "section", "unit"]):
            issues.append("Unclassified materials must not identify organizational units below the Directorate level (DIRECTIVE-1200 §2.2).")

    # DIRECTIVE-1010: poster max dimensions 48×72
    sub = form.get("subType", "")
    dims = form.get("dimensions", "")
    if sub == "posters" and dims:
        # Try to parse "48x72" style
        parts = dims.lower().replace("×", "x").split("x")
        if len(parts) == 2:
            try:
                w, h = float(parts[0].strip()), float(parts[1].strip())
                if w > 48 or h > 72:
                    issues.append(f"Poster dimensions {w}×{h}\" exceed the maximum 48×72\" (DIRECTIVE-1010 §3.2). Requires GPO referral.")
            except ValueError:
                pass

    # DIRECTIVE-1020: video max 3 minutes
    if sub == "video-motion":
        issues.append("Reminder: Videos are limited to 3 minutes maximum (DIRECTIVE-1020 §3.3). Longer videos require CAO exception.")

    # DIRECTIVE-1050: rush requires supervisor approval
    priority = form.get("priority", "")
    supervisor = form.get("supervisorName", "")
    if priority == "rush" and not supervisor:
        issues.append("Rush priority requires supervisor approval — please provide Supervisor Name and Email (DIRECTIVE-1050 §4.1).")

    if not issues:
        return "✓ No policy violations detected. The request appears to comply with all applicable FCA directives."

    header = f"Found {len(issues)} potential issue(s):\n"
    return header + "\n".join(f"• {i}" for i in issues)


# ── System prompt builder ────────────────────────────────────

def _load_policies() -> str:
    """Read all policy markdown files from the policies/ directory."""
    policies_dir = Path(__file__).resolve().parent.parent / "policies"
    docs: list[str] = []
    for md_file in sorted(policies_dir.glob("*.md")):
        content = md_file.read_text(encoding="utf-8")
        docs.append(f"<!-- POLICY: {md_file.stem} -->\n{content}\n<!-- END POLICY -->")
    return "\n\n".join(docs)


def build_system_prompt(policies_text: str) -> str:
    """Construct the full system prompt including role, policies, and tool guidance."""
    return f"""\
You are **PixelPress AI**, the intelligent assistant for the Federal Consolidated Agency (FCA) \
Print & Digital Media Center. You help government employees create, validate, and submit media \
production requests while ensuring full compliance with FCA directives.

## Your Capabilities
1. **Guide users** through the request form step by step.
2. **Answer policy questions** using the directives below — always cite the specific directive \
   and section number.
3. **Update form fields** using the `update_form_field` tool when the user provides information \
   or when you can infer the correct value from context.
4. **Calculate costs** using the `calculate_cost` tool with the pricing tables from DIRECTIVE-1050.
5. **Validate requests** using the `validate_request` tool to check for policy violations before \
   submission.

## Policy References
When you reference a policy, ALWAYS include a clickable markdown link using this format:
- `[Directive XXXX §Y.Z](/policies/directive-XXXX#section-Y-Z)`
- Example: [Directive 1200 §2.1](/policies/directive-1200#section-2-1)

This links the user directly to the relevant section in the app's policy viewer.

## Communication Style
- Be professional yet approachable — this is a government workplace.
- Keep answers concise but thorough.
- When validating, be specific about which directive and section applies.
- If a request has policy issues, explain clearly what needs to change and why.
- Proactively warn about common pitfalls (e.g., rush surcharges, classification restrictions).
- When suggesting form updates, explain what you're setting and why before calling the tool.
- Always format cost breakdowns clearly.

## Tool Usage Guidelines
- **update_form_field**: Call this whenever the user tells you information that maps to a form \
  field. You can update multiple fields in sequence. Always tell the user what you're updating.
- **calculate_cost**: Use when the user asks about pricing, or proactively when enough info is \
  available (product type + quantity + priority + classification).
- **validate_request**: Use when the user asks to check their request, before submission, or \
  when you notice potential issues. Pass the full current form data as JSON.

## Validation Error Resolution Flow
When `validate_request` returns multiple issues, follow this guided workflow:
1. Show a **brief numbered summary** of all issues (one short line each, no details).
2. Then expand on **only the first issue** in detail — explain what's wrong, cite the \
   directive and section, and ask the user to provide the corrected value.
3. Once the user responds and that issue is fixed (call `update_form_field` if appropriate), \
   move on to the **next issue**: expand on it in detail and prompt the user to fix it.
4. Continue one issue at a time until all are resolved.
5. After the last issue is fixed, re-run `validate_request` to confirm everything passes, \
   and congratulate the user.
This gives the user a clear picture of the overall scope while focusing their attention on \
one fix at a time.

## Form Field Reference
The request form has these fields:
- `category`: "print" or "digital"
- `subType`: product sub-type ID (e.g., "posters", "business-cards", "social-media")
- `projectTitle`: project name/title
- `description`: detailed description (min 50 chars per DIRECTIVE-1000)
- `quantity`: number of items
- `dimensions`: size specification (e.g., "24x36")
- `colorRequirements`: color specs (e.g., "Full color", "PMS 280 + PMS 485")
- `classificationLevel`: "unclassified", "fouo", "cui", or "super-classified"
- `distribution`: intended distribution/audience
- `requestorName`, `requestorEmail`, `requestorPhone`: contact info
- `department`, `officeSymbol`, `buildingLocation`, `roomNumber`: organizational info
- `supervisorName`, `supervisorEmail`: supervisor (required for rush priority)
- `fundCite`: funding citation (format: FCA-XXXX-BAx-XXXX-XXXX-XXXXXX)
- `costCenter`: cost center code
- `priority`: "standard", "expedited", or "rush"
- `requestedDate`: desired completion date (YYYY-MM-DD)
- `deliveryMethod`: "pickup", "interoffice", "digital", or "shipping"
- `deliveryAddress`: delivery address (if shipping)
- `specialInstructions`: additional notes

─────────────────────────────────────────────
FCA DIRECTIVES & POLICIES (AUTHORITATIVE SOURCE)
─────────────────────────────────────────────

{policies_text}

─────────────────────────────────────────────
END OF POLICIES — All answers must be grounded in the directives above.
─────────────────────────────────────────────
"""


# ── Agent factory ────────────────────────────────────────────

_agent: ChatAgent | None = None
_policies_text: str | None = None


def get_policies_text() -> str:
    global _policies_text
    if _policies_text is None:
        _policies_text = _load_policies()
    return _policies_text


def create_agent() -> ChatAgent:
    """Create (or return cached) the PixelPress AI agent."""
    global _agent
    if _agent is not None:
        return _agent

    policies = get_policies_text()
    instructions = build_system_prompt(policies)

    # Determine which client to use based on environment
    api_key = os.environ.get("AZURE_OPENAI_API_KEY")
    endpoint = os.environ.get("AZURE_OPENAI_ENDPOINT")
    deployment = os.environ.get("AZURE_OPENAI_CHAT_DEPLOYMENT_NAME", "gpt-4o")

    if endpoint:
        kwargs: dict = {
            "endpoint": endpoint,
            "deployment_name": deployment,
        }
        if api_key:
            from azure.core.credentials import AzureKeyCredential
            kwargs["credential"] = AzureKeyCredential(api_key)
        else:
            kwargs["credential"] = DefaultAzureCredential()

        client = AzureOpenAIChatClient(**kwargs)
    else:
        # Fallback: let AzureOpenAIChatClient read from env vars automatically
        client = AzureOpenAIChatClient()

    _agent = ChatAgent(
        chat_client=client,
        name="PixelPressAI",
        instructions=instructions,
        tools=[update_form_field, calculate_cost, validate_request],
    )

    return _agent
