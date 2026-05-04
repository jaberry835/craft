// sidepanel.js — UI logic for the side panel.
// Talks to the background service worker for API calls and to the content
// script for page extraction.

const $ = (sel) => document.querySelector(sel);

const log = $("#chat-log");
const status = $("#status");
const previewFrame = $("#preview-frame");
const previewEmpty = $("#preview-empty");
const previewLoading = $("#preview-loading");
const previewLoadingTitle = $("#loading-title");
const previewLoadingSub = $("#loading-sub");
const previewEmptySub = $("#preview-empty-sub");
const jsonView = $("#json-view");
const jsonEmpty = $("#json-empty");
const btnDownloadHtml = $("#btn-download-html");
const btnDeploy = $("#btn-deploy");
const btnCopyJson = $("#btn-copy-json");
const btnDownloadJson = $("#btn-download-json");
const btnRegenerate = $("#btn-regenerate");
const btnGeneratePreview = $("#btn-generate-preview");
const regenerateLabel = $("#regenerate-label");
const agentNameEl = $("#agent-name");

let lastHtml = null;
let lastJson = null;
let lastPage = null;     // most recent { url, page_title, section, ... }
let lastFields = null;   // most recent extracted fields array
let lastGenerationAt = null; // ISO timestamp when the agent last produced an artifact
let generationInFlight = false;
// Wizard accumulator: merges fields across step navigations, keyed by
// origin+pathname so different wizards don't collide. Persists in
// chrome.storage.session for the lifetime of the browser session.
let wizardKey = null;
let wizardData = { key: null, fields: [], steps: [], updated_at: null };
const sourceState = { preview: "agent", json: "agent" };
let showDevViews = false;

// Read the "Show developer views" preference and apply it. Hides the Agent
// /Page/Wizard source toggles unless the user has explicitly enabled them in
// the Options page. Default state is Agent-only since the page/wizard views
// are debugging aids that confuse end users.
async function applyDevViewsPref() {
  try {
    const { spa_config } = await chrome.storage.local.get("spa_config");
    showDevViews = !!spa_config?.showDevViews;
  } catch { showDevViews = false; }
  document.querySelectorAll(".source-toggle").forEach((g) => { g.hidden = !showDevViews; });
  if (!showDevViews) {
    sourceState.preview = "agent";
    sourceState.json    = "agent";
    document.querySelectorAll(".source-toggle .src").forEach((b) => {
      b.classList.toggle("active", b.dataset.src === "agent");
    });
  }
  refreshArtifactView();
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.spa_config) applyDevViewsPref();
});

// --- Tab switching ---
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === btn));
    const target = btn.dataset.tab;
    document.querySelectorAll(".tab-pane").forEach((p) => p.classList.toggle("active", p.id === `tab-${target}`));
    if (target === "preview" || target === "json") refreshArtifactView();
  });
});

