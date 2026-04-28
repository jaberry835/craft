"""
Policy compliance HTML fragment renderer.

Pure, deterministic renderer that converts the JSON returned by the
``get_policy_compliance`` MCP tool into a self-contained HTML fragment
suitable for pasting verbatim into a Security Package web page.

Why this exists
---------------
The Azure Policy Insights drill-down can produce dozens of policy rows
per assignment (e.g. ASC Default has ~63 evaluated policies, ~29
non-compliant). When the LLM is asked to render that table by hand it
self-truncates — emitting a header that promises N rows but a body that
contains only 3-5 of them. Server-side rendering guarantees every row
is present.

Output contract
---------------
``render(compliance_data) -> {"html": str, "css": str, "summary_text": str}``

* ``html``         – a ``<section class="sp-policy">…</section>`` fragment.
* ``css``          – a ``<style>`` block whose selectors are all
                     namespaced under ``.sp-policy`` so they cannot
                     leak into the surrounding page.
* ``summary_text`` – a short markdown summary the LLM may quote in its
                     executive summary (or rewrite in its own voice).

The input may be either:
  * the full tool result (``{"subscriptions": [...], ...}``), or
  * a single subscription block (``{"overall": {...}, "policy_assignments": [...]}``).
"""

from __future__ import annotations

import html as _html
from typing import Any, Dict, List


# ── Public entry point ─────────────────────────────────────────────


def render(compliance_data: Dict[str, Any]) -> Dict[str, str]:
    """Render the compliance JSON to an HTML fragment + CSS + summary."""
    subs = _normalize_subscriptions(compliance_data)
    _validate_compliance_shape(subs)

    parts: List[str] = ['<section class="sp-policy">']
    parts.append(_render_global_header(subs))
    for sub in subs:
        parts.append(_render_subscription(sub))
    parts.append("</section>")

    return {
        "html": "\n".join(parts),
        "css": _CSS,
        "summary_text": _build_summary_text(subs),
    }


# ── Validation ─────────────────────────────────────────────────────


class CompliancePayloadError(ValueError):
    """Raised when the compliance payload doesn't match the
    `get_policy_compliance` contract (renamed keys, fabricated data, etc)."""


def _validate_compliance_shape(subs: List[Dict[str, Any]]) -> None:
    """Hard-fail when the payload doesn't look like a real
    `get_policy_compliance` result. Surfaces a clear error to the LLM so
    it can re-call the tool instead of silently rendering "(Unnamed)" rows.
    """
    if not isinstance(subs, list) or not subs:
        raise CompliancePayloadError(
            "compliance payload is empty or has no 'subscriptions' / "
            "'policy_assignments' — pass the verbatim result of "
            "get_policy_compliance."
        )
    for si, sub in enumerate(subs):
        if not isinstance(sub, dict):
            raise CompliancePayloadError(
                f"subscriptions[{si}] is not an object."
            )
        assignments = sub.get("policy_assignments")
        if not isinstance(assignments, list):
            raise CompliancePayloadError(
                f"subscriptions[{si}].policy_assignments must be a list "
                f"(verbatim get_policy_compliance result). Got "
                f"{type(assignments).__name__}."
            )
        for ai, a in enumerate(assignments):
            if not isinstance(a, dict):
                raise CompliancePayloadError(
                    f"subscriptions[{si}].policy_assignments[{ai}] is not "
                    f"an object."
                )
            if "display_name" not in a:
                bad_keys = sorted(a.keys())
                raise CompliancePayloadError(
                    f"subscriptions[{si}].policy_assignments[{ai}] is "
                    f"missing 'display_name' — got keys {bad_keys}. The "
                    f"caller likely fabricated or renamed fields (e.g. "
                    f"'assignment_name' instead of 'display_name'). "
                    f"Re-call get_policy_compliance and pass its result "
                    f"through unchanged."
                )
            defs = a.get("policy_definitions")
            if defs is not None and not isinstance(defs, list):
                raise CompliancePayloadError(
                    f"subscriptions[{si}].policy_assignments[{ai}]."
                    f"policy_definitions must be a list when present."
                )
            for di, d in enumerate(defs or []):
                if not isinstance(d, dict):
                    raise CompliancePayloadError(
                        f"subscriptions[{si}].policy_assignments[{ai}]."
                        f"policy_definitions[{di}] is not an object."
                    )
                if "display_name" not in d:
                    bad_keys = sorted(d.keys())
                    raise CompliancePayloadError(
                        f"subscriptions[{si}].policy_assignments[{ai}]."
                        f"policy_definitions[{di}] is missing "
                        f"'display_name' — got keys {bad_keys}. Pass the "
                        f"verbatim get_policy_compliance result; do not "
                        f"rename keys like 'policy_definition_name'."
                    )


