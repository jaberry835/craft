// background.js — MV3 service worker
// Responsibilities:
//   * Open the side panel when the toolbar icon is clicked.
//   * Hold (in-memory) auth state and provide an interactive Entra ID
//     authorization-code (PKCE) flow via chrome.identity.launchWebAuthFlow.
//   * Proxy /api/assist/* calls so the side panel never deals with tokens
//     directly.
//
// Replace placeholder values via the options page (chrome.storage.local).

const STORAGE_KEYS = {
  config: "spa_config", // { backendUrl, agentId, tenantId, clientId, devToken? }
  token: "spa_token",   // { accessToken, expiresAt }
};

// Open side panel on action click.
chrome.action.onClicked.addListener(async (tab) => {
  if (chrome.sidePanel?.open) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
});

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------
async function getConfig() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.config);
  return data[STORAGE_KEYS.config] || {};
}

async function getCachedToken() {
  const data = await chrome.storage.session.get(STORAGE_KEYS.token);
  const tok = data[STORAGE_KEYS.token];
  if (tok && tok.accessToken && tok.expiresAt > Date.now() + 60_000) {
    return tok.accessToken;
  }
  return null;
}

async function setCachedToken(accessToken, expiresInSec) {
  await chrome.storage.session.set({
    [STORAGE_KEYS.token]: {
      accessToken,
      expiresAt: Date.now() + (expiresInSec || 3600) * 1000,
    },
  });
}

// ---------------------------------------------------------------------------
// PKCE auth (Entra ID). Falls back to cfg.devToken if present.
// ---------------------------------------------------------------------------
async function sha256Base64Url(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(n = 64) {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => ("0" + b.toString(16)).slice(-2)).join("");
}

async function interactiveSignIn() {
  const cfg = await getConfig();
  if (cfg.devToken) {
    // Dev shortcut: skip OAuth entirely.
    await setCachedToken(cfg.devToken, 3600);
    return cfg.devToken;
  }
  if (!cfg.tenantId || !cfg.clientId) {
    throw new Error("Auth not configured: set tenantId and clientId in Options.");
  }

  const redirectUri = chrome.identity.getRedirectURL("oauth2");
  const codeVerifier = randomString(64);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const state = randomString(16);

  const authority = (cfg.authority || "https://login.microsoftonline.com").replace(/\/$/, "");
  const authUrl = new URL(`${authority}/${cfg.tenantId}/oauth2/v2.0/authorize`);
  authUrl.searchParams.set("client_id", cfg.clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_mode", "query");
  // Adjust scope to whatever your AgentChatV2 backend expects (e.g. an
  // application ID URI such as api://<backend-app-id>/.default).
  authUrl.searchParams.set("scope", cfg.scope || "openid profile offline_access");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });

  const url = new URL(responseUrl);
  const returnedState = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!code || returnedState !== state) {
    throw new Error("Auth failed: missing code or state mismatch.");
  }

  const tokenResp = await fetch(
    `${authority}/${cfg.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        scope: cfg.scope || "openid profile offline_access",
      }),
    },
  );
  if (!tokenResp.ok) {
    const text = await tokenResp.text();
    throw new Error(`Token exchange failed: ${tokenResp.status} ${text}`);
  }
  const token = await tokenResp.json();
  await setCachedToken(token.access_token, token.expires_in);
  return token.access_token;
}

async function getAccessToken({ interactive = true } = {}) {
  const cached = await getCachedToken();
  if (cached) return cached;
  if (!interactive) return null;
  return interactiveSignIn();
}

// ---------------------------------------------------------------------------
// API proxy
// ---------------------------------------------------------------------------
async function callAssist(path, body) {
  const cfg = await getConfig();
  if (!cfg.backendUrl) throw new Error("Backend URL not configured.");
  if (!cfg.agentId)   throw new Error("Agent id not configured.");

  const token = await getAccessToken({ interactive: true });
  // Inject specialist agent ids from saved config so every assist:* call gets
  // them without each caller having to remember. Caller may override by
  // passing its own specialist_agent_ids.
  const savedSpecialists = Array.isArray(cfg.specialistAgentIds) ? cfg.specialistAgentIds : [];
  const payload = {
    ...body,
    agent_id: body.agent_id || cfg.agentId,
    specialist_agent_ids: Array.isArray(body.specialist_agent_ids)
      ? body.specialist_agent_ids
      : savedSpecialists,
  };

  const resp = await fetch(`${cfg.backendUrl.replace(/\/$/, "")}/api/assist/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    let detail = `${resp.status}`;
    try {
      const body = await resp.json();
      if (body?.detail) detail += ` ${body.detail}`;
    } catch (_) {
      try { detail += ` ${await resp.text()}`; } catch (_) {}
    }
    throw new Error(`Assist ${path} failed: ${detail}`);
  }
  return resp.json();
}

async function listAgents() {
  const cfg = await getConfig();
  if (!cfg.backendUrl) throw new Error("Backend URL not configured.");
  const token = await getAccessToken({ interactive: true });
  const resp = await fetch(`${cfg.backendUrl.replace(/\/$/, "")}/api/chat/agents`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`List agents failed: ${resp.status} ${text}`);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// Message routing from sidepanel / content script
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "assist:explain-page":
          sendResponse({ ok: true, data: await callAssist("explain-page", msg.payload) });
          break;
        case "assist:suggest-field":
          sendResponse({ ok: true, data: await callAssist("suggest-field", msg.payload) });
          break;
        case "assist:build-package":
          sendResponse({ ok: true, data: await callAssist("build-package", msg.payload) });
          break;
        case "assist:ask":
          sendResponse({ ok: true, data: await callAssist("ask", msg.payload) });
          break;
        case "assist:deploy":
          sendResponse({ ok: true, data: await callAssist("deploy", msg.payload) });
          break;
        case "agents:list":
          sendResponse({ ok: true, data: await listAgents() });
          break;
        case "auth:sign-in":
          sendResponse({ ok: true, data: { token: await interactiveSignIn() } });
          break;
        case "auth:sign-out":
          await chrome.storage.session.remove(STORAGE_KEYS.token);
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: `Unknown message: ${msg?.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true; // keep the channel open for async sendResponse
});
