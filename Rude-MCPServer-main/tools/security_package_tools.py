"""
Security Package Web Page Tools for Rude MCP Server

Provides MCP tools for building and deploying "Security Package" web pages
to an Azure Storage Account static website ($web container).

Files are uploaded directly to the $web container — no staging, zipping,
or ARM deploy step required.

Tools:
  1. get_security_page_fields – returns the required fields / schema for building the page.
  2. deploy_security_page    – uploads HTML to $web and updates projects.json.
  3. get_policy_compliance    – retrieves Azure Policy compliance details for
                                the configured subscription.

Environment variables:
  SECURITY_SITE_STORAGE_ACCOUNT_NAME  – Storage account with static website enabled
  SECURITY_SITE_STORAGE_ACCOUNT_KEY   – (optional) account key; falls back to DefaultAzureCredential
  SECURITY_SITE_ENDPOINT_SUFFIX       – Blob endpoint suffix (default: blob.core.windows.net)
  SECURITY_SITE_CONTAINER             – Container name (default: $web)
  SECURITY_SITE_BASE_URL              – (optional) override public URL of the static site
  SECURITY_SITE_TITLE                 – Title shown on the root landing page (default: Security Packages)
  SECURITY_POLICY_ALLOWED_SUBSCRIPTIONS – Comma-separated whitelist of subscription IDs
                                          the policy compliance tool is permitted to query.
                                          This is the SOLE source of subscriptions queried;
                                          callers cannot supply a subscription. REQUIRED for
                                          the get_policy_compliance tool to function.
  SECURITY_POLICY_AUTH_MODE           – Authentication mode for ARM calls: 'OBO' (default)
                                          or 'MI' (User-Assigned Managed Identity).
  SECURITY_POLICY_MI_CLIENT_ID        – Client ID of the User-Assigned Managed Identity
                                          to use when SECURITY_POLICY_AUTH_MODE=MI.
  AZURE_MANAGEMENT_ENDPOINT           – ARM endpoint (default: https://management.azure.com)
  AZURE_MANAGEMENT_SCOPE              – Token scope for ARM (default: https://management.azure.com/.default)
"""

import json
import os
import logging
import re
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, Any, List, Optional

from fastmcp import FastMCP
from auth import get_obo_credential
from context import get_user_token

logger = logging.getLogger(__name__)

# Optional Azure imports
try:
    from azure.core import MatchConditions
    from azure.core.exceptions import ResourceExistsError, ResourceModifiedError, ResourceNotFoundError
    from azure.storage.blob import BlobServiceClient, ContentSettings
    from azure.identity import DefaultAzureCredential, ManagedIdentityCredential
    AZURE_STORAGE_AVAILABLE = True
except ImportError as e:
    AZURE_STORAGE_AVAILABLE = False
    logger.warning(f"Azure Storage SDK not available for security package tools: {e}")

try:
    import httpx
    HTTPX_AVAILABLE = True
except ImportError:
    HTTPX_AVAILABLE = False
    logger.warning("httpx not available for security package tools")


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    v = os.getenv(name)
    return v if v is not None else default


_SECRET_KEY_HINTS = (
    "key", "secret", "password", "passwd", "token", "connectionstring",
    "sastoken", "primarykey", "secondarykey", "accesskey",
)


def _redact_secrets(value: Any) -> Any:
    """Recursively redact obvious secret-bearing fields in an ARM response.

    Read-only ARM GETs typically don't return raw keys (you have to call
    listKeys for that), but defense in depth: any field whose name hints
    at a credential is replaced with "[REDACTED]".
    """
    if isinstance(value, dict):
        out: Dict[str, Any] = {}
        for k, v in value.items():
            kl = k.lower()
            if any(h in kl for h in _SECRET_KEY_HINTS) and isinstance(v, (str, int, float, bool)):
                out[k] = "[REDACTED]"
            else:
                out[k] = _redact_secrets(v)
        return out
    if isinstance(value, list):
        return [_redact_secrets(v) for v in value]
    return value


def _get_allowed_subscriptions() -> List[str]:
    """Return the whitelist of subscription IDs the policy tool may query.

    Reads SECURITY_POLICY_ALLOWED_SUBSCRIPTIONS (comma-separated). This is the
    sole authority for which subscriptions can be queried; if it is empty the
    tool refuses all requests.
    """
    raw = _env("SECURITY_POLICY_ALLOWED_SUBSCRIPTIONS", "") or ""
    return [s.strip() for s in raw.split(",") if s.strip()]


def _get_policy_arm_token(scope: str) -> str:
    """Acquire an ARM access token using the configured auth mode.

    SECURITY_POLICY_AUTH_MODE:
      - 'OBO' (default): exchange the caller's user token for an ARM token.
      - 'MI'           : use a User-Assigned Managed Identity
                         (client ID from SECURITY_POLICY_MI_CLIENT_ID).
    """
    mode = (_env("SECURITY_POLICY_AUTH_MODE", "OBO") or "OBO").strip().upper()

    if mode == "MI":
        mi_client_id = _env("SECURITY_POLICY_MI_CLIENT_ID")
        if not mi_client_id:
            raise RuntimeError(
                "SECURITY_POLICY_AUTH_MODE=MI requires SECURITY_POLICY_MI_CLIENT_ID "
                "(client ID of the User-Assigned Managed Identity)."
            )
        credential = ManagedIdentityCredential(client_id=mi_client_id)
        return credential.get_token(scope).token

    if mode != "OBO":
        raise RuntimeError(
            f"Invalid SECURITY_POLICY_AUTH_MODE='{mode}'. Must be 'OBO' or 'MI'."
        )

    user_token = get_user_token()
    if not user_token:
        raise RuntimeError("No user token available – authentication required.")
    credential = get_obo_credential(user_token, scope)
    return credential.get_token(scope).token


def _odata_escape(value: str) -> str:
    """Escape a string value for an OData $filter literal (single quotes)."""
    return value.replace("'", "''")


def _fetch_policy_definition_metadata(
    sub_id: str,
    management_endpoint: str,
    headers: Dict[str, str],
) -> Dict[str, Dict[str, str]]:
    """Best-effort: return a map of policy definition ID (lower) → metadata dict.

    Each value is {"display_name": str, "category": str}. Lists both
    subscription-scoped and built-in policy definitions. Failures are
    swallowed and an empty/partial map is returned.
    """
    meta: Dict[str, Dict[str, str]] = {}
    urls = [
        f"{management_endpoint}/subscriptions/{sub_id}"
        f"/providers/Microsoft.Authorization/policyDefinitions?api-version=2021-06-01",
        f"{management_endpoint}/providers/Microsoft.Authorization/policyDefinitions"
        f"?api-version=2021-06-01&$filter=policyType eq 'BuiltIn'",
    ]
    for url in urls:
        try:
            with httpx.Client(timeout=30.0) as client:
                while url:
                    resp = client.get(url, headers=headers)
                    if resp.status_code != 200:
                        break
                    body = resp.json()
                    for d in body.get("value", []):
                        d_id = d.get("id", "").lower()
                        props = d.get("properties", {}) or {}
                        d_name = props.get("displayName", "") or ""
                        d_meta = props.get("metadata", {}) or {}
                        d_category = d_meta.get("category", "") or ""
                        if d_id and d_id not in meta:
                            meta[d_id] = {
                                "display_name": d_name,
                                "category": d_category,
                            }
                    url = body.get("nextLink")
        except Exception as exc:
            logger.warning(
                "Could not fetch policy definition metadata from %s: %s", url, exc
            )
    return meta


_STATE_ALIAS = {
    "compliant": "Compliant",
    "noncompliant": "NonCompliant",
    "exempt": "Exempt",
    "conflict": "Conflict",
}