$("#open-options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

$("#reset-wizard").addEventListener("click", async (e) => {
  e.preventDefault();
  await resetWizard();
  setStatus("Wizard data cleared.");
});

// --- Helpers ---
function appendMessage(role, body) {
  // Hide the empty-state hero on first message.
  const empty = document.getElementById("empty-state");
  if (empty) empty.remove();

  const wrap = document.createElement("div");
  wrap.className = `chat-msg ${role}`;
  const r = document.createElement("div"); r.className = "role"; r.textContent = role;
  const b = document.createElement("div"); b.className = "body"; b.textContent = body;
  wrap.append(r, b);
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
}

// Suggestion cards: either trigger a header button by id, or perform a named action.
document.addEventListener("click", (e) => {
  const card = e.target.closest(".suggest-card");
  if (!card) return;
  if (card.dataset.trigger) {
    const btn = document.getElementById(card.dataset.trigger);
    if (btn) btn.click();
  } else if (card.dataset.action === "open-preview") {
    document.querySelector('.tab[data-tab="preview"]').click();
  }
});

function setStatus(text, isError = false) {
  status.textContent = text || "";
  status.style.color = isError ? "#ff8888" : "";
}

function setPreview(html) {
  lastHtml = html || null;
  renderPreview();
}

function setJson(data) {
  lastJson = data ?? null;
  renderJson();
}

// Build a small standalone HTML page from extracted fields (used when the
// agent hasn't produced an html_preview yet, or when the user toggles to
// "Page fields").
function buildPagePreviewHtml(page, fields) {
  if (!fields || !fields.length) {
    return `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:24px;color:#57606a"><p><em>No fields extracted from the current page yet. Click <b>Explain page</b> or <b>Generate package</b>.</em></p></body>`;
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (v) => {
    if (v === null || v === undefined || v === "") return `<em style="color:#57606a">— not provided —</em>`;
    if (typeof v === "boolean") return v ? "Yes" : "No";
    if (Array.isArray(v)) return v.map(esc).join(", ");
    return esc(v);
  };
  const rows = fields.map((f) => {
    const reqPill = f.required && (f.value == null || f.value === "")
      ? ` <span style="display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;background:#ffebe9;color:#cf222e">required</span>` : "";
    return `<dt>${esc(f.label || f.name || "(unnamed)")}</dt><dd>${fmt(f.value)}${reqPill}</dd>`;
  }).join("\n");
  const title = esc(page?.page_title || page?.section || "Current page");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:-apple-system,"Segoe UI",system-ui,sans-serif;color:#1f2328;background:#fff;margin:0;padding:24px;line-height:1.5}
    h1{font-size:18px;margin:0 0 4px}.sub{color:#57606a;font-size:12px;margin:0 0 16px}
    .card{background:#f6f8fa;border:1px solid #d0d7de;border-radius:8px;padding:16px}
    dl{display:grid;grid-template-columns:max-content 1fr;gap:8px 16px;margin:0}
    dt{color:#57606a;font-weight:500}dd{margin:0;word-break:break-word}
  </style></head><body><h1>Page fields</h1><p class="sub">${title}</p><div class="card"><dl>${rows}</dl></div></body></html>`;
}

function renderPreview() {
  const src = sourceState.preview;
  let html, hasContent;
  if (src === "agent") {
    hasContent = !!lastHtml;
    html = lastHtml;
  } else if (src === "wizard") {
    hasContent = wizardData.fields.length > 0;
    html = buildPagePreviewHtml(
      { page_title: `Wizard: ${wizardData.key || "current"}`, section: `${wizardData.fields.length} fields across ${wizardData.steps.length} step(s)` },
      wizardData.fields);
  } else {
    hasContent = !!(lastFields && lastFields.length);
    html = buildPagePreviewHtml(lastPage, lastFields);
  }

  // While the agent is generating, the loading overlay takes precedence;
  // hide both the empty state and the iframe.
  if (generationInFlight && src === "agent") {
    if (previewEmpty)   previewEmpty.hidden   = true;
    if (previewLoading) previewLoading.hidden = false;
    previewFrame.hidden = true;
  } else {
    if (previewLoading) previewLoading.hidden = true;
    // Only the Agent source uses the empty-state placeholder; the Page and
    // Wizard sources are extension-side renderings and always have something
    // (or a friendly "no fields yet" message) to show.
    const showEmpty = (src === "agent" && !hasContent);
    if (previewEmpty) previewEmpty.hidden = !showEmpty;
    previewFrame.hidden = showEmpty;
    if (!showEmpty) previewFrame.srcdoc = html;

    if (showEmpty && previewEmptySub) {
      previewEmptySub.textContent = wizardData.fields.length
        ? `You've collected ${wizardData.fields.length} fields across ${wizardData.steps.length} step(s). Ready to generate the preview.`
        : "Fill out a step or two of the wizard, then generate a preview.";
    }
  }

  btnDownloadHtml.disabled = !hasContent || generationInFlight;
  // Deploy is only meaningful for the agent-rendered preview; the page /
  // wizard fallback views are extension-side renderings, not approved HTML.
  btnDeploy.disabled = !lastHtml || generationInFlight;

  // Show the Regenerate button as soon as we have an agent artifact.
  if (btnRegenerate) {
    btnRegenerate.hidden = !lastHtml;
    btnRegenerate.disabled = generationInFlight;
    const stale = isArtifactStale();
    btnRegenerate.classList.toggle("stale", stale && !generationInFlight);
    btnRegenerate.title = generationInFlight
      ? "Generating…"
      : (stale ? "Wizard data has changed since this preview was generated."
               : "Regenerate the package preview from current wizard data");
    if (generationInFlight) {
      regenerateLabel.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span>Generating…`;
    } else {
      regenerateLabel.innerHTML = stale
        ? `Regenerate <span class="stale-dot" aria-hidden="true"></span>`
        : "Regenerate";
    }
  }
}

function renderJson() {
  const src = sourceState.json;
  let data, hasContent;
  if (src === "agent")        { data = lastJson;                                    hasContent = lastJson != null; }
  else if (src === "wizard")  { data = wizardData;                                  hasContent = wizardData.fields.length > 0; }
  else                        { data = { page: lastPage, fields: lastFields };      hasContent = !!lastFields; }

  const showEmpty = (src === "agent" && !hasContent);
  if (jsonEmpty) jsonEmpty.hidden = !showEmpty;
  jsonView.hidden = showEmpty;
  jsonView.textContent = (!showEmpty && hasContent) ? JSON.stringify(data, null, 2) : "";

  btnCopyJson.disabled = !hasContent;
  btnDownloadJson.disabled = !hasContent;
}

// Returns true when the wizard accumulator has been updated since the agent
// last produced an artifact, so the preview is potentially out of date.
function isArtifactStale() {
  if (!lastGenerationAt || !wizardData.updated_at) return false;
  return wizardData.updated_at > lastGenerationAt;
}

// Re-render whichever artifact tab the user is currently viewing. Called
// after tab switches and after wizard mutations.
function refreshArtifactView() {
  const active = document.querySelector(".tab.active")?.dataset.tab;
  if (active === "preview") renderPreview();
  else if (active === "json") renderJson();
}

// Source toggle wiring (Agent / Page fields).
document.querySelectorAll(".source-toggle").forEach((group) => {
  group.querySelectorAll(".src").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.target; // "preview" | "json"
      group.querySelectorAll(".src").forEach((b) => b.classList.toggle("active", b === btn));
      sourceState[target] = btn.dataset.src;
      if (target === "preview") renderPreview();
      else renderJson();
    });
  });
});

function downloadBlob(filename, mime, content) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

btnDownloadHtml.addEventListener("click", () => lastHtml && downloadBlob("security-package.html", "text/html", lastHtml));
btnDownloadJson.addEventListener("click", () => lastJson && downloadBlob("security-package.json", "application/json", JSON.stringify(lastJson, null, 2)));
btnCopyJson.addEventListener("click", () => lastJson && navigator.clipboard.writeText(JSON.stringify(lastJson, null, 2)));

// Slugify a string for use as a deploy project_name.
function slugify(s) {
  return String(s || "").toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "package";
}

// Pull a likely value out of the wizard accumulator by label substring.
function wizardFieldByLabel(re) {
  for (const f of wizardData.fields || []) {
    if (re.test(f.label || "") && f.value != null && f.value !== "") return f.value;
  }
  return undefined;
}

// Transform the agent's preview HTML into something fit for publishing.
// The agent's template is optimized for the side-panel review surface
// (small, debug-y `filled` pills, "— not provided —" placeholders, the
// "Missing Required" section, etc.). For the deployed page we want a
// cleaner, more presentable Application Details card.
//
// We do this client-side rather than re-prompting the agent so the same
// generation can power both the in-panel review and the published page,
// and so users see exactly what they approved.
function prepareHtmlForPublish(html, meta = {}) {
  if (!html) return html;
  let out = html;

  // 1. Remove the "filled" indicator pills — they're useful while reviewing
  //    in the panel, noise on a published page.
  out = out.replace(/\s*<span class="pill ok">filled<\/span>/gi, "");

  // 2. Drop dt/dd pairs whose value is the "— not provided —" placeholder.
  //    On a published page, an empty row reads as a gap, not a value.
  out = out.replace(
    /<dt>[^<]*<\/dt>\s*<dd class="empty">[^<]*<\/dd>/gi,
    "",
  );

  // 3. Drop the "Missing Required" section entirely if it just says "None".
  out = out.replace(
    /<section class="card">\s*<h2>\s*Missing Required\s*<\/h2>\s*<p class="empty">[^<]*None[^<]*<\/p>\s*<\/section>/gi,
    "",
  );

  // 4. Rename the page title / header to use the user's chosen display name.
  if (meta.display) {
    const safe = meta.display
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    out = out.replace(/<title>[^<]*<\/title>/i, `<title>Security Package — ${safe}</title>`);
    out = out.replace(/<h1>[^<]*<\/h1>/i, `<h1>${safe}</h1>`);
    // Replace the "generated from values entered on the wizard" subtitle.
    out = out.replace(
      /<p class="subtitle">[^<]*<\/p>/i,
      `<p class="subtitle">Application Security Package${meta.owner ? ` · Owner: ${meta.owner.replace(/[<>&]/g, "")}` : ""}</p>`,
    );
  }

  // 5. Rename the "Collected Fields" section so it reads as a real summary.
  out = out.replace(/(<h2>)\s*Collected Fields\s*(<\/h2>)/i, "$1Application Details$2");

  return out;
}

// ---- Deploy modal -----------------------------------------------------
const deployModal      = $("#deploy-modal");
const deployProject    = $("#deploy-project");
const deployDisplay    = $("#deploy-display");
const deployOwner      = $("#deploy-owner");
const deployDescription= $("#deploy-description");
const deployModalError = $("#deploy-modal-error");
const deployConfirmBtn = $("#deploy-confirm");
const deployCancelBtn  = $("#deploy-cancel");
const deployCloseBtn   = $("#deploy-modal-close");

// Deploy result banner
const deployBanner       = $("#deploy-banner");
const deployBannerTitle  = $("#deploy-banner-title");
const deployBannerSub    = $("#deploy-banner-sub");
const deployBannerLink   = $("#deploy-banner-link");
const deployBannerCopy   = $("#deploy-banner-copy");
const deployBannerDismiss= $("#deploy-banner-dismiss");

function openDeployModal() {
  if (!lastHtml) { setStatus("No agent-approved preview to deploy.", true); return; }
  // Pre-fill from the wizard accumulator.
  const appName = wizardFieldByLabel(/application name|app name|^name$/i) || "";
  const owner   = wizardFieldByLabel(/owner.*email|email/i) || "";
  const desc    = wizardFieldByLabel(/description|justification/i) || "";
  deployProject.value     = slugify(appName);
  deployDisplay.value     = appName || deployProject.value;
  deployOwner.value       = owner;
  deployDescription.value = desc;
  deployModalError.hidden = true;
  deployConfirmBtn.disabled = false;
  deployConfirmBtn.textContent = "Deploy";
  deployModal.hidden = false;
  setTimeout(() => deployProject.focus(), 0);
}

function closeDeployModal() { deployModal.hidden = true; }

deployCancelBtn.addEventListener("click", closeDeployModal);
deployCloseBtn.addEventListener("click", closeDeployModal);
deployModal.addEventListener("click", (e) => {
  if (e.target === deployModal) closeDeployModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !deployModal.hidden) closeDeployModal();
});

function showDeployBanner({ ok, url, project, message }) {
  deployBanner.classList.toggle("error", !ok);
  deployBannerTitle.textContent = ok ? `Deployed '${project}'` : "Deploy failed";
  deployBannerSub.textContent   = message || (url ? url : "");
  deployBannerSub.title         = url || "";
  if (ok && url) {
    deployBannerLink.href   = url;
    deployBannerLink.hidden = false;
    deployBannerCopy.hidden = false;
    deployBannerCopy.onclick = () => navigator.clipboard.writeText(url);
  } else {
    deployBannerLink.hidden = true;
    deployBannerCopy.hidden = true;
  }
  deployBanner.hidden = false;
  // Make sure the user is on the Preview tab so the banner is visible.
  document.querySelector('.tab[data-tab="preview"]').click();
}
deployBannerDismiss.addEventListener("click", () => { deployBanner.hidden = true; });

deployConfirmBtn.addEventListener("click", async () => {
  const project = slugify(deployProject.value.trim());
  if (!project || project === "package") {
    deployModalError.textContent = "Project slug is required.";
    deployModalError.hidden = false;
    deployProject.focus();
    return;
  }
  const display = (deployDisplay.value || "").trim() || project;
  const owner   = (deployOwner.value   || "").trim();
  const desc    = (deployDescription.value || "").trim();

  deployConfirmBtn.disabled = true;
  deployConfirmBtn.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span>Deploying…`;
  deployModalError.hidden = true;
  setStatus(`Deploying '${project}'…`);
  appendMessage("user", `Deploy package as '${project}'`);

  try {
    const data = await sendBg("assist:deploy", {
      html_content: prepareHtmlForPublish(lastHtml, { display, owner, description: desc }),
      project_name: project,
      display_name: display,
      description:  desc,
      owner:        owner,
      wizard:       wizardSnapshot(),
    });
    showAssistResponse(data);
    const url      = data?.json_data?.url || null;
    const deployed = data?.json_data?.deployed === true || !!url;
    closeDeployModal();
    if (deployed) {
      showDeployBanner({ ok: true, url, project, message: url || "Deployment complete." });
      setStatus(url ? `Deployed to ${url}` : "Deployed.");
    } else {
      const errs = data?.json_data?.errors || [];
      showDeployBanner({ ok: false, project, message: errs[0] || "The agent reported a failure. See chat for details." });
      setStatus("Deploy failed.", true);
    }
  } catch (e) {
    deployConfirmBtn.disabled = false;
    deployConfirmBtn.textContent = "Deploy";
    deployModalError.textContent = e.message || String(e);
    deployModalError.hidden = false;
    setStatus("Deploy failed.", true);
  }
});

btnDeploy.addEventListener("click", openDeployModal);

// --- Background / content-script bridges ---
async function sendBg(type, payload) {
  const resp = await chrome.runtime.sendMessage({ type, payload });
  if (!resp?.ok) throw new Error(resp?.error || "Background call failed");
  return resp.data;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Inject the content script into the active tab on demand. The activeTab
// permission grants this for the current user gesture, so the extension
// works on whatever site the user is currently viewing without any
// pre-declared host list. Restricted URLs (chrome://, edge://, the Web
// Store, etc.) will throw — we surface a friendly error in that case.
async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content_script.js"],
    });
    __spaInjectedTabId = tabId;
  } catch (e) {
    throw new Error(
      "Can't read this page. Switch to the tab with the form (some browser-internal pages are off-limits)."
    );
  }
}

// Track the last tab where we successfully injected so we can re-inject
// silently after a full-page navigation. activeTab permission persists for
// the same tab as long as the user has a granted gesture for it; if the
// re-inject fails (e.g. user navigated to a different host), we just stop
// auto-capturing until they click an action again.
let __spaInjectedTabId = null;
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId !== __spaInjectedTabId) return;
  if (info.status !== "complete") return;
  chrome.scripting.executeScript({ target: { tabId }, files: ["content_script.js"] })
    .catch(() => { __spaInjectedTabId = null; });
});

