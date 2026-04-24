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
                                          The first entry is used as the default when the
                                          caller omits subscription_id. REQUIRED for the
                                          get_policy_compliance tool to function.
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
from datetime import datetime, timezone
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


def _query_policy_compliance_for_sub(
    sub_id: str,
    management_endpoint: str,
    headers: Dict[str, str],
) -> Dict[str, Any]:
    """Query Policy Insights summarize + assignment names for a single subscription."""
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

    policy_assignments = []
    for assignment in summary.get("policyAssignments", []):
        assignment_results = assignment.get("results", {})
        a_id = assignment.get("policyAssignmentId", "")
        friendly = assignment_names.get(a_id.lower(), "")
        policy_assignments.append({
            "assignment_id": a_id,
            "display_name": friendly or a_id.rsplit("/", 1)[-1] or "(Unnamed)",
            "compliant": assignment_results.get("resourceDetails", [{}]),
            "total_resources": assignment_results.get("queryResultsCount", 0),
            "non_compliant_resources": assignment_results.get("nonCompliantResources", 0),
            "non_compliant_policies": assignment_results.get("nonCompliantPolicies", 0),
        })

    return {
        "success": True,
        "subscription_id": sub_id,
        "overall": {
            "total_resources": results.get("queryResultsCount", 0),
            "non_compliant_resources": results.get("nonCompliantResources", 0),
            "non_compliant_policies": results.get("nonCompliantPolicies", 0),
        },
        "policy_assignments": policy_assignments,
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

        The schema is loaded from SECURITY_PAGE_FIELDS_FILE (a JSON file path)
        if configured.  Otherwise a built-in default schema is returned.

        Returns:
            A schema describing every field, its type, and whether it is required.
        """
        fields_file = _env("SECURITY_PAGE_FIELDS_FILE")
        if fields_file and os.path.isfile(fields_file):
            try:
                with open(fields_file, "r", encoding="utf-8") as f:
                    schema = json.load(f)
                logger.info(f"Loaded security page fields from {fields_file}")
                return {"success": True, "schema": schema}
            except Exception as exc:
                logger.warning(f"Failed to load {fields_file}, using defaults: {exc}")

        # Built-in default schema
        schema = {
            "description": (
                "Fields used to build a Security Package web page. "
                "Gather all required fields before generating the HTML and calling deploy_security_page."
            ),
            "fields": {
                "project_name": {
                    "type": "string",
                    "required": True,
                    "description": "Short, URL-safe project name (used as folder name in the static site, e.g. 'contoso-migration').",
                },
                "project_display_name": {
                    "type": "string",
                    "required": True,
                    "description": "Human-readable project title displayed on the page and in the projects index.",
                },
                "description": {
                    "type": "string",
                    "required": True,
                    "description": "Brief description of the project / security package.",
                },
                "owner": {
                    "type": "string",
                    "required": True,
                    "description": "Name or email of the project owner / security lead.",
                },
                "environment": {
                    "type": "string",
                    "required": True,
                    "description": "Target environment (e.g. 'Production', 'Staging', 'Development').",
                    "enum": ["Production", "Staging", "Development", "Test"],
                },
                "subscription_id": {
                    "type": "string",
                    "required": True,
                    "description": "Azure subscription ID associated with this security package.",
                },
                "resource_group": {
                    "type": "string",
                    "required": False,
                    "description": "Azure resource group name (optional – scopes policy data if provided).",
                },
                "compliance_summary": {
                    "type": "object",
                    "required": False,
                    "description": (
                        "Policy compliance summary object (from get_policy_compliance). "
                        "Include this to embed compliance details directly in the page."
                    ),
                },
                "additional_sections": {
                    "type": "array",
                    "required": False,
                    "description": (
                        "Array of {title, html_content} objects for extra custom sections "
                        "to include in the generated page."
                    ),
                },
                "html_content": {
                    "type": "string",
                    "required": True,
                    "description": (
                        "The full HTML content of the security package page to deploy. "
                        "This is passed to deploy_security_page. "
                        "Include a link to data.json in the footer, e.g.: "
                        "<a href=\"data.json\">View JSON</a>"
                    ),
                },
                "page_data": {
                    "type": "string",
                    "required": False,
                    "description": (
                        "A JSON string containing the structured (machine-readable) "
                        "version of this security package — metadata, compliance, "
                        "risk register, approvals, etc.  When provided it is "
                        "uploaded as data.json alongside the HTML page."
                    ),
                },
            },
        }
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
    ) -> Dict[str, Any]:
        """Deploy a Security Package HTML page to an Azure Storage static website.

        Uploads the provided HTML as ``<project_name>/index.html`` into the
        ``$web`` container, and optionally a JSON data file as
        ``<project_name>/data.json`` (structured machine-readable version).
        Seeds a root landing page if one does not exist, and upserts the
        project into ``projects.json`` so it appears on the site's project
        list.

        Args:
            project_name: URL-safe project identifier (used as folder name).
            project_display_name: Human-readable project title for the index.
            description: Short description shown in the projects list.
            owner: Project owner name or email.
            html_content: Full HTML content to deploy as the project page.
                          Should include a link to data.json, e.g.:
                          ``<a href="data.json">View JSON</a>``
            page_data: Optional JSON string containing the structured data
                       for this security package (metadata, compliance,
                       risk register, approvals, etc.).  When provided it
                       is uploaded as ``<project_name>/data.json``.

        Returns:
            A dict with success status, the URL of the deployed page, and
            the updated projects list.
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
            }

        except Exception as exc:
            logger.error(f"Failed to deploy security page: {exc}", exc_info=True)
            return {"success": False, "error": str(exc)}

    # ----------------------------------------------------------------
    # Tool 3 – Get Azure Policy compliance for the subscription
    # ----------------------------------------------------------------

    @mcp.tool
    def get_policy_compliance() -> Dict[str, Any]:
        """Retrieve Azure Policy compliance details for the configured subscriptions.

        Calls the Azure Policy Insights REST API to return a compliance
        summary including counts of compliant, non-compliant, and exempt
        resources grouped by policy assignment.

        This tool is fully deterministic — it takes no parameters. The set
        of subscriptions queried is read exclusively from the
        ``SECURITY_POLICY_ALLOWED_SUBSCRIPTIONS`` environment variable
        (comma-separated). Every subscription in that list is queried and
        its results are returned.

        Authentication is controlled by ``SECURITY_POLICY_AUTH_MODE``:
          - ``OBO`` (default): on-behalf-of the calling user.
          - ``MI``           : User-Assigned Managed Identity
                               (``SECURITY_POLICY_MI_CLIENT_ID``).

        Returns:
            A dict with a ``subscriptions`` list containing one compliance
            summary per configured subscription, suitable for embedding in
            a Security Package web page.
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
                    sub_id, management_endpoint, headers
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