def _summarize_resource_details(
    results_block: Dict[str, Any],
) -> Dict[str, Any]:
    """Normalize a `results` block from the Policy Insights summarize API.

    Handles two API quirks:
      • complianceState values come back lowercase (e.g. "compliant",
        "noncompliant"), so we canonicalize them to TitleCase keys.
      • queryResultsCount is sometimes None at non-leaf scopes — derive total
        as the sum of resourceDetails counts and fall back to the field only
        when the array is empty.

    Returns a dict with: state_counts, total_resources, compliant,
    non_compliant, exempt, conflict.
    """
    state_counts: Dict[str, int] = {}
    for entry in results_block.get("resourceDetails", []) or []:
        raw = (entry.get("complianceState") or "").strip().lower()
        if not raw:
            continue
        canonical = _STATE_ALIAS.get(raw, raw.title())
        state_counts[canonical] = state_counts.get(canonical, 0) + entry.get("count", 0)

    compliant = state_counts.get("Compliant", 0)
    non_compliant = state_counts.get(
        "NonCompliant", results_block.get("nonCompliantResources", 0)
    )
    exempt = state_counts.get("Exempt", 0)
    conflict = state_counts.get("Conflict", 0)

    total = sum(state_counts.values()) or (results_block.get("queryResultsCount") or 0)

    # Defensive arithmetic backfill if Compliant absent but total > others.
    if compliant == 0 and total > (non_compliant + exempt + conflict):
        compliant = total - non_compliant - exempt - conflict
        state_counts["Compliant"] = compliant

    return {
        "state_counts": state_counts,
        "total_resources": total,
        "compliant_resources": compliant,
        "non_compliant_resources": non_compliant,
        "exempt_resources": exempt,
        "conflict_resources": conflict,
    }


def _fetch_resource_details_for_policy(
    sub_id: str,
    management_endpoint: str,
    headers: Dict[str, str],
    assignment_id: str,
    definition_reference_id: Optional[str],
    only_non_compliant: bool,
    max_resources: int,
) -> List[Dict[str, Any]]:
    """Query the per-resource policyStates for a single policy within an assignment.

    Returns a trimmed list of resources with name, type, location, scope,
    compliance state and last-evaluated timestamp.
    """
    if max_resources <= 0:
        return []

    filters = [f"policyAssignmentId eq '{_odata_escape(assignment_id)}'"]
    if definition_reference_id:
        filters.append(
            f"policyDefinitionReferenceId eq '{_odata_escape(definition_reference_id)}'"
        )
    if only_non_compliant:
        filters.append("complianceState eq 'NonCompliant'")

    url = (
        f"{management_endpoint}/subscriptions/{sub_id}"
        f"/providers/Microsoft.PolicyInsights/policyStates/latest/queryResults"
        f"?api-version=2019-10-01&$top={max_resources}"
        f"&$filter={'%20and%20'.join(filters).replace(' ', '%20')}"
    )

    resources: List[Dict[str, Any]] = []
    try:
        with httpx.Client(timeout=30.0) as client:
            resp = client.post(url, headers=headers)
            if resp.status_code != 200:
                logger.warning(
                    "policyStates queryResults returned %s for assignment %s / %s",
                    resp.status_code, assignment_id, definition_reference_id,
                )
                return []
            for entry in resp.json().get("value", []):
                rid = entry.get("resourceId", "")
                resources.append({
                    "resource_id": rid,
                    "resource_name": rid.rsplit("/", 1)[-1] if rid else "",
                    "resource_type": entry.get("resourceType", ""),
                    "resource_group": entry.get("resourceGroup", ""),
                    "resource_location": entry.get("resourceLocation", ""),
                    "compliance_state": entry.get("complianceState", ""),
                    "timestamp": entry.get("timestamp", ""),
                    "policy_definition_id": entry.get("policyDefinitionId", ""),
                    "policy_definition_reference_id": entry.get(
                        "policyDefinitionReferenceId", ""
                    ),
                })
    except Exception as exc:
        logger.warning(
            "Failed to fetch resource details for assignment %s / %s: %s",
            assignment_id, definition_reference_id, exc,
        )
    return resources