async function sendTab(type, extra = {}) {
  const tab = await activeTab();
  if (!tab?.id) throw new Error("No active tab");
  await ensureContentScript(tab.id);
  const resp = await chrome.tabs.sendMessage(tab.id, { type, ...extra });
  if (!resp?.ok) throw new Error(resp?.error || "Content script call failed");
  // Cache page extractions so the Preview/JSON tabs always have something
  // to show even when the agent hasn't returned structured output.
  if (type === "page:extract" && resp.data) {
    lastPage = resp.data.page || null;
    lastFields = resp.data.fields || [];
    await mergeIntoWizard(lastPage, lastFields);
    renderPreview();
    renderJson();
    updateWizardCounter();
  }
  return resp.data;
}

// Compute a stable wizard key. We use ORIGIN ONLY so a multi-page wizard that
// navigates across paths (e.g. /wizard/step1 → /wizard/step2) shares one
// accumulator. Single-page apps and hash-based steppers naturally share an
// origin too. This keeps "everything the user has filled out on this site"
// in one bucket regardless of how the wizard is implemented.
function wizardKeyFor(page) {
  if (!page?.url) return null;
  try { return new URL(page.url).origin; }
  catch { return null; }
}

async function loadWizardForKey(key) {
  if (!key) { wizardData = { key: null, fields: [], steps: [], updated_at: null }; return; }
  const stored = await chrome.storage.session.get([`wiz:${key}`]);
  wizardData = stored[`wiz:${key}`] || { key, fields: [], steps: [], updated_at: null };
  wizardData.key = key;
}

