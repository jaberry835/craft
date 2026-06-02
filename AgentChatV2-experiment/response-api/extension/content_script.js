// content_script.js — injected on demand by the side panel via
// chrome.scripting.executeScript whenever the user clicks an action button.
// The activeTab permission grants temporary access to the current tab on
// each user gesture, so no host_permissions for arbitrary sites are needed.
//
// On request from the side panel, scans the current page for form fields and
// returns a structured PageContext + list of PageFields. We deliberately do
// NOT ship raw HTML; only labels, names, types, current values, options,
// help text, and validation messages.
//
// Idempotent: re-injection on each click would otherwise register duplicate
// listeners. We guard with a window-scoped flag.
if (window.__spaContentScriptLoaded) {
  // already initialized in this page; do nothing.
} else {
  window.__spaContentScriptLoaded = true;

function visibleText(el) {
  if (!el) return "";
  return (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
}

function findLabelFor(input) {
  // 1. <label for="id">
  if (input.id) {
    const lab = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
    if (lab) return visibleText(lab);
  }
  // 2. wrapping <label>
  const wrap = input.closest("label");
  if (wrap) return visibleText(wrap);
  // 3. aria-label / aria-labelledby
  if (input.getAttribute("aria-label")) return input.getAttribute("aria-label").trim();
  const labelledBy = input.getAttribute("aria-labelledby");
  if (labelledBy) {
    const ids = labelledBy.split(/\s+/);
    const txt = ids.map((id) => visibleText(document.getElementById(id))).filter(Boolean).join(" ");
    if (txt) return txt;
  }
  // 4. nearest preceding heading or sibling text
  const prev = input.previousElementSibling;
  if (prev && /^(label|span|div|p|h[1-6])$/i.test(prev.tagName)) {
    return visibleText(prev);
  }
  return input.placeholder || input.name || input.id || "(unlabeled)";
}

function findHelpText(input) {
  const describedBy = input.getAttribute("aria-describedby");
  if (describedBy) {
    const txt = describedBy.split(/\s+/).map((id) => visibleText(document.getElementById(id))).filter(Boolean).join(" ");
    if (txt) return txt;
  }
  // Common pattern: a sibling .help / .hint / .description node.
  const sibling = input.parentElement?.querySelector(".help, .hint, .description, .help-text");
  if (sibling && sibling !== input) return visibleText(sibling);
  return undefined;
}

function findValidationMessage(input) {
  if (input.validationMessage) return input.validationMessage;
  const sibling = input.parentElement?.querySelector(".error, .invalid-feedback, [role='alert']");
  if (sibling) return visibleText(sibling) || undefined;
  return undefined;
}

function getOptions(input) {
  if (input.tagName === "SELECT") {
    return Array.from(input.options).map((o) => o.label || o.value).filter(Boolean);
  }
  if (input.type === "radio" && input.name) {
    const radios = document.querySelectorAll(`input[type='radio'][name='${CSS.escape(input.name)}']`);
    return Array.from(radios).map((r) => findLabelFor(r));
  }
  return undefined;
}

function isVisible(el) {
  if (!el || !el.getClientRects().length) return false;
  const style = window.getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden";
}

function extractFields() {
  const inputs = document.querySelectorAll("input, select, textarea");
  const seenRadioGroups = new Set();
  const fields = [];
  inputs.forEach((el) => {
    if (!isVisible(el)) return;
    if (el.type === "hidden" || el.type === "submit" || el.type === "button") return;
    if (el.type === "radio") {
      if (seenRadioGroups.has(el.name)) return;
      seenRadioGroups.add(el.name);
    }
    fields.push({
      label: findLabelFor(el),
      name: el.name || el.id || undefined,
      type: el.type || el.tagName.toLowerCase(),
      value: el.type === "checkbox" ? el.checked : (el.value ?? undefined),
      options: getOptions(el),
      required: el.required || el.getAttribute("aria-required") === "true",
      help_text: findHelpText(el),
      validation_message: findValidationMessage(el),
    });
  });
  return fields;
}

function extractPageContext() {
  // Try to identify a wizard step via common patterns.
  const stepEl = document.querySelector("[class*='step'][class*='active'], [aria-current='step'], .wizard-step.active");
  const heading = document.querySelector("h1, h2");
  return {
    url: location.href,
    page_title: document.title,
    section: stepEl ? visibleText(stepEl) : (heading ? visibleText(heading) : undefined),
    summary: heading ? visibleText(heading) : undefined,
  };
}

function describeFocusedField() {
  const el = document.activeElement;
  if (!el || !(el.matches && el.matches("input, select, textarea"))) return null;
  return {
    label: findLabelFor(el),
    name: el.name || el.id || undefined,
    type: el.type || el.tagName.toLowerCase(),
    value: el.type === "checkbox" ? el.checked : (el.value ?? undefined),
    options: getOptions(el),
    required: el.required || el.getAttribute("aria-required") === "true",
    help_text: findHelpText(el),
    validation_message: findValidationMessage(el),
  };
}

function applySuggestion(target, suggestion) {
  // Very conservative: only fill text-like inputs and selects by visible label
  // match. Will not click buttons or submit forms.
  const inputs = document.querySelectorAll("input, select, textarea");
  for (const el of inputs) {
    if (!isVisible(el)) continue;
    if (target.name && (el.name === target.name || el.id === target.name)) {
      setValue(el, suggestion);
      return true;
    }
  }
  for (const el of inputs) {
    if (!isVisible(el)) continue;
    if (findLabelFor(el) === target.label) {
      setValue(el, suggestion);
      return true;
    }
  }
  return false;
}

function setValue(el, value) {
  if (el.tagName === "SELECT") {
    const match = Array.from(el.options).find((o) => (o.label || o.value) === value || o.value === value);
    if (match) el.value = match.value;
  } else if (el.type === "checkbox") {
    el.checked = !!value;
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case "page:ping":
      sendResponse({ ok: true, data: { loaded: true } });
      return;
    case "page:extract":
      sendResponse({ ok: true, data: { page: extractPageContext(), fields: extractFields() } });
      return; // sync
    case "page:focused-field":
      sendResponse({ ok: true, data: describeFocusedField() });
      return;
    case "page:apply-suggestion":
      sendResponse({ ok: applySuggestion(msg.target, msg.suggestion) });
      return;
    default:
      sendResponse({ ok: false, error: `Unknown content-script message: ${msg?.type}` });
  }
});

// ---------------------------------------------------------------------------
// Passive auto-capture
// ---------------------------------------------------------------------------
// The side panel can only see what we've extracted. To make the Preview/JSON
// tabs reflect EVERY step the user has filled out — across multi-page wizards
// (path changes), single-page apps (DOM swaps), and hash-based steppers —
// we proactively snapshot fields on relevant page activity and broadcast the
// snapshot to the runtime. The side panel listens and merges it into the
// wizard accumulator.
//
// We try hard NOT to spam:
//  * input/change events are debounced (800ms quiet period).
//  * Each snapshot is JSON-compared against the last sent and dropped if
//    identical, so MutationObserver / re-render churn is harmless.
//  * Empty field lists are not sent (avoids clobbering data when the page
//    transitions through a blank intermediate state).

let __spaLastSnapshotJson = "";
let __spaSnapshotTimer = null;

function __spaSendSnapshot(reason) {
  try {
    const fields = extractFields();
    if (!fields.length) return; // ignore blank intermediate renders
    const page = extractPageContext();
    const payload = { page, fields };
    const sig = JSON.stringify(payload);
    if (sig === __spaLastSnapshotJson) return;
    __spaLastSnapshotJson = sig;
    chrome.runtime.sendMessage({ type: "wizard:step-snapshot", reason, ...payload })
      .catch(() => { /* side panel may not be open; ignore */ });
  } catch (_) { /* extraction can fail mid-render; ignore */ }
}

function __spaScheduleSnapshot(reason, delay = 800) {
  clearTimeout(__spaSnapshotTimer);
  __spaSnapshotTimer = setTimeout(() => __spaSendSnapshot(reason), delay);
}

// 1. User edits a field — capture after they pause typing or commit a change.
document.addEventListener("input",  () => __spaScheduleSnapshot("input",  800), true);
document.addEventListener("change", () => __spaScheduleSnapshot("change", 250), true);
document.addEventListener("blur",   () => __spaScheduleSnapshot("blur",   100), true);

// 2. URL changes — multi-page wizards (popstate), hash-based steppers
//    (hashchange), and SPAs that use history.pushState / replaceState.
window.addEventListener("popstate",   () => __spaScheduleSnapshot("popstate",   400));
window.addEventListener("hashchange", () => __spaScheduleSnapshot("hashchange", 400));
(function patchHistory() {
  for (const m of ["pushState", "replaceState"]) {
    const orig = history[m];
    history[m] = function (...args) {
      const r = orig.apply(this, args);
      __spaScheduleSnapshot(`history.${m}`, 400);
      return r;
    };
  }
})();

// 3. SPA step transitions that don't touch history — watch DOM additions of
//    inputs. We debounce aggressively so heavy re-renders cost ~one snapshot.
const __spaMo = new MutationObserver((muts) => {
  let touchedInputs = false;
  for (const m of muts) {
    for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.matches?.("input,select,textarea") || n.querySelector?.("input,select,textarea")) {
        touchedInputs = true; break;
      }
    }
    if (touchedInputs) break;
  }
  if (touchedInputs) __spaScheduleSnapshot("dom-mutation", 600);
});
try { __spaMo.observe(document.documentElement, { childList: true, subtree: true }); }
catch (_) { /* documentElement not ready yet; ignore */ }

// 4. Initial snapshot once the page is interactive.
if (document.readyState === "complete" || document.readyState === "interactive") {
  __spaScheduleSnapshot("initial", 250);
} else {
  window.addEventListener("DOMContentLoaded", () => __spaScheduleSnapshot("dom-ready", 250), { once: true });
}

} // end window.__spaContentScriptLoaded guard