def _query_policy_compliance_for_sub(
    sub_id: str,
    management_endpoint: str,
    headers: Dict[str, str],
    include_policy_definitions: bool = True,
    include_resources: bool = False,
    only_non_compliant_resources: bool = True,
    max_resources_per_policy: int = 25,
) -> Dict[str, Any]:
    """Query Policy Insights summarize + (optionally) per-policy and per-resource detail.

    Args:
        sub_id: Subscription ID to query.
        management_endpoint: ARM endpoint.
        headers: HTTP headers including Authorization.
        include_policy_definitions: Include drill-down into individual policies
            inside each assignment/initiative.
        include_resources: Include per-resource compliance detail for each policy
            (uses the policyStates queryResults endpoint).
        only_non_compliant_resources: When include_resources is True, restrict
            the per-resource list to NonCompliant resources only.
        max_resources_per_policy: Cap on resources returned per policy definition
            to keep payload size bounded.
    """
    base_path = (
        f"/subscriptions/{sub_id}"
        f"/providers/Microsoft.PolicyInsights/policyStates/latest/summarize"
    )
    url = f"{management_endpoint}{base_path}?api-version=2019-10-01"

    with httpx.Client(timeout=30.0) as client:
        resp = client.post(url, headers=headers)
        resp.raise_for_status()
        data = resp.json()

    summaries = data.get("value", [])
    if not summaries:
        return {
            "success": True,
            "subscription_id": sub_id,
            "summary": None,
            "message": "No policy data returned.",
        }

    summary = summaries[0]
    results = summary.get("results", {})

    # Fetch policy assignment display names (best-effort)
    assignment_names: Dict[str, str] = {}
    try:
        pa_path = (
            f"/subscriptions/{sub_id}"
            f"/providers/Microsoft.Authorization/policyAssignments"
        )
        pa_url = f"{management_endpoint}{pa_path}?api-version=2022-06-01"
        with httpx.Client(timeout=30.0) as client2:
            pa_resp = client2.get(pa_url, headers=headers)
            if pa_resp.status_code == 200:
                for pa in pa_resp.json().get("value", []):
                    pa_id = pa.get("id", "").lower()
                    pa_name = pa.get("properties", {}).get("displayName", "")
                    if pa_id and pa_name:
                        assignment_names[pa_id] = pa_name
    except Exception as name_exc:
        logger.warning(
            "Could not fetch policy assignment names for %s: %s", sub_id, name_exc
        )

    # Fetch policy definition display names + category metadata only if we
    # need them. Categories let the page group policies the same way the
    # Azure portal's "Groups" tab does (Network Security, Identity, etc.).
    definition_meta: Dict[str, Dict[str, str]] = {}
    if include_policy_definitions:
        definition_meta = _fetch_policy_definition_metadata(
            sub_id, management_endpoint, headers
        )

    policy_assignments = []
    # Collect (def_entry, assignment_id, ref_id) tuples that need a resource fetch
    # so we can run them in parallel after building the assignment tree.
    pending_resource_fetches: List[tuple] = []

    for assignment in summary.get("policyAssignments", []):
        assignment_results = assignment.get("results", {}) or {}
        a_id = assignment.get("policyAssignmentId", "")
        friendly = assignment_names.get(a_id.lower(), "")

        # Normalize the assignment-level results block (handles lowercase
        # complianceState values + null queryResultsCount).
        a_summary = _summarize_resource_details(assignment_results)

        # Derive scope (subscription / managementGroup / tenant) from the
        # assignment ID so the user can see which assignments are inherited
        # from a parent management group vs. defined directly on the sub.
        a_id_lower = a_id.lower()
        if "/managementgroups/" in a_id_lower:
            scope_kind = "managementGroup"
            try:
                scope_name = a_id.split("/managementGroups/", 1)[1].split("/", 1)[0]
            except IndexError:
                scope_name = ""
        elif a_id_lower.startswith("/subscriptions/"):
            scope_kind = "subscription"
            try:
                scope_name = a_id.split("/subscriptions/", 1)[1].split("/", 1)[0]
            except IndexError:
                scope_name = ""
        elif a_id_lower.startswith("/providers/"):
            scope_kind = "tenant"
            scope_name = ""
        else:
            scope_kind = "unknown"
            scope_name = ""
        inherited = scope_kind in ("managementGroup", "tenant")

        assignment_entry: Dict[str, Any] = {
            "assignment_id": a_id,
            "display_name": friendly or a_id.rsplit("/", 1)[-1] or "(Unnamed)",
            "scope_kind": scope_kind,
            "scope_name": scope_name,
            "inherited": inherited,
            "total_resources": a_summary["total_resources"],
            "compliant_resources": a_summary["compliant_resources"],
            "non_compliant_resources": a_summary["non_compliant_resources"],
            "exempt_resources": a_summary["exempt_resources"],
            "non_compliant_policies": assignment_results.get("nonCompliantPolicies", 0),
            "resource_counts_by_state": a_summary["state_counts"],
        }

        if include_policy_definitions:
            definitions_out: List[Dict[str, Any]] = []
            for pdef in assignment.get("policyDefinitions", []):
                d_results = pdef.get("results", {}) or {}
                d_id = pdef.get("policyDefinitionId", "") or ""
                ref_id = pdef.get("policyDefinitionReferenceId", "") or ""
                d_meta = definition_meta.get(d_id.lower(), {})
                d_friendly = d_meta.get("display_name", "")
                d_category = d_meta.get("category", "")

                # Normalize policy-definition-level results the same way
                # so totals are correct (was reading null queryResultsCount).
                d_summary = _summarize_resource_details(d_results)
                non_compliant_count = d_summary["non_compliant_resources"]
                total_count = d_summary["total_resources"]

                def_entry: Dict[str, Any] = {
                    "policy_definition_id": d_id,
                    "policy_definition_reference_id": ref_id,
                    "display_name": d_friendly or ref_id or d_id.rsplit("/", 1)[-1]
                                    or "(Unnamed)",
                    "category": d_category,
                    "effect": pdef.get("effect", ""),
                    "compliance_state": (
                        "NonCompliant" if non_compliant_count > 0 else "Compliant"
                    ),
                    "total_resources": total_count,
                    "compliant_resources": d_summary["compliant_resources"],
                    "non_compliant_resources": non_compliant_count,
                    "exempt_resources": d_summary["exempt_resources"],
                }

                if include_resources:
                    # Skip policies that have no resources we'd find:
                    #   - only_non_compliant_resources=True → need at least one
                    #     non-compliant resource.
                    #   - only_non_compliant_resources=False → need any resource
                    #     evaluated (total_resources > 0).
                    needs_fetch = (
                        non_compliant_count > 0
                        if only_non_compliant_resources
                        else total_count > 0
                    )
                    if needs_fetch:
                        def_entry["resources"] = []  # populated below
                        pending_resource_fetches.append((def_entry, a_id, ref_id or None))
                    else:
                        def_entry["resources"] = []

                definitions_out.append(def_entry)

            # Per-assignment policy counts (matches the portal's "29 / 170
            # non-compliant policies" badge on each initiative).
            assignment_entry["policy_definitions"] = definitions_out
            assignment_entry["total_policies"] = len(definitions_out)
            assignment_entry["non_compliant_policies_count"] = sum(
                1 for d in definitions_out if d["non_compliant_resources"] > 0
            )
            assignment_entry["compliant_policies_count"] = (
                assignment_entry["total_policies"]
                - assignment_entry["non_compliant_policies_count"]
            )

        policy_assignments.append(assignment_entry)

    # Run all queryResults calls concurrently to keep total latency bounded.
    if pending_resource_fetches:
        max_workers = min(16, len(pending_resource_fetches))
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            future_map = {
                pool.submit(
                    _fetch_resource_details_for_policy,
                    sub_id,
                    management_endpoint,
                    headers,
                    a_id,
                    ref_id,
                    only_non_compliant_resources,
                    max_resources_per_policy,
                ): def_entry
                for (def_entry, a_id, ref_id) in pending_resource_fetches
            }
            for fut in as_completed(future_map):
                def_entry = future_map[fut]
                try:
                    def_entry["resources"] = fut.result() or []
                except Exception as exc:
                    logger.warning(
                        "Resource fetch failed for %s: %s",
                        def_entry.get("policy_definition_reference_id")
                        or def_entry.get("policy_definition_id"),
                        exc,
                    )
                    def_entry["resources"] = []

    # Normalize the top-level results block (handles lowercase complianceState
    # values + null queryResultsCount). See _summarize_resource_details.
    overall_summary = _summarize_resource_details(results)
    state_counts = overall_summary["state_counts"]
    total_resources = overall_summary["total_resources"]
    non_compliant_resources = overall_summary["non_compliant_resources"]
    compliant_resources = overall_summary["compliant_resources"]
    exempt_resources = overall_summary["exempt_resources"]
    conflict_resources = overall_summary["conflict_resources"]

    compliance_percent = (
        round((compliant_resources / total_resources) * 100, 1)
        if total_resources > 0
        else 0.0
    )

    # Per-assignment compliance state derived from non_compliant_resources count.
    total_assignments = len(policy_assignments)
    non_compliant_assignments = sum(
        1 for a in policy_assignments if a.get("non_compliant_resources", 0) > 0
    )
    compliant_assignments = total_assignments - non_compliant_assignments

    overall_block = {
        "total_resources": total_resources,
        "compliant_resources": compliant_resources,
        "non_compliant_resources": non_compliant_resources,
        "exempt_resources": exempt_resources,
        "conflict_resources": conflict_resources,
        "compliance_percent": compliance_percent,
        "non_compliant_policies": results.get("nonCompliantPolicies", 0),
        "resource_counts_by_state": state_counts,
        "total_assignments": total_assignments,
        "compliant_assignments": compliant_assignments,
        "non_compliant_assignments": non_compliant_assignments,
    }

    # Diagnostic logging — emit the exact `overall` payload + raw inputs the
    # arithmetic was derived from. Lets us prove server-side correctness vs
    # the agent mis-rendering the payload downstream.
    logger.info(
        "📊 Policy compliance OVERALL for sub=%s | "
        "raw resourceDetails=%s | nonCompliantResources=%s queryResultsCount=%s | "
        "computed compliant=%s non_compliant=%s exempt=%s conflict=%s total=%s percent=%s%% | "
        "assignments total=%s compliant=%s non_compliant=%s",
        sub_id,
        results.get("resourceDetails"),
        results.get("nonCompliantResources"),
        results.get("queryResultsCount"),
        compliant_resources,
        non_compliant_resources,
        exempt_resources,
        conflict_resources,
        total_resources,
        compliance_percent,
        total_assignments,
        compliant_assignments,
        non_compliant_assignments,
    )

    return {
        "success": True,
        "subscription_id": sub_id,
        "overall": overall_block,
        "policy_assignments": policy_assignments,
    }


def _fetch_full_compliance(
    *,
    include_policy_definitions: bool = True,
    include_resources: bool = True,
    only_non_compliant_resources: bool = True,
    max_resources_per_policy: int = 25,
) -> Dict[str, Any]:
    """Fetch the full policy-compliance payload for every allowed subscription.

    Same code path as the ``get_policy_compliance`` MCP tool — extracted so
    ``deploy_security_page`` can fetch fresh data server-side at deploy
    time and never have to trust the LLM to round-trip a large JSON blob.

    Returns the same shape as ``get_policy_compliance``:
        ``{success, queried_at, subscription_count, subscriptions: [...]}`` 
    """
    if not HTTPX_AVAILABLE:
        return {"success": False, "error": "httpx is not installed."}

    allowed = _get_allowed_subscriptions()
    if not allowed:
        return {
            "success": False,
            "error": (
                "No subscriptions are permitted. Configure "
                "SECURITY_POLICY_ALLOWED_SUBSCRIPTIONS with one or more "
                "subscription IDs."
            ),
        }

    management_endpoint = _env("AZURE_MANAGEMENT_ENDPOINT", "https://management.azure.com")
    management_scope = _env("AZURE_MANAGEMENT_SCOPE", "https://management.azure.com/.default")

    try:
        access_token = _get_policy_arm_token(management_scope)
    except Exception as exc:
        logger.error(f"Failed to acquire ARM token: {exc}", exc_info=True)
        return {"success": False, "error": f"Token acquisition failed: {exc}"}

    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }

    per_sub_results: List[Dict[str, Any]] = []
    for sub_id in allowed:
        try:
            sub_result = _query_policy_compliance_for_sub(
                sub_id,
                management_endpoint,
                headers,
                include_policy_definitions=include_policy_definitions,
                include_resources=include_resources,
                only_non_compliant_resources=only_non_compliant_resources,
                max_resources_per_policy=max_resources_per_policy,
            )
        except Exception as exc:
            logger.error(
                "Failed to retrieve policy compliance for %s: %s",
                sub_id, exc, exc_info=True,
            )
            sub_result = {
                "success": False,
                "subscription_id": sub_id,
                "error": str(exc),
            }
        per_sub_results.append(sub_result)

    return {
        "success": all(r.get("success") for r in per_sub_results),
        "queried_at": datetime.now(timezone.utc).isoformat(),
        "subscription_count": len(per_sub_results),
        "subscriptions": per_sub_results,
    }