async function persistWizard() {
  if (!wizardData.key) return;
  wizardData.updated_at = new Date().toISOString();
  await chrome.storage.session.set({ [`wiz:${wizardData.key}`]: wizardData });
}

async function mergeIntoWizard(page, fields) {
  const key = wizardKeyFor(page);
  if (!key) return;
  if (key !== wizardKey) { wizardKey = key; await loadWizardForKey(key); }
  // Merge fields by (name || label). Newer values win.
  const idx = new Map(wizardData.fields.map((f, i) => [f.name || f.label, i]));
  for (const f of (fields || [])) {
    const k = f.name || f.label;
    const enriched = { ...f, _step: page?.section || page?.page_title || null };
    if (idx.has(k)) wizardData.fields[idx.get(k)] = enriched;
    else            { wizardData.fields.push(enriched); idx.set(k, wizardData.fields.length - 1); }
  }
  // Track which steps we've seen.
  const stepLabel = page?.section || page?.page_title;
  if (stepLabel && !wizardData.steps.includes(stepLabel)) wizardData.steps.push(stepLabel);
  await persistWizard();
}

function updateWizardCounter() {
  const el = document.getElementById("wizard-counter");
  if (!el) return;
  if (wizardData.fields.length === 0) { el.textContent = ""; return; }
  el.textContent = `${wizardData.fields.length} fields · ${wizardData.steps.length} step(s)`;
}

