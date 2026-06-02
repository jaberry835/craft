const KEY = "spa_config";
const fields = ["backendUrl", "agentId", "tenantId", "clientId", "scope", "authority", "devToken"];
const boolFields = ["showDevViews"];
const arrayFields = ["specialistAgentIds"];

function setStatus(elId, text, cls = "") {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = text || "";
  el.className = `hint ${cls}`.trim();
}

async function load() {
  const data = await chrome.storage.local.get(KEY);
  const cfg = data[KEY] || {};
  fields.forEach((f) => {
    const el = document.getElementById(f);
    if (!el) return;
    if (el.tagName === "SELECT") {
      // For the agent dropdown, preserve the saved id as a placeholder option
      // until the user clicks "Load agents".
      if (cfg[f]) {
        const opt = document.createElement("option");
        opt.value = cfg[f];
        opt.textContent = `${cfg[f]} (saved — click Load agents to refresh)`;
        opt.selected = true;
        el.appendChild(opt);
      }
    } else {
      el.value = cfg[f] || "";
    }
  });
  boolFields.forEach((f) => {
    const el = document.getElementById(f);
    if (el) el.checked = !!cfg[f];
  });
  // Multi-select: stash saved IDs as a placeholder option per id so the user
  // can see what is currently configured before clicking Load agents.
  arrayFields.forEach((f) => {
    const el = document.getElementById(f);
    if (!el) return;
    el.innerHTML = "";
    const saved = Array.isArray(cfg[f]) ? cfg[f] : [];
    if (!saved.length) {
      const opt = document.createElement("option");
      opt.value = ""; opt.textContent = "(none — click Load agents to pick)";
      el.appendChild(opt);
    } else {
      for (const id of saved) {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = `${id} (saved — click Load agents to refresh)`;
        opt.selected = true;
        el.appendChild(opt);
      }
    }
  });
}

async function save() {
  const cfg = {};
  fields.forEach((f) => {
    const el = document.getElementById(f);
    if (!el) return;
    cfg[f] = (el.value || "").trim();
  });
  boolFields.forEach((f) => {
    const el = document.getElementById(f);
    if (el) cfg[f] = !!el.checked;
  });
  arrayFields.forEach((f) => {
    const el = document.getElementById(f);
    if (!el) return;
    cfg[f] = Array.from(el.selectedOptions)
      .map((o) => (o.value || "").trim())
      .filter(Boolean);
  });
  await chrome.storage.local.set({ [KEY]: cfg });
  // Clear any cached token so new auth settings take effect.
  await chrome.storage.session.remove("spa_token");
  setStatus("status", "  Saved.", "ok");
  setTimeout(() => setStatus("status", ""), 2000);
}

async function loadAgents() {
  // Persist current values first so background can use them.
  await save();
  setStatus("agentsStatus", "Loading agents... (you may see a sign-in popup)");
  try {
    const resp = await chrome.runtime.sendMessage({ type: "agents:list" });
    if (!resp?.ok) throw new Error(resp?.error || "Unknown error");
    const agents = resp.data?.agents || [];
    const select = document.getElementById("agentId");
    const previous = select.value;
    select.innerHTML = "";
    if (!agents.length) {
      const opt = document.createElement("option");
      opt.value = ""; opt.textContent = "(no agents found)";
      select.appendChild(opt);
    } else {
      // Sort: orchestrators first, then alphabetically.
      agents.sort((a, b) => {
        const ao = a.is_orchestrator ? 0 : 1;
        const bo = b.is_orchestrator ? 0 : 1;
        if (ao !== bo) return ao - bo;
        return (a.name || "").localeCompare(b.name || "");
      });
      const placeholder = document.createElement("option");
      placeholder.value = ""; placeholder.textContent = "-- select an agent --";
      select.appendChild(placeholder);
      for (const a of agents) {
        const opt = document.createElement("option");
        opt.value = a.id;
        const tag = a.is_orchestrator ? "★ " : "";
        const type = a.agent_type === "a2a" ? " [a2a]" : "";
        opt.textContent = `${tag}${a.name}${type} — ${a.id}`;
        select.appendChild(opt);
      }
      if (previous) select.value = previous;
    }
    // Populate the specialist multi-select with the same agent list. Exclude
    // the currently-selected primary agent so the user can't pick the same
    // agent twice. Preserve any previously-saved selection.
    const specialistEl = document.getElementById("specialistAgentIds");
    if (specialistEl) {
      const data = await chrome.storage.local.get(KEY);
      const cfg = data[KEY] || {};
      const previousSpec = new Set(
        Array.from(specialistEl.selectedOptions).map((o) => o.value).filter(Boolean)
      );
      // Also fold in any saved-but-not-yet-rendered ids from cfg.
      for (const id of cfg.specialistAgentIds || []) previousSpec.add(id);

      const primaryId = select.value;
      specialistEl.innerHTML = "";
      const eligible = agents.filter((a) => a.id && a.id !== primaryId);
      if (!eligible.length) {
        const opt = document.createElement("option");
        opt.value = ""; opt.textContent = "(no other agents available)";
        specialistEl.appendChild(opt);
      } else {
        for (const a of eligible) {
          const opt = document.createElement("option");
          opt.value = a.id;
          const tag = a.is_orchestrator ? "★ " : "";
          const type = a.agent_type === "a2a" ? " [a2a]" : "";
          opt.textContent = `${tag}${a.name}${type} — ${a.id}`;
          if (previousSpec.has(a.id)) opt.selected = true;
          specialistEl.appendChild(opt);
        }
      }
    }
    setStatus("agentsStatus", `Loaded ${agents.length} agent(s). Pick one and click Save.`, "ok");
  } catch (e) {
    setStatus("agentsStatus", `Error: ${e.message}`, "err");
  }
}

document.getElementById("save").addEventListener("click", save);
document.getElementById("loadAgents").addEventListener("click", loadAgents);
load();