def _get_static_site_blob_service() -> "BlobServiceClient":
    """Build a BlobServiceClient for the static-website storage account."""
    account_name = _env("SECURITY_SITE_STORAGE_ACCOUNT_NAME")
    if not account_name:
        raise RuntimeError("SECURITY_SITE_STORAGE_ACCOUNT_NAME is not configured")

    account_key = _env("SECURITY_SITE_STORAGE_ACCOUNT_KEY")
    endpoint_suffix = _env("SECURITY_SITE_ENDPOINT_SUFFIX", "blob.core.windows.net")
    account_url = f"https://{account_name}.{endpoint_suffix}"

    if account_key:
        return BlobServiceClient(account_url=account_url, credential=account_key)
    else:
        return BlobServiceClient(account_url=account_url, credential=DefaultAzureCredential())


# ── Projects index helpers ──────────────────────────────────────────

PROJECTS_INDEX_BLOB = "projects.json"


def _read_projects_index(container_client) -> tuple[List[Dict[str, Any]], Optional[str]]:
    """Read the projects.json index and return its content plus blob etag."""
    blob_client = container_client.get_blob_client(PROJECTS_INDEX_BLOB)
    try:
        download = blob_client.download_blob()
        data = download.readall()
    except ResourceNotFoundError:
        return [], None
    except Exception as exc:
        raise RuntimeError(f"Failed to read {PROJECTS_INDEX_BLOB}: {exc}") from exc

    try:
        projects = json.loads(data)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{PROJECTS_INDEX_BLOB} does not contain valid JSON") from exc

    if not isinstance(projects, list):
        raise RuntimeError(f"{PROJECTS_INDEX_BLOB} must contain a JSON array")
    if not all(isinstance(project, dict) for project in projects):
        raise RuntimeError(f"{PROJECTS_INDEX_BLOB} must contain an array of project objects")

    return projects, download.properties.etag


def _write_projects_index(container_client, projects: List[Dict[str, Any]], etag: Optional[str]):
    """Write the projects.json index back to the $web container."""
    blob_client = container_client.get_blob_client(PROJECTS_INDEX_BLOB)
    upload_kwargs = {
        "content_settings": ContentSettings(content_type="application/json"),
    }

    if etag is None:
        upload_kwargs["overwrite"] = False
    else:
        upload_kwargs["overwrite"] = True
        upload_kwargs["etag"] = etag
        upload_kwargs["match_condition"] = MatchConditions.IfNotModified

    blob_client.upload_blob(json.dumps(projects, indent=2), **upload_kwargs)