async function resetWizard() {
  if (!wizardKey) return;
  await chrome.storage.session.remove([`wiz:${wizardKey}`]);
  wizardData = { key: wizardKey, fields: [], steps: [], updated_at: null };
  updateWizardCounter();
  renderPreview(); renderJson();
}

// Snapshot of the wizard state suitable for sending to the backend. Returns
// undefined when nothing has been accumulated yet so we don't burn tokens on
// an empty wizard payload.
function wizardSnapshot() {
  if (!wizardData.fields.length) return undefined;
  return {
    key: wizardData.key,
    steps: wizardData.steps,
    fields: wizardData.fields,
  };
}

function showAssistResponse(data) {
  if (data.agent_name) agentNameEl.textContent = data.agent_name;
  appendMessage("assistant", data.text || "(no text)");
  // Surface confidence + citations as small chips under the bubble so the
  // user gets the grounding signal without having to open the JSON tab.
  const j = data.json_data;
  if (j && (j.confidence || (Array.isArray(j.citations) && j.citations.length))) {
    const lastBody = log.lastElementChild?.querySelector(".body");
    if (lastBody) {
      const meta = document.createElement("div");
      meta.className = "msg-meta";
      if (j.confidence) {
        const chip = document.createElement("span");
        chip.className = `chip confidence ${String(j.confidence).toLowerCase()}`;
        chip.textContent = `confidence: ${j.confidence}`;
        meta.appendChild(chip);
      }
      if (Array.isArray(j.citations) && j.citations.length) {
        for (const c of j.citations.slice(0, 4)) {
          const chip = document.createElement("span");
          chip.className = "chip citation";
          chip.textContent = String(c);
          chip.title = String(c);
          meta.appendChild(chip);
        }
      }
      lastBody.appendChild(meta);
    }
  }
  if (data.html) setPreview(data.html);
  if (data.json_data !== undefined && data.json_data !== null) setJson(data.json_data);
}