# ── Normalisation ──────────────────────────────────────────────────


def _normalize_subscriptions(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    if isinstance(data, dict) and "subscriptions" in data:
        return [s for s in data.get("subscriptions", []) if isinstance(s, dict)]
    if isinstance(data, dict) and ("overall" in data or "policy_assignments" in data):
        return [data]
    return []


# ── Aggregate header ───────────────────────────────────────────────


def _render_global_header(subs: List[Dict[str, Any]]) -> str:
    if not subs:
        return '<p class="sp-empty">No subscription compliance data available.</p>'

    total_resources = 0
    total_compliant = 0
    total_non_compliant = 0
    total_exempt = 0
    total_assignments = 0
    total_nc_assignments = 0
    for s in subs:
        o = s.get("overall", {}) or {}
        total_resources += int(o.get("total_resources", 0) or 0)
        total_compliant += int(o.get("compliant_resources", 0) or 0)
        total_non_compliant += int(o.get("non_compliant_resources", 0) or 0)
        total_exempt += int(o.get("exempt_resources", 0) or 0)
        total_assignments += int(o.get("total_assignments", 0) or 0)
        total_nc_assignments += int(o.get("non_compliant_assignments", 0) or 0)

    pct = round((total_compliant / total_resources) * 100, 1) if total_resources else 0.0

    return f"""
<div class="sp-overview">
  <div class="sp-donut" data-pct="{pct}">
    <div class="sp-donut-inner">
      <span class="sp-donut-pct">{pct}%</span>
      <span class="sp-donut-label">compliant</span>
    </div>
  </div>
  <dl class="sp-stats">
    <div><dt>Resources</dt><dd>{total_resources:,}</dd></div>
    <div><dt>Compliant</dt><dd class="sp-ok">{total_compliant:,}</dd></div>
    <div><dt>Non-compliant</dt><dd class="sp-bad">{total_non_compliant:,}</dd></div>
    <div><dt>Exempt</dt><dd>{total_exempt:,}</dd></div>
    <div><dt>Assignments</dt><dd>{total_assignments:,}</dd></div>
    <div><dt>Non-compliant assignments</dt><dd class="sp-bad">{total_nc_assignments:,}</dd></div>
  </dl>
</div>
""".strip()


# ── Per-subscription block ─────────────────────────────────────────


def _render_subscription(sub: Dict[str, Any]) -> str:
    sub_id = _esc(sub.get("subscription_id", ""))
    overall = sub.get("overall", {}) or {}
    assignments = sub.get("policy_assignments", []) or []

    if not sub.get("success", True):
        err = _esc(sub.get("error", "Unknown error"))
        return f'<div class="sp-sub-error"><strong>Subscription {sub_id}</strong>: {err}</div>'

    pct = overall.get("compliance_percent", 0.0)
    total = int(overall.get("total_resources", 0) or 0)
    compliant = int(overall.get("compliant_resources", 0) or 0)
    nc = int(overall.get("non_compliant_resources", 0) or 0)

    # Sort: non-compliant assignments first (most non-compliant resources first),
    # then compliant.
    def _sort_key(a):
        return (a.get("non_compliant_resources", 0) == 0, -int(a.get("non_compliant_resources", 0) or 0))
    sorted_assignments = sorted(assignments, key=_sort_key)

    body = "\n".join(_render_assignment(a) for a in sorted_assignments)

    return f"""
<div class="sp-sub">
  <h3 class="sp-sub-title">Subscription <code>{sub_id}</code></h3>
  <p class="sp-sub-summary">
    {pct}% compliant — {compliant:,} of {total:,} resources compliant,
    {nc:,} non-compliant across {len(assignments)} assignment(s).
  </p>
  <div class="sp-assignments">
    {body}
  </div>
</div>
""".strip()


# ── Per-assignment accordion ───────────────────────────────────────


def _render_assignment(a: Dict[str, Any]) -> str:
    name = _esc(a.get("display_name", "(Unnamed)"))
    scope_kind = _esc(a.get("scope_kind", ""))
    scope_name = _esc(a.get("scope_name", ""))
    inherited = bool(a.get("inherited", False))

    total_r = int(a.get("total_resources", 0) or 0)
    compliant_r = int(a.get("compliant_resources", 0) or 0)
    nc_r = int(a.get("non_compliant_resources", 0) or 0)
    exempt_r = int(a.get("exempt_resources", 0) or 0)

    total_p = int(a.get("total_policies", 0) or 0)
    nc_p = int(a.get("non_compliant_policies_count", 0) or 0)
    cp_p = int(a.get("compliant_policies_count", 0) or 0)

    badges: List[str] = []
    if scope_kind:
        badges.append(f'<span class="sp-badge sp-badge-scope">{scope_kind}{": " + scope_name if scope_name else ""}</span>')
    if inherited:
        badges.append('<span class="sp-badge sp-badge-inherited">inherited</span>')
    if nc_r > 0:
        badges.append(f'<span class="sp-badge sp-badge-bad">{nc_r} non-compliant</span>')
    else:
        badges.append('<span class="sp-badge sp-badge-ok">compliant</span>')

    state_class = "sp-assignment-bad" if nc_r > 0 else "sp-assignment-ok"
    open_attr = " open" if nc_r > 0 else ""

    defs = a.get("policy_definitions", []) or []
    nc_defs = [d for d in defs if int(d.get("non_compliant_resources", 0) or 0) > 0]
    cp_defs = [d for d in defs if int(d.get("non_compliant_resources", 0) or 0) == 0]

    nc_defs.sort(key=lambda d: -int(d.get("non_compliant_resources", 0) or 0))
    cp_defs.sort(key=lambda d: _esc(d.get("display_name", "")).lower())

    inner_parts: List[str] = []
    inner_parts.append(f"""
    <dl class="sp-assignment-stats">
      <div><dt>Resources</dt><dd>{total_r:,}</dd></div>
      <div><dt>Compliant</dt><dd class="sp-ok">{compliant_r:,}</dd></div>
      <div><dt>Non-compliant</dt><dd class="sp-bad">{nc_r:,}</dd></div>
      <div><dt>Exempt</dt><dd>{exempt_r:,}</dd></div>
      <div><dt>Policies</dt><dd>{total_p:,}</dd></div>
      <div><dt>NC policies</dt><dd class="sp-bad">{nc_p:,}</dd></div>
      <div><dt>Compliant policies</dt><dd class="sp-ok">{cp_p:,}</dd></div>
    </dl>
    """.strip())

    if nc_defs:
        inner_parts.append(f"""
    <h4 class="sp-section-title">Non-compliant policies ({len(nc_defs)})</h4>
    {_render_policy_table(nc_defs)}
        """.strip())

    if cp_defs:
        inner_parts.append(f"""
    <details class="sp-compliant-block">
      <summary>Show {len(cp_defs)} compliant polic{'y' if len(cp_defs) == 1 else 'ies'}</summary>
      {_render_policy_table(cp_defs)}
    </details>
        """.strip())

    if not defs:
        inner_parts.append('<p class="sp-empty">No policy definitions available.</p>')

    return f"""
<details class="sp-assignment {state_class}"{open_attr}>
  <summary>
    <span class="sp-assignment-name">{name}</span>
    <span class="sp-badges">{''.join(badges)}</span>
  </summary>
  <div class="sp-assignment-body">
    {chr(10).join(inner_parts)}
  </div>
</details>
""".strip()


# ── Policy definitions table ───────────────────────────────────────


def _render_policy_table(defs: List[Dict[str, Any]]) -> str:
    rows = "\n".join(_render_policy_row(d) for d in defs)
    return f"""
<table class="sp-policy-table">
  <thead>
    <tr>
      <th>Policy</th>
      <th>Category</th>
      <th>Effect</th>
      <th>State</th>
      <th class="sp-num">NC / Total</th>
      <th>Resources</th>
    </tr>
  </thead>
  <tbody>
    {rows}
  </tbody>
</table>
""".strip()


def _render_policy_row(d: Dict[str, Any]) -> str:
    name = _esc(d.get("display_name", "(Unnamed)"))
    category = _esc(d.get("category", ""))
    effect = _esc(d.get("effect", ""))
    state = _esc(d.get("compliance_state", ""))
    nc = int(d.get("non_compliant_resources", 0) or 0)
    total = int(d.get("total_resources", 0) or 0)

    state_cls = "sp-bad" if state.lower() == "noncompliant" else "sp-ok"
    name_html = name

    resources = d.get("resources", []) or []
    if resources:
        resource_html = _render_resource_sublist(resources, nc, total)
    elif nc > 0 or total > 0:
        resource_html = '<span class="sp-muted">(call with include_resources=true to drill down)</span>'
    else:
        resource_html = '<span class="sp-muted">—</span>'

    return f"""
<tr>
  <td class="sp-policy-name">{name_html}</td>
  <td>{category}</td>
  <td><code>{effect}</code></td>
  <td class="{state_cls}">{state}</td>
  <td class="sp-num">{nc:,} / {total:,}</td>
  <td class="sp-resources">{resource_html}</td>
</tr>
""".strip()


def _render_resource_sublist(resources: List[Dict[str, Any]], nc: int = 0, total: int = 0) -> str:
    items: List[str] = []
    for r in resources:
        name = _esc(r.get("resource_name", "") or r.get("resource_id", ""))
        rtype = _esc(r.get("resource_type", ""))
        rg = _esc(r.get("resource_group", ""))
        loc = _esc(r.get("resource_location", ""))
        state = _esc(r.get("compliance_state", ""))
        ts = _esc(r.get("timestamp", ""))
        state_cls = "sp-bad" if state.lower() == "noncompliant" else "sp-ok"
        meta_bits = [b for b in (rtype, rg, loc) if b]
        meta = " · ".join(meta_bits)
        items.append(
            f'<li><span class="sp-res-name">{name}</span>'
            f' <span class="{state_cls}">[{state}]</span>'
            f'<br><span class="sp-muted">{meta}{" · " + ts if ts else ""}</span></li>'
        )
    shown = len(resources)
    truncated = max(0, int(nc or 0) - shown) if nc else 0
    summary_label = f"Show {shown} resource{'s' if shown != 1 else ''}"
    if truncated > 0:
        summary_label += f" (+{truncated} more not fetched)"
    return (
        f'<details class="sp-resource-toggle">'
        f'<summary>{summary_label}</summary>'
        f'<ul class="sp-resource-list">{"".join(items)}</ul>'
        f'</details>'
    )


# ── Summary text ───────────────────────────────────────────────────


def _build_summary_text(subs: List[Dict[str, Any]]) -> str:
    if not subs:
        return "_No policy compliance data was returned._"

    total_resources = sum(int((s.get("overall") or {}).get("total_resources", 0) or 0) for s in subs)
    compliant = sum(int((s.get("overall") or {}).get("compliant_resources", 0) or 0) for s in subs)
    nc = sum(int((s.get("overall") or {}).get("non_compliant_resources", 0) or 0) for s in subs)
    pct = round((compliant / total_resources) * 100, 1) if total_resources else 0.0

    total_assignments = sum(int((s.get("overall") or {}).get("total_assignments", 0) or 0) for s in subs)
    nc_assignments = sum(int((s.get("overall") or {}).get("non_compliant_assignments", 0) or 0) for s in subs)

    # Identify the assignment contributing the most non-compliant policies.
    top_assignment = None
    top_nc_policies = -1
    for s in subs:
        for a in s.get("policy_assignments", []) or []:
            n = int(a.get("non_compliant_policies_count", 0) or 0)
            if n > top_nc_policies:
                top_nc_policies = n
                top_assignment = a

    lines = [
        f"**{pct}% compliant** — {compliant:,} of {total_resources:,} resources compliant, "
        f"{nc:,} non-compliant across {total_assignments} assignment(s) "
        f"({nc_assignments} non-compliant)."
    ]
    if top_assignment and top_nc_policies > 0:
        lines.append(
            f"Top contributor: **{top_assignment.get('display_name', '(Unnamed)')}** "
            f"with {top_nc_policies} non-compliant polic"
            f"{'y' if top_nc_policies == 1 else 'ies'} of "
            f"{int(top_assignment.get('total_policies', 0) or 0)} evaluated."
        )
    return " ".join(lines)


# ── Helpers ────────────────────────────────────────────────────────


def _esc(v: Any) -> str:
    if v is None:
        return ""
    return _html.escape(str(v), quote=True)


# ── CSS (namespaced under .sp-policy) ──────────────────────────────


_CSS = """
<style>
.sp-policy { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1f2328; background: #fff; }
.sp-policy .sp-overview { display: flex; align-items: center; gap: 2rem; padding: 1rem; border: 1px solid #d0d7de; border-radius: 6px; margin-bottom: 1rem; flex-wrap: wrap; background: #fff; color: #1f2328; }
.sp-policy .sp-donut { width: 110px; height: 110px; border-radius: 50%; background: conic-gradient(#1a7f37 calc(var(--pct) * 1%), #d1242f 0); display: flex; align-items: center; justify-content: center; position: relative; }
.sp-policy .sp-donut::before { content: ""; position: absolute; inset: 12px; background: #fff; border-radius: 50%; }
.sp-policy .sp-donut-inner { position: relative; text-align: center; line-height: 1.1; }
.sp-policy .sp-donut-pct { display: block; font-size: 1.5rem; font-weight: 700; }
.sp-policy .sp-donut-label { font-size: 0.75rem; color: #57606a; }
.sp-policy .sp-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.75rem 1.5rem; margin: 0; flex: 1 1 320px; }
.sp-policy .sp-stats > div { margin: 0; }
.sp-policy .sp-stats dt { font-size: 0.75rem; color: #57606a; text-transform: uppercase; letter-spacing: 0.04em; }
.sp-policy .sp-stats dd { margin: 0.1rem 0 0; font-size: 1.25rem; font-weight: 600; }
.sp-policy .sp-ok { color: #1a7f37; }
.sp-policy .sp-bad { color: #d1242f; }
.sp-policy .sp-muted { color: #6e7781; font-size: 0.85em; }
.sp-policy .sp-sub { margin: 1.25rem 0; }
.sp-policy .sp-sub-title { margin: 0 0 0.25rem; font-size: 1.1rem; }
.sp-policy .sp-sub-title code { background: #f6f8fa; padding: 0.1em 0.35em; border-radius: 4px; font-size: 0.85em; }
.sp-policy .sp-sub-summary { margin: 0 0 0.75rem; color: #57606a; }
.sp-policy .sp-sub-error { padding: 0.75rem 1rem; background: #ffebe9; border: 1px solid #ff818266; border-radius: 6px; margin: 0.75rem 0; }
.sp-policy .sp-assignments { display: flex; flex-direction: column; gap: 0.5rem; }
.sp-policy .sp-assignment { border: 1px solid #d0d7de; border-radius: 6px; background: #fff; }
.sp-policy .sp-assignment-bad { border-left: 4px solid #d1242f; }
.sp-policy .sp-assignment-ok { border-left: 4px solid #1a7f37; }
.sp-policy .sp-assignment > summary { padding: 0.6rem 0.8rem; cursor: pointer; display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; list-style: none; }
.sp-policy .sp-assignment > summary::-webkit-details-marker { display: none; }
.sp-policy .sp-assignment > summary::before { content: "▸"; display: inline-block; transition: transform 0.15s; color: #57606a; }
.sp-policy .sp-assignment[open] > summary::before { transform: rotate(90deg); }
.sp-policy .sp-assignment-name { font-weight: 600; flex: 1 1 auto; }
.sp-policy .sp-badges { display: inline-flex; gap: 0.35rem; flex-wrap: wrap; }
.sp-policy .sp-badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.72rem; font-weight: 600; background: #eaeef2; color: #1f2328; text-transform: uppercase; letter-spacing: 0.03em; }
.sp-policy .sp-badge-scope { background: #ddf4ff; color: #0969da; }
.sp-policy .sp-badge-inherited { background: #fff8c5; color: #7d4e00; }
.sp-policy .sp-badge-bad { background: #ffebe9; color: #d1242f; }
.sp-policy .sp-badge-ok { background: #dafbe1; color: #1a7f37; }
.sp-policy .sp-assignment-body { padding: 0 1rem 1rem; }
.sp-policy .sp-assignment-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 0.5rem 1rem; margin: 0.5rem 0 1rem; padding: 0.5rem 0; border-top: 1px solid #eaeef2; border-bottom: 1px solid #eaeef2; }
.sp-policy .sp-assignment-stats dt { font-size: 0.7rem; color: #57606a; text-transform: uppercase; }
.sp-policy .sp-assignment-stats dd { margin: 0; font-size: 1rem; font-weight: 600; }
.sp-policy .sp-section-title { margin: 0.5rem 0 0.5rem; font-size: 0.95rem; }
.sp-policy .sp-policy-table { width: 100%; border-collapse: collapse; font-size: 0.88rem; margin-bottom: 0.75rem; }
.sp-policy .sp-policy-table th, .sp-policy .sp-policy-table td { border: 1px solid #eaeef2; padding: 0.4rem 0.55rem; text-align: left; vertical-align: top; }
.sp-policy .sp-policy-table thead th { background: #f6f8fa; font-weight: 600; }
.sp-policy .sp-policy-table tbody tr:nth-child(even) { background: #fbfcfd; }
.sp-policy .sp-policy-name { max-width: 340px; }
.sp-policy .sp-refid { font-size: 0.78em; color: #57606a; background: #f6f8fa; padding: 0.05em 0.3em; border-radius: 3px; }
.sp-policy .sp-num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.sp-policy .sp-compliant-block { margin-top: 0.5rem; }
.sp-policy .sp-compliant-block > summary { cursor: pointer; padding: 0.4rem 0.6rem; background: #f6f8fa; border-radius: 4px; font-size: 0.85rem; color: #57606a; }
.sp-policy .sp-resource-list { margin: 0.4rem 0 0; padding-left: 1.1rem; font-size: 0.85em; max-height: 18rem; overflow-y: auto; }
.sp-policy .sp-resource-list li { margin-bottom: 0.3rem; }
.sp-policy .sp-res-name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.sp-policy .sp-empty { color: #57606a; font-style: italic; padding: 0.5rem 0; }
.sp-policy .sp-resources { max-width: 320px; }
.sp-policy .sp-resource-toggle > summary { cursor: pointer; color: #0969da; font-size: 0.85em; padding: 0.15rem 0; list-style: none; }
.sp-policy .sp-resource-toggle > summary::-webkit-details-marker { display: none; }
.sp-policy .sp-resource-toggle > summary::before { content: "▸"; display: inline-block; margin-right: 0.3rem; transition: transform 0.15s; color: #57606a; }
.sp-policy .sp-resource-toggle[open] > summary::before { transform: rotate(90deg); }
</style>
<script>
(function(){
  document.querySelectorAll('.sp-policy .sp-donut').forEach(function(el){
    var pct = parseFloat(el.getAttribute('data-pct')) || 0;
    el.style.setProperty('--pct', pct);
  });
})();
</script>
""".strip()