def _update_projects_index(container_client, project_entry: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Append or replace a single project entry without dropping other projects."""
    last_error: Optional[Exception] = None

    for attempt in range(3):
        try:
            projects, etag = _read_projects_index(container_client)
            updated_projects = [
                project for project in projects
                if project.get("project_name") != project_entry["project_name"]
            ]
            updated_projects.append(project_entry)
            _write_projects_index(container_client, updated_projects, etag)
            return updated_projects
        except (ResourceExistsError, ResourceModifiedError) as exc:
            last_error = exc
            logger.warning(
                "Concurrent update detected for %s on attempt %s/3; retrying.",
                PROJECTS_INDEX_BLOB,
                attempt + 1,
            )

    raise RuntimeError(
        f"Failed to update {PROJECTS_INDEX_BLOB} after repeated concurrent modifications"
    ) from last_error


# ── Root landing page ───────────────────────────────────────────────

ROOT_INDEX_BLOB = "index.html"

_ROOT_INDEX_HTML = """\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{site_title}</title>
  <style>
    :root {{
      --primary: #0078d4; --primary-dark: #005a9e;
      --bg: #f3f2f1; --card-bg: #ffffff; --text: #323130;
      --muted: #605e5c; --border: #edebe9;
      --success: #107c10; --danger: #d13438;
    }}
    * {{ margin: 0; padding: 0; box-sizing: border-box; }}
    body {{ font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }}
    header {{ background: linear-gradient(135deg, var(--primary), var(--primary-dark)); color: #fff; padding: 2.5rem 1rem 2rem; text-align: center; }}
    header h1 {{ font-size: 2rem; font-weight: 600; }}
    header p  {{ margin-top: .5rem; opacity: .85; font-size: 1.05rem; }}
    .stats-bar {{ display: flex; justify-content: center; gap: 2rem; margin-top: 1.25rem; flex-wrap: wrap; }}
    .stat {{ text-align: center; }}
    .stat .number {{ font-size: 1.8rem; font-weight: 700; }}
    .stat .label  {{ font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; opacity: .8; }}
    .toolbar {{ max-width: 960px; margin: 1.5rem auto 0; padding: 0 1rem; display: flex; gap: .75rem; flex-wrap: wrap; }}
    .toolbar input[type="search"] {{ flex: 1; min-width: 200px; padding: .55rem .85rem; border: 1px solid var(--border); border-radius: 4px; font-size: .95rem; outline: none; }}
    .toolbar input[type="search"]:focus {{ border-color: var(--primary); box-shadow: 0 0 0 2px rgba(0,120,212,.15); }}
    .toolbar select {{ padding: .55rem .85rem; border: 1px solid var(--border); border-radius: 4px; font-size: .95rem; background: #fff; }}
    .container {{ max-width: 960px; margin: 1.5rem auto 3rem; padding: 0 1rem; }}
    .card {{
      background: var(--card-bg); border: 1px solid var(--border);
      border-radius: 8px; padding: 1.25rem 1.5rem; margin-bottom: .85rem;
      transition: box-shadow .2s, border-color .2s;
    }}
    .card:hover {{ box-shadow: 0 2px 12px rgba(0,0,0,.08); border-color: var(--primary); }}
    .card h2 {{ font-size: 1.1rem; font-weight: 600; }}
    .card h2 a {{ color: var(--primary); text-decoration: none; }}
    .card h2 a:hover {{ text-decoration: underline; }}
    .card .meta {{ font-size: .82rem; color: var(--muted); margin-top: .3rem; display: flex; gap: 1rem; flex-wrap: wrap; }}
    .card .desc {{ margin-top: .45rem; font-size: .92rem; }}
    .badge {{ display: inline-block; font-size: .75rem; font-weight: 600; padding: .2rem .6rem; border-radius: 12px; margin-top: .5rem; }}
    .badge-new {{ background: #e6f4ea; color: var(--success); }}
    #loading {{ text-align: center; padding: 4rem 1rem; color: var(--muted); }}
    .spinner {{ display: inline-block; width: 28px; height: 28px; border: 3px solid var(--border); border-top-color: var(--primary); border-radius: 50%; animation: spin .7s linear infinite; margin-bottom: .75rem; }}
    @keyframes spin {{ to {{ transform: rotate(360deg); }} }}
    #error {{ text-align: center; padding: 2rem; color: var(--danger); display: none; }}
    .empty {{ text-align: center; padding: 4rem 1rem; color: var(--muted); }}
    footer {{ text-align: center; padding: 1.5rem; font-size: .8rem; color: var(--muted); border-top: 1px solid var(--border); }}
  </style>
</head>
<body>
  <header>
    <h1>{site_title}</h1>
    <p>Browse security package pages for each project</p>
    <div class="stats-bar">
      <div class="stat"><div class="number" id="stat-total">&mdash;</div><div class="label">Projects</div></div>
      <div class="stat"><div class="number" id="stat-recent">&mdash;</div><div class="label">Last 30 days</div></div>
      <div class="stat"><div class="number" id="stat-owners">&mdash;</div><div class="label">Owners</div></div>
    </div>
  </header>
  <div class="toolbar">
    <input type="search" id="search" placeholder="Search projects\u2026" aria-label="Search projects" />
    <select id="sort" aria-label="Sort order">
      <option value="newest">Newest first</option>
      <option value="oldest">Oldest first</option>
      <option value="name">Name A\u2013Z</option>
    </select>
  </div>
  <div class="container">
    <div id="loading"><div class="spinner"></div><div>Loading projects&hellip;</div></div>
    <div id="error">Failed to load projects. Check that <code>projects.json</code> exists.</div>
    <div id="projects"></div>
  </div>
  <footer>Security Package Portal &mdash; Powered by MCP Tools</footer>
  <script>
    (async () => {{
      const el = document.getElementById('projects');
      const loading = document.getElementById('loading');
      const error = document.getElementById('error');
      const searchBox = document.getElementById('search');
      const sortBox = document.getElementById('sort');
      let allProjects = [];
      try {{
        const resp = await fetch('/projects.json');
        if (!resp.ok) throw new Error(resp.statusText);
        allProjects = await resp.json();
        loading.style.display = 'none';
      }} catch (e) {{
        loading.style.display = 'none';
        error.style.display = 'block';
        console.error('Failed to load projects.json', e);
        return;
      }}
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
      document.getElementById('stat-total').textContent = allProjects.length;
      document.getElementById('stat-recent').textContent = allProjects.filter(p => new Date(p.deployed_at) >= thirtyDaysAgo).length;
      document.getElementById('stat-owners').textContent = new Set(allProjects.map(p => (p.owner || '').toLowerCase())).size;
      function render() {{
        const q = searchBox.value.trim().toLowerCase();
        let list = allProjects;
        if (q) list = list.filter(p =>
          (p.display_name || p.project_name || '').toLowerCase().includes(q) ||
          (p.description || '').toLowerCase().includes(q) ||
          (p.owner || '').toLowerCase().includes(q));
        const s = sortBox.value;
        list = [...list].sort((a, b) => {{
          if (s === 'newest') return (b.deployed_at || '').localeCompare(a.deployed_at || '');
          if (s === 'oldest') return (a.deployed_at || '').localeCompare(b.deployed_at || '');
          return (a.display_name || a.project_name || '').localeCompare(b.display_name || b.project_name || '');
        }});
        if (!list.length) {{ el.innerHTML = '<div class="empty">No matching projects found.</div>'; return; }}
        const isRecent = d => d && new Date(d) >= thirtyDaysAgo;
        el.innerHTML = list.map(p => `
          <div class="card">
            <h2><a href="${{p.path}}">${{p.display_name || p.project_name}}</a></h2>
            <div class="meta">
              <span>Owner: ${{p.owner || 'N/A'}}</span>
              <span>Deployed: ${{p.deployed_at ? new Date(p.deployed_at).toLocaleDateString() : 'N/A'}}</span>
            </div>
            ${{p.description ? `<div class="desc">${{p.description}}</div>` : ''}}
            ${{isRecent(p.deployed_at) ? '<span class="badge badge-new">New</span>' : ''}}
          </div>`).join('');
      }}
      searchBox.addEventListener('input', render);
      sortBox.addEventListener('change', render);
      render();
    }})();
  </script>
</body>
</html>
"""


def _ensure_root_index(container_client):
    """Seed the root index.html in the $web container if it does not exist.

    The page fetches /projects.json at load time and renders project cards
    with links — no server-side regeneration needed.
    """
    blob_client = container_client.get_blob_client(ROOT_INDEX_BLOB)
    try:
        blob_client.get_blob_properties()
        # Already exists — leave it alone so manual customisations survive
        logger.debug("Root index.html already exists; skipping seed.")
        return
    except Exception:
        pass  # Blob does not exist — create it

    site_title = _env("SECURITY_SITE_TITLE", "Security Packages")
    html = _ROOT_INDEX_HTML.format(site_title=site_title)
    blob_client.upload_blob(
        html,
        overwrite=False,
        content_settings=ContentSettings(content_type="text/html; charset=utf-8"),
    )
    logger.info("Seeded root index.html in $web container")


# ── Tool registration ──────────────────────────────────────────────

def register_security_package_tools(mcp: FastMCP):
    """Register security-package web-page MCP tools with the server."""

    # ----------------------------------------------------------------
    # Tool 1 – Get required fields for the security package web page
    # ----------------------------------------------------------------

    @mcp.tool
    def get_security_page_fields() -> Dict[str, Any]:
        """Return the required and optional fields for building a Security Package web page.

        Use this to understand what data the LLM must collect or generate
        before calling deploy_security_page.

        The schema is loaded from the JSON file pointed to by the
        ``SECURITY_PAGE_FIELDS_FILE`` environment variable. There is no
        built-in fallback — if the env var is unset or the file is missing
        / unreadable, this tool returns an error so the schema is always
        sourced from configuration.

        Returns:
            A schema describing every field, its type, and whether it is required.
        """
        fields_file = _env("SECURITY_PAGE_FIELDS_FILE")
        if not fields_file:
            return {
                "success": False,
                "error": (
                    "SECURITY_PAGE_FIELDS_FILE is not configured. Set it to the "
                    "path of the security page fields JSON schema."
                ),
            }
        if not os.path.isfile(fields_file):
            return {
                "success": False,
                "error": f"Security page fields file not found: {fields_file}",
            }
        try:
            with open(fields_file, "r", encoding="utf-8") as f:
                schema = json.load(f)
        except Exception as exc:
            logger.error(f"Failed to load {fields_file}: {exc}", exc_info=True)
            return {
                "success": False,
                "error": f"Failed to load security page fields from {fields_file}: {exc}",
            }
        logger.info(f"Loaded security page fields from {fields_file}")
        return {"success": True, "schema": schema}

    # ----------------------------------------------------------------
    # Tool 2 – Deploy HTML to an Azure Storage static website
    # ----------------------------------------------------------------

    @mcp.tool
    def deploy_security_page(
        project_name: str,
        project_display_name: str,
        description: str,
        owner: str,
        html_content: str,
        page_data: str = "",
        auto_fetch_compliance: bool = True,
        include_resources: bool = True,
        only_non_compliant_resources: bool = True,
        max_resources_per_policy: int = 25,
    ) -> Dict[str, Any]:
        """Deploy a Security Package HTML page to an Azure Storage static website.

        Uploads the provided HTML as ``<project_name>/index.html`` into the
        ``$web`` container, and a JSON data file as
        ``<project_name>/data.json`` (structured machine-readable version).
        Seeds a root landing page if one does not exist, and upserts the
        project into ``projects.json`` so it appears on the site's project
        list.

        POLICY COMPLIANCE — SERVER-SIDE FETCH (preferred):
            If ``html_content`` contains ``<!--POLICY_COMPLIANCE_SECTION-->``
            and ``auto_fetch_compliance`` is True (default), the server
            re-runs the same fetch as ``get_policy_compliance`` at deploy
            time, splices the result into ``page_data.compliance``, renders
            the marker into a full HTML fragment (every initiative / policy
            / resource), and uploads the merged ``data.json``. The agent
            does NOT need to embed compliance in ``page_data`` — server
            fetches it fresh, eliminating LLM round-trip truncation.

            If ``auto_fetch_compliance`` is False, the server falls back to
            ``page_data.compliance`` as supplied; the renderer rejects
            payloads with renamed keys.

        Args:
            project_name: URL-safe project identifier (used as folder name).
            project_display_name: Human-readable project title for the index.
            description: Short description shown in the projects list.
            owner: Project owner name or email.
            html_content: Full HTML content to deploy as the project page.
                          Should include a link to data.json, e.g.:
                          ``<a href="data.json">View JSON</a>``.
                          Should contain exactly one
                          ``<!--POLICY_COMPLIANCE_SECTION-->`` marker where
                          the policy compliance section belongs.
            page_data: Optional JSON string containing the structured data
                       for this security package (metadata, risk register,
                       approvals, etc.). When ``auto_fetch_compliance`` is
                       True the server overwrites any ``compliance`` key
                       with freshly-fetched data.
            auto_fetch_compliance: When True (default), server re-fetches
                       compliance via ``get_policy_compliance`` at deploy
                       time. Set False only if you must use a snapshot
                       embedded in ``page_data.compliance``.
            include_resources: Forwarded to the compliance fetch when
                       auto_fetch_compliance=True. Default True.
            only_non_compliant_resources: Forwarded to the compliance
                       fetch. Default True.
            max_resources_per_policy: Forwarded to the compliance fetch.
                       Default 25.

        Returns:
            A dict with success status, the URL of the deployed page, and
            the updated projects list. Includes ``policy_marker_present``,
            ``policy_marker_replaced``, ``policy_marker_error``, and
            ``compliance_auto_fetched`` flags so callers can detect
            partial success.
        """
        if not AZURE_STORAGE_AVAILABLE:
            return {"success": False, "error": "Azure Storage SDK is not installed."}

        # Sanitise project_name to prevent path traversal
        safe_name = "".join(
            c if c.isalnum() or c in ("-", "_") else "-"
            for c in project_name.strip()
        ).strip("-")
        if not safe_name:
            return {"success": False, "error": "project_name is empty or invalid after sanitisation."}

        container_name = _env("SECURITY_SITE_CONTAINER", "$web")

        # ── 0. Server-side substitution of the policy compliance marker ───
        # Two paths:
        #   a) auto_fetch_compliance=True (default): server re-fetches the
        #      full get_policy_compliance result and uses it. Eliminates
        #      LLM round-trip truncation of large JSON.
        #   b) auto_fetch_compliance=False: use page_data.compliance as
        #      supplied (validated by the renderer).
        policy_marker = "<!--POLICY_COMPLIANCE_SECTION-->"
        marker_replaced = False

        # Strip the chat-preview-only notice block before any further
        # processing. The orchestrator inserts <section class="sp-preview-note">
        # to tell the user "the full policy section will appear on the
        # published page" — that notice is meaningless once the page IS
        # the published page.
        preview_note_pattern = re.compile(
            r'\s*<section\b[^>]*\bclass="[^"]*\bsp-preview-note\b[^"]*"[^>]*>'
            r'.*?</section>\s*',
            re.DOTALL | re.IGNORECASE,
        )
        if preview_note_pattern.search(html_content):
            html_content = preview_note_pattern.sub("\n", html_content)
            logger.info("deploy_security_page: stripped sp-preview-note block from HTML")

        marker_present = policy_marker in html_content
        marker_error: Optional[str] = None
        compliance_auto_fetched = False

        # Parse page_data once so we can splice fresh compliance into it.
        page_data_obj: Optional[Dict[str, Any]] = None
        if page_data:
            try:
                parsed = json.loads(page_data)
                if isinstance(parsed, dict):
                    page_data_obj = parsed
                else:
                    marker_error = "page_data did not parse to a JSON object."
            except Exception as exc:
                logger.warning(
                    "deploy_security_page: page_data is not valid JSON (%s)",
                    exc,
                )
                marker_error = f"page_data is not valid JSON: {exc}"

        if marker_present:
            compliance_payload: Optional[Dict[str, Any]] = None

            if auto_fetch_compliance:
                logger.info(
                    "deploy_security_page: auto-fetching compliance "
                    "(include_resources=%s, only_non_compliant=%s, max=%s)",
                    include_resources, only_non_compliant_resources,
                    max_resources_per_policy,
                )
                fetched = _fetch_full_compliance(
                    include_policy_definitions=True,
                    include_resources=include_resources,
                    only_non_compliant_resources=only_non_compliant_resources,
                    max_resources_per_policy=max_resources_per_policy,
                )
                if fetched.get("success") or fetched.get("subscriptions"):
                    compliance_payload = fetched
                    compliance_auto_fetched = True
                    # Splice fresh data into page_data so data.json is the
                    # system of record.
                    if page_data_obj is None:
                        page_data_obj = {}
                    page_data_obj["compliance"] = fetched
                else:
                    marker_error = (
                        "auto_fetch_compliance failed: "
                        f"{fetched.get('error', 'unknown error')}"
                    )
                    logger.error(marker_error)

            # Fall back to caller-supplied compliance if auto-fetch was
            # disabled or failed and page_data has it.
            if compliance_payload is None and page_data_obj is not None:
                supplied = page_data_obj.get("compliance")
                if supplied:
                    compliance_payload = supplied

            if compliance_payload:
                try:
                    from services.policy_compliance_renderer import (
                        render,
                        CompliancePayloadError,
                    )
                    try:
                        rendered = render(compliance_payload)
                    except CompliancePayloadError as exc:
                        logger.error(
                            "Rejected compliance payload: %s", exc,
                        )
                        return {
                            "success": False,
                            "error": (
                                "Compliance payload rejected by renderer. "
                                "When auto_fetch_compliance=False, "
                                "page_data.compliance must be the verbatim "
                                "result of get_policy_compliance — do not "
                                "rename keys, summarize, or fabricate data. "
                                f"Details: {exc}"
                            ),
                            "policy_marker_present": True,
                            "policy_marker_replaced": False,
                            "compliance_auto_fetched": compliance_auto_fetched,
                        }
                    fragment = (rendered.get("css", "") or "") + "\n" + (rendered.get("html", "") or "")
                    html_content = html_content.replace(policy_marker, fragment, 1)
                    marker_replaced = True
                    logger.info(
                        "Expanded %s in deployed HTML (%d chars injected, "
                        "auto_fetched=%s)",
                        policy_marker, len(fragment), compliance_auto_fetched,
                    )
                except Exception as exc:
                    logger.error(
                        "Failed to render policy compliance fragment: %s",
                        exc, exc_info=True,
                    )
                    marker_error = str(exc)
            else:
                logger.warning(
                    "deploy_security_page: marker %s present but no "
                    "compliance payload available — marker left in place.",
                    policy_marker,
                )
                if marker_error is None:
                    marker_error = (
                        "marker present but no compliance payload — enable "
                        "auto_fetch_compliance=True or embed verbatim "
                        "get_policy_compliance result under "
                        "page_data.compliance."
                    )

        # Re-serialize page_data if we mutated it (auto-fetched compliance).
        if compliance_auto_fetched and page_data_obj is not None:
            page_data = json.dumps(page_data_obj, separators=(",", ":"))

        try:
            blob_service = _get_static_site_blob_service()
            container_client = blob_service.get_container_client(container_name)

            # ── 1. Upload the project page ─────────────────────────────
            blob_path = f"{safe_name}/index.html"
            blob_client = container_client.get_blob_client(blob_path)
            blob_client.upload_blob(
                html_content,
                overwrite=True,
                content_settings=ContentSettings(content_type="text/html; charset=utf-8"),
            )
            logger.info(f"Uploaded security page to {blob_path}")

            # ── 1b. Upload JSON data file (if provided) ───────────────
            json_blob_path = f"{safe_name}/data.json"
            if page_data:
                json_blob = container_client.get_blob_client(json_blob_path)
                json_blob.upload_blob(
                    page_data,
                    overwrite=True,
                    content_settings=ContentSettings(content_type="application/json; charset=utf-8"),
                )
                logger.info(f"Uploaded JSON data to {json_blob_path}")

            # ── 2. Update the projects index ───────────────────────────
            projects = _update_projects_index(container_client, {
                "project_name": safe_name,
                "display_name": project_display_name,
                "description": description,
                "owner": owner,
                "deployed_at": datetime.now(timezone.utc).isoformat(),
                "path": f"/{safe_name}/index.html",
                "json_path": f"/{safe_name}/data.json" if page_data else None,
            })
            logger.info(f"Updated projects.json – {len(projects)} project(s)")

            # ── 3. Seed root landing page if missing ───────────────────
            _ensure_root_index(container_client)

            # ── 4. Build the public URL ────────────────────────────────
            account_name = _env("SECURITY_SITE_STORAGE_ACCOUNT_NAME")
            endpoint_suffix = _env("SECURITY_SITE_ENDPOINT_SUFFIX", "blob.core.windows.net")
            # Static-website primary endpoint: <account>.z<N>.web.<suffix without blob.>
            # The zone number varies per account — set SECURITY_SITE_BASE_URL in .env
            static_host = _env(
                "SECURITY_SITE_BASE_URL",
                f"https://{account_name}.z2.web.{endpoint_suffix.replace('blob.', '')}",
            )
            page_url = f"{static_host}/{safe_name}/index.html"
            json_url = f"{static_host}/{safe_name}/data.json" if page_data else None

            return {
                "success": True,
                "page_url": page_url,
                "json_url": json_url,
                "site_url": static_host,
                "blob_path": blob_path,
                "projects_count": len(projects),
                "projects": projects,
                "policy_marker_present": marker_present,
                "policy_marker_replaced": marker_replaced,
                "policy_marker_error": marker_error,
                "compliance_auto_fetched": compliance_auto_fetched,
            }

        except Exception as exc:
            logger.error(f"Failed to deploy security page: {exc}", exc_info=True)
            return {"success": False, "error": str(exc)}

    # ----------------------------------------------------------------
    # Tool 3 – Get Azure Policy compliance for the subscription
    # ----------------------------------------------------------------

    @mcp.tool
    def get_policy_compliance(
        include_policy_definitions: bool = True,
        include_resources: bool = False,
        only_non_compliant_resources: bool = True,
        max_resources_per_policy: int = 25,
    ) -> Dict[str, Any]:
        """Retrieve Azure Policy compliance details for the configured subscriptions.

        Calls the Azure Policy Insights REST API to return a compliance
        summary at three levels of detail:

          1. **Assignment / Initiative** (always returned) – top-level entries
             matching the Policy → Compliance blade in the Azure portal.
          2. **Policy definition** (when ``include_policy_definitions`` is True,
             default) – the individual policies inside each initiative, with
             reference ID, effect type, compliance state, and counts of
             non-compliant vs total resources. Mirrors the first drill-down.
          3. **Resource** (when ``include_resources`` is True) – per-resource
             rows for each policy definition, mirroring the second drill-down
             (resource name, type, location, scope/resource group, compliance
             state, last evaluated). Uses the policyStates ``queryResults``
             endpoint and is bounded by ``max_resources_per_policy``.

        The set of subscriptions queried is read exclusively from the
        ``SECURITY_POLICY_ALLOWED_SUBSCRIPTIONS`` environment variable
        (comma-separated). Every subscription in that list is queried.

        Authentication is controlled by ``SECURITY_POLICY_AUTH_MODE``:
          - ``OBO`` (default): on-behalf-of the calling user.
          - ``MI``           : User-Assigned Managed Identity
                               (``SECURITY_POLICY_MI_CLIENT_ID``).

        Args:
            include_policy_definitions: Include the per-policy drill-down
                under each assignment. Default True.
            include_resources: Include per-resource rows under each policy.
                Default False — enable when you need full drill-down detail.
                Can produce large payloads.
            only_non_compliant_resources: When ``include_resources`` is True,
                restrict resource rows to ``NonCompliant`` only. Default True.
            max_resources_per_policy: Cap on resources returned per policy
                definition. Default 25.

        Returns:
            A dict with a ``subscriptions`` list containing one compliance
            summary per configured subscription, suitable for embedding in
            a Security Package web page.
        """
        if not HTTPX_AVAILABLE:
            return {"success": False, "error": "httpx is not installed."}

        return _fetch_full_compliance(
            include_policy_definitions=include_policy_definitions,
            include_resources=include_resources,
            only_non_compliant_resources=only_non_compliant_resources,
            max_resources_per_policy=max_resources_per_policy,
        )

    # ----------------------------------------------------------------
    # Tool 4 – Render policy compliance JSON to an HTML fragment
    # ----------------------------------------------------------------

    @mcp.tool
    def render_policy_compliance_html(
        compliance_data: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Render the JSON returned by ``get_policy_compliance`` to a
        self-contained HTML fragment.

        The LLM truncates large policy tables when asked to render them by
        hand (it omits rows even though it acknowledges the correct count).
        This tool guarantees every row from every policy assignment is
        emitted by performing the rendering server-side.

        Workflow:
            1. Call ``get_policy_compliance`` and keep the full result.
            2. Pass that result (or a single subscription block from it)
               to this tool as ``compliance_data``.
            3. Paste the returned ``css`` and ``html`` verbatim into the
               security package page in the policy-compliance section.
               Do **not** hand-write the policy table — it will truncate.

        All CSS selectors are namespaced under ``.sp-policy`` so they
        cannot leak into surrounding styles.

        Args:
            compliance_data: Either the full ``get_policy_compliance``
                result (with a ``subscriptions`` list) or a single
                subscription block (with ``overall`` + ``policy_assignments``).

        Returns:
            ``{"success": True, "html": str, "css": str, "summary_text": str}``
            — paste ``css`` once in ``<head>`` (or just before the
            fragment) and paste ``html`` where the policy compliance
            section should appear. ``summary_text`` is a short markdown
            sentence the LLM may quote in an executive summary or
            rewrite in its own voice.
        """
        try:
            # Local import to keep tool-registration cheap and avoid
            # importing the renderer when this module is loaded.
            from services.policy_compliance_renderer import render
            result = render(compliance_data or {})
            return {
                "success": True,
                "html": result["html"],
                "css": result["css"],
                "summary_text": result["summary_text"],
            }
        except Exception as exc:
            logger.error(
                "Failed to render policy compliance HTML: %s", exc, exc_info=True
            )
            return {"success": False, "error": str(exc)}

    # ----------------------------------------------------------------
    # Tool 5 – Read-only Azure resource lookup (ARM GET)
    # ----------------------------------------------------------------

    @mcp.tool
    def get_azure_resource(
        resource_id: Optional[str] = None,
        subscription_id: Optional[str] = None,
        resource_group: Optional[str] = None,
        resource_type: Optional[str] = None,
        resource_name: Optional[str] = None,
        api_version: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Read-only lookup of an Azure resource's properties via ARM GET.

        Useful for drilling into a non-compliant resource surfaced by
        ``get_policy_compliance`` — e.g. inspecting a storage account's
        network rules, public access setting, or encryption config.

        Three ways to identify the resource:

        1. Full ARM ``resource_id`` (preferred when known — e.g. from a
           ``get_policy_compliance`` row).
        2. The four parts: ``subscription_id``, ``resource_group``,
           ``resource_type``, ``resource_name``.
        3. Just ``resource_name`` (and optionally ``resource_type`` to
           disambiguate). The tool searches all allowed subscriptions
           via Azure Resource Graph and uses the unique match. If
           multiple resources share the name, the call returns the list
           of candidates so the caller can pick one.

        ``api_version`` is optional. If omitted, the tool discovers a
        recent stable API version from the providers metadata endpoint.

        Security:
          - Only HTTP GET is performed. The tool cannot create, modify,
            or delete resources.
          - The subscription must be in
            ``SECURITY_POLICY_ALLOWED_SUBSCRIPTIONS`` or the call is
            refused.
          - The user's identity is used (OBO) — the caller still needs
            ``Reader`` (or higher) RBAC on the resource. ARM will reject
            the GET if they don't.

        Args:
            resource_id: Full ARM resource ID (preferred).
            subscription_id: Subscription containing the resource.
            resource_group: Resource group name.
            resource_type: Provider/type, e.g. ``Microsoft.Storage/storageAccounts``.
            resource_name: Resource name.
            api_version: Optional ARM api-version. Auto-discovered when omitted.

        Returns:
            ``{"success": True, "resource_id": str, "api_version": str,
              "resource": {...}}`` on success — ``resource`` is the raw
            ARM response with any obvious secret fields redacted.
            ``{"success": False, "error": str}`` on failure.
        """
        if not HTTPX_AVAILABLE:
            return {"success": False, "error": "httpx is not installed."}

        management_endpoint = _env("AZURE_MANAGEMENT_ENDPOINT", "https://management.azure.com")
        management_scope = _env("AZURE_MANAGEMENT_SCOPE", "https://management.azure.com/.default")

        try:
            access_token = _get_policy_arm_token(management_scope)
        except Exception as exc:
            logger.error("get_azure_resource: failed to acquire ARM token: %s", exc, exc_info=True)
            return {"success": False, "error": f"Failed to acquire ARM token: {exc}"}

        headers = {"Authorization": f"Bearer {access_token}"}

        allowed = _get_allowed_subscriptions()
        if not allowed:
            return {
                "success": False,
                "error": (
                    "No subscriptions are permitted. Configure "
                    "SECURITY_POLICY_ALLOWED_SUBSCRIPTIONS."
                ),
            }

        # ── Build/validate the resource ID ──────────────────────
        if resource_id:
            rid = resource_id.strip()
        elif subscription_id and resource_group and resource_type and resource_name:
            rid = (
                f"/subscriptions/{subscription_id}"
                f"/resourceGroups/{resource_group}"
                f"/providers/{resource_type}/{resource_name}"
            )
        elif resource_name:
            # Name-only lookup via Azure Resource Graph.
            kql_parts = [f"name =~ '{resource_name.replace(chr(39), chr(39)*2)}'"]
            if resource_type:
                kql_parts.append(
                    f"type =~ '{resource_type.replace(chr(39), chr(39)*2).lower()}'"
                )
            query = (
                "Resources | where "
                + " and ".join(kql_parts)
                + " | project id, name, type, location, resourceGroup, subscriptionId"
                + " | limit 25"
            )
            try:
                with httpx.Client(timeout=30.0) as client:
                    rg_resp = client.post(
                        f"{management_endpoint}/providers/Microsoft.ResourceGraph/resources",
                        params={"api-version": "2022-10-01"},
                        headers={**headers, "Content-Type": "application/json"},
                        json={"subscriptions": allowed, "query": query},
                    )
                    rg_resp.raise_for_status()
                    rg_data = rg_resp.json()
            except httpx.HTTPStatusError as exc:
                return {
                    "success": False,
                    "error": (
                        f"Resource Graph lookup failed: HTTP "
                        f"{exc.response.status_code} {exc.response.text[:300]}"
                    ),
                }
            except Exception as exc:
                return {"success": False, "error": f"Resource Graph lookup failed: {exc}"}

            matches = rg_data.get("data") or []
            if not matches:
                return {
                    "success": False,
                    "error": (
                        f"No resource named '{resource_name}'"
                        + (f" of type '{resource_type}'" if resource_type else "")
                        + " found in any allowed subscription."
                    ),
                }
            if len(matches) > 1:
                return {
                    "success": False,
                    "error": (
                        f"Multiple resources match '{resource_name}'. "
                        "Pass 'resource_type' to disambiguate, or use the "
                        "full 'resource_id' from one of the candidates."
                    ),
                    "candidates": matches,
                }
            rid = matches[0].get("id", "")
            if not rid:
                return {"success": False, "error": "Resource Graph match had no 'id' field."}
        else:
            return {
                "success": False,
                "error": (
                    "Provide one of: 'resource_id'; the four parts "
                    "(subscription_id + resource_group + resource_type + "
                    "resource_name); or just 'resource_name' (optionally "
                    "with 'resource_type' to disambiguate)."
                ),
            }

        if not rid.startswith("/subscriptions/"):
            return {
                "success": False,
                "error": "resource_id must start with /subscriptions/<subId>.",
            }

        # Extract subscription ID and provider/type for whitelist + api-version lookup.
        parts = [p for p in rid.split("/") if p]
        try:
            sub_idx = parts.index("subscriptions")
            sub_id = parts[sub_idx + 1]
        except (ValueError, IndexError):
            return {"success": False, "error": "Could not parse subscription from resource_id."}

        if sub_id.lower() not in {s.lower() for s in allowed}:
            return {
                "success": False,
                "error": (
                    f"Subscription {sub_id} is not in "
                    "SECURITY_POLICY_ALLOWED_SUBSCRIPTIONS."
                ),
            }

        # Provider namespace + type path (e.g. Microsoft.Storage / storageAccounts)
        try:
            prov_idx = parts.index("providers")
            provider_ns = parts[prov_idx + 1]
            # Type path is the alternating segments after the provider:
            # providers/<ns>/<type>/<name>[/<subtype>/<subname>...]
            type_segments = parts[prov_idx + 2:]
            # Take every other element starting at 0: type, subtype, ...
            type_path = "/".join(type_segments[::2])
        except (ValueError, IndexError):
            return {"success": False, "error": "Could not parse provider/type from resource_id."}

        # ── Resolve api-version if not supplied ─────────────────
        resolved_api_version = api_version
        if not resolved_api_version:
            try:
                with httpx.Client(timeout=20.0) as client:
                    pr = client.get(
                        f"{management_endpoint}/subscriptions/{sub_id}"
                        f"/providers/{provider_ns}",
                        params={"api-version": "2021-04-01"},
                        headers=headers,
                    )
                    pr.raise_for_status()
                    pdata = pr.json()
                # Find the matching resourceTypes entry by case-insensitive type path.
                target = type_path.lower()
                versions: List[str] = []
                for rt in pdata.get("resourceTypes", []) or []:
                    if (rt.get("resourceType") or "").lower() == target:
                        versions = rt.get("apiVersions") or []
                        break
                if not versions:
                    return {
                        "success": False,
                        "error": (
                            f"Could not auto-discover api-version for "
                            f"{provider_ns}/{type_path}. Pass 'api_version' explicitly."
                        ),
                    }
                # Prefer a stable (non-preview) version, newest first.
                stable = [v for v in versions if "preview" not in v.lower()]
                resolved_api_version = (stable or versions)[0]
            except httpx.HTTPStatusError as exc:
                return {
                    "success": False,
                    "error": (
                        f"api-version discovery failed: HTTP {exc.response.status_code} "
                        f"{exc.response.text[:300]}"
                    ),
                }
            except Exception as exc:
                return {"success": False, "error": f"api-version discovery failed: {exc}"}

        # ── GET the resource ────────────────────────────────────
        url = f"{management_endpoint}{rid}"
        try:
            with httpx.Client(timeout=30.0) as client:
                r = client.get(url, params={"api-version": resolved_api_version}, headers=headers)
                if r.status_code == 404:
                    return {
                        "success": False,
                        "error": f"Resource not found (404): {rid}",
                    }
                if r.status_code == 403:
                    return {
                        "success": False,
                        "error": (
                            "Access denied (403). The calling user needs "
                            "'Reader' RBAC (or higher) on this resource."
                        ),
                    }
                r.raise_for_status()
                body = r.json()
        except httpx.HTTPStatusError as exc:
            return {
                "success": False,
                "error": f"ARM GET failed: HTTP {exc.response.status_code} {exc.response.text[:300]}",
            }
        except Exception as exc:
            logger.error("get_azure_resource: ARM GET failed: %s", exc, exc_info=True)
            return {"success": False, "error": f"ARM GET failed: {exc}"}

        return {
            "success": True,
            "resource_id": rid,
            "api_version": resolved_api_version,
            "resource": _redact_secrets(body),
        }