// --- Button handlers ---
$("#btn-explain").addEventListener("click", async () => {
  try {
    setStatus("Reading page...");
    const { page, fields } = await sendTab("page:extract");
    appendMessage("user", `Explain page: ${page.page_title || page.url || ""}`);
    setStatus("Asking agent...");
    const data = await sendBg("assist:explain-page", { page, fields, wizard: wizardSnapshot() });
    showAssistResponse(data);
    setStatus("");
  } catch (e) { setStatus(e.message, true); }
});

$("#btn-suggest").addEventListener("click", async () => {
  try {
    setStatus("Inspecting focused field...");
    const field = await sendTab("page:focused-field");
    if (!field) { setStatus("Click into a form field first.", true); return; }
    const { page } = await sendTab("page:extract");
    appendMessage("user", `Suggest value for: ${field.label}`);
    setStatus("Asking agent...");
    const data = await sendBg("assist:suggest-field", { page, field, wizard: wizardSnapshot() });
    showAssistResponse(data);
    setStatus("");

    // Offer one-click insert if we got a structured suggestion.
    const suggestion = data.json_data?.suggestion;
    if (suggestion != null) {
      const btn = document.createElement("button");
      btn.textContent = `Insert "${String(suggestion).slice(0, 40)}" into "${field.label}"`;
      btn.style.marginTop = "6px";
      btn.addEventListener("click", async () => {
        try {
          await sendTab("page:apply-suggestion", { target: field, suggestion });
          setStatus("Inserted.");
        } catch (err) { setStatus(err.message, true); }
      });
      log.lastElementChild.appendChild(btn);
    }
  } catch (e) { setStatus(e.message, true); }
});

// Generate (or regenerate) the package preview. Used by the empty-state
// button on the Preview tab and by the Regenerate button in the toolbar.
async function generatePackage() {
  if (generationInFlight) return;
  // Make sure the user sees the loading state immediately even if they
  // triggered this from the Chat tab (e.g. a suggestion card).
  document.querySelector('.tab[data-tab="preview"]').click();
  generationInFlight = true;
  if (btnGeneratePreview) btnGeneratePreview.disabled = true;
  if (previewLoadingTitle) previewLoadingTitle.textContent = "Generating preview…";
  if (previewLoadingSub)   previewLoadingSub.textContent   = "Asking the agent to assemble your security package.";
  refreshArtifactView();
  try {
    setStatus("Collecting fields...");
    let page = lastPage;
    try { ({ page } = await sendTab("page:extract")); } catch (_) { /* page may be unreachable */ }
    const allFields = wizardData.fields.length ? wizardData.fields : (lastFields || []);
    if (!allFields.length) {
      setStatus("No fields collected yet — fill out a wizard step first.", true);
      return;
    }
    // Order fields by the step they were first captured on, then by the
    // order within the step. Without this, fields appear in the order
    // they were first *seen* by the extractor (which can be out of order
    // if the user revisits earlier steps or passive snapshots fire late).
    const stepOrder = new Map(wizardData.steps.map((s, i) => [s, i]));
    const orderedFields = allFields
      .map((f, i) => ({ f, i, s: stepOrder.has(f._step) ? stepOrder.get(f._step) : Number.MAX_SAFE_INTEGER }))
      .sort((a, b) => (a.s - b.s) || (a.i - b.i))
      .map((x) => x.f);
    appendMessage("user", `Generate security package (${allFields.length} fields across ${wizardData.steps.length || 1} step(s))`);
    if (previewLoadingSub) previewLoadingSub.textContent =
      `Sending ${allFields.length} fields across ${wizardData.steps.length || 1} step(s) to the agent…`;
    setStatus("Asking agent (this can take a moment)...");
    const data = await sendBg("assist:build-package", {
      page,
      collected_fields: orderedFields,
      wizard: wizardSnapshot(),
      app_metadata: {
        source: "extension",
        url: page?.url,
        wizard_key: wizardData.key,
        steps_visited: wizardData.steps,
      },
    });
    showAssistResponse(data);
    if (data.html || data.json_data) {
      lastGenerationAt = new Date().toISOString();
    }
    setStatus("");
  } catch (e) { setStatus(e.message, true); }
  finally {
    generationInFlight = false;
    if (btnGeneratePreview) btnGeneratePreview.disabled = false;
    refreshArtifactView();
  }
}

btnGeneratePreview?.addEventListener("click", generatePackage);
btnRegenerate?.addEventListener("click", generatePackage);

// --- Free-text chat ---
$("#chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#chat-input");
  const question = input.value.trim();
  if (!question) return;
  input.value = "";
  appendMessage("user", question);
  setStatus("Asking agent...");
  try {
    const includePage = $("#include-page").checked;
    let payload;
    if (includePage) {
      // Try to attach page context; if the active tab can't be read (e.g. an
      // edge:// page), fall back to question-only.
      try {
        const { page, fields } = await sendTab("page:extract");
        payload = { page, fields, question, wizard: wizardSnapshot() };
      } catch (_) {
        payload = { question, wizard: wizardSnapshot() };
      }
    } else {
      payload = { question };
    }
    const data = await sendBg("assist:ask", payload);
    showAssistResponse(data);
    setStatus("");
  } catch (err) { setStatus(err.message, true); }
});

// Allow Ctrl/Cmd+Enter to submit from the textarea.
$("#chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    $("#chat-form").requestSubmit();
  }
});

// Apply the developer-views preference on first load.
applyDevViewsPref();

// Listen for proactive snapshots pushed by the content script so the wizard
// accumulator stays current even when the user never clicks Explain / Suggest
// / Generate. The content script broadcasts on input/blur, URL changes
// (popstate, hashchange, pushState), and SPA DOM swaps, debounced.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "wizard:step-snapshot") return;
  const page = msg.page, fields = msg.fields || [];
  if (!fields.length) return;
  lastPage = page || lastPage;
  lastFields = fields;
  mergeIntoWizard(page, fields).then(() => {
    updateWizardCounter();
    // Only refresh the artifact view if the user is looking at the
    // page/wizard source toggles; the agent-rendered preview is unchanged.
    if (sourceState.preview !== "agent" || sourceState.json !== "agent") {
      renderPreview(); renderJson();
    }
  });
});
