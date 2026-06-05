// @ts-nocheck
// Junior webview script — loaded as an external file to avoid template-literal escaping issues.

// Global error handler — shows any JS errors in the webview UI
window.onerror = function(msg, src, line, col, err) {
    var d = document.getElementById('messages') || document.body;
    var e = document.createElement('div');
    e.style.cssText = 'color:red;padding:8px;font-size:12px;white-space:pre-wrap;';
    e.textContent = 'JS ERROR: ' + msg + '\nLine: ' + line + ', Col: ' + col + '\n' + (err && err.stack || '');
    d.appendChild(e);
};

(function() {
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('input');
    const statusEl = document.getElementById('status-bar');
    const planPanelEl = document.getElementById('plan-panel');
    const modelSelectEl = document.getElementById('model-select');
    const modelControlEl = document.getElementById('model-control');
    const modelTriggerEl = document.getElementById('model-trigger');
    const modelTriggerLabelEl = document.getElementById('model-trigger-label');
    const modelTriggerMetaEl = document.getElementById('model-trigger-meta');
    const modelMenuEl = document.getElementById('model-menu');
    const modelSearchEl = document.getElementById('model-search');
    const modelListEl = document.getElementById('model-list');
    const reasoningControlEl = document.getElementById('reasoning-control');
    const reasoningTriggerEl = document.getElementById('reasoning-trigger');
    const reasoningTriggerLabelEl = document.getElementById('reasoning-trigger-label');
    const modelReasoningSubmenuEl = document.getElementById('model-reasoning-submenu');
    const modelNoteEl = document.getElementById('model-note');
    const permissionSelectEl = document.getElementById('permission-select');
    const providerSelectEl = document.getElementById('provider-select');
    const modeSwitchEl = document.getElementById('mode-switch');
    const modeTriggerEl = document.getElementById('mode-trigger');
    const modeTriggerIconEl = document.getElementById('mode-trigger-icon');
    const modeTriggerLabelEl = document.getElementById('mode-trigger-label');
    const modeMenuEl = document.getElementById('mode-menu');
    const modeOptions = modeMenuEl ? Array.from(modeMenuEl.querySelectorAll('.mode-option[data-mode]')) : [];
    const customAgentListEl = document.getElementById('custom-agent-list');
    const devTeamListEl = document.getElementById('dev-team-list');
    const planActionBarEl = document.getElementById('plan-action-bar');
    const btnRunPlan = document.getElementById('btn-run-plan');
    const workingEl = document.getElementById('working-indicator');
    const workingTextEl = document.getElementById('working-text');

    const btnAttach = document.getElementById('btn-attach');
    const attachMenuEl = document.getElementById('attach-menu');
    const btnSend = document.getElementById('btn-send');
    const btnTools = document.getElementById('btn-tools');
    const attachPreview = document.getElementById('attach-preview');
    const historyPanel = document.getElementById('history-panel');
    const historyList = document.getElementById('history-list');
    let currentAssistantEl = null;
    let currentContentEl = null;
    let currentNarrationEl = null;
    let currentNarrationText = '';
    // Reasoning panel ("Thinking..." details block) is opened when the
    // responses-API client streams reasoning/reasoningSummary chunks; closes
    // when the visible answer starts streaming or the iteration ends.
    let currentReasoningEl = null;
    let currentReasoningBodyEl = null;
    let currentReasoningText = '';
    let agentRunning = false;
    let pendingAgentDone = false;
    let currentProvider = 'local';
    let currentPermissionLevel = 'default';
    let currentMode = 'agent';
    let currentModels = [];
    let currentActiveDeployment = '';
    let currentReasoningConfig = null;
    let reasoningHoverTimer = null;
    let reasoningCloseTimer = null;
    let reasoningAnchorEl = null;
    let customAgents = [];
    let activeCustomAgentId = null;
    let devTeams = [];
    let activeDevTeamId = null;
    let currentAssistantTeam = null;
    const toolStateById = new Map();
    const workingBlocksById = new Map();
    const workingEntriesById = new Map();
    let activeWorkingBlockId = null;

    const MODE_META = {
        agent: {
            label: 'Agent',
            icon: '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 2v1.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M5.1 3.9h5.8A2.3 2.3 0 0 1 13.2 6.2v3.2a2.3 2.3 0 0 1-2.3 2.3H5.1a2.3 2.3 0 0 1-2.3-2.3V6.2a2.3 2.3 0 0 1 2.3-2.3Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M2.8 7.1H1.9M14.1 7.1h-.9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="6.3" cy="7.2" r=".75" fill="currentColor"/><circle cx="9.7" cy="7.2" r=".75" fill="currentColor"/><path d="M6 9.4c.6.45 1.2.65 2 .65s1.4-.2 2-.65" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'
        },
        ask: {
            label: 'Ask',
            icon: '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 4.75A2.25 2.25 0 0 1 5.25 2.5h5.5A2.25 2.25 0 0 1 13 4.75v3.5a2.25 2.25 0 0 1-2.25 2.25H7.1L4.4 12.8a.6.6 0 0 1-.99-.45v-1.87A2.25 2.25 0 0 1 3 8.25v-3.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5.5 5.9h5M5.5 7.9h3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'
        },
        plan: {
            label: 'Plan',
            icon: '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 4h8M6.5 8H12M6.5 12H12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="4.25" cy="4" r=".85" fill="currentColor"/><circle cx="4.25" cy="8" r=".85" fill="currentColor"/><circle cx="4.25" cy="12" r=".85" fill="currentColor"/></svg>'
        }
    };

    const PERMISSION_META = {
        default: {
            label: 'Default Approvals',
            description: 'Use your configured approval settings for this session.'
        },
        bypass: {
            label: 'Bypass Approvals',
            description: 'Auto-approve tool calls for this session.'
        }
    };

    // Tools that should never render as standalone tool-blocks (pure bookkeeping).
    const HIDDEN_TOOLS = new Set(['set_plan', 'update_plan_step']);

    // ── Streaming state ──
    let streamRawText = '';          // full accumulated raw text during streaming
    let streamBuffer = '';           // characters waiting to be flushed to display
    let streamRenderTimer = null;    // debounce timer for markdown re-render
    let streamDrainTimer = null;     // interval timer for smooth character drain
    const STREAM_DRAIN_INTERVAL = 12;  // ms between drain ticks — controls typing speed
    const STREAM_DRAIN_CHARS = 3;      // chars per drain tick (for real-time streaming)
    const STREAM_DRAIN_CHARS_FAST = 6;  // chars per drain tick (for buffered/bulk text)
    const STREAM_RENDER_DEBOUNCE = 80; // ms debounce for markdown re-render
    const AGENT_STOP_ICON = '<span class="agent-stop-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M9 4.75a3 3 0 0 1 6 0v.55h.75A2.25 2.25 0 0 1 18 7.55v6.7a4.25 4.25 0 0 1-4.25 4.25h-3.5A4.25 4.25 0 0 1 6 14.25v-6.7A2.25 2.25 0 0 1 8.25 5.3H9v-.55Zm1.5 0v.55h3v-.55a1.5 1.5 0 0 0-3 0ZM8.25 6.8a.75.75 0 0 0-.75.75v6.7A2.75 2.75 0 0 0 10.25 17h3.5a2.75 2.75 0 0 0 2.75-2.75v-6.7a.75.75 0 0 0-.75-.75h-7.5Z" fill="currentColor"></path><circle cx="10" cy="11" r="1.1" fill="currentColor"></circle><circle cx="14" cy="11" r="1.1" fill="currentColor"></circle><path d="M9.6 14.1a.75.75 0 0 1 .75-.6h3.3a.75.75 0 0 1 .58 1.22 3 3 0 0 1-5.2 0 .75.75 0 0 1-.13-.62Z" fill="currentColor"></path></svg></span>';

    // Progress card icon map (icon name → unicode/emoji)
    const PC_ICONS = {
        search: '<i class="codicon codicon-search"></i>',
        read: '<i class="codicon codicon-file"></i>',
        edit: '<i class="codicon codicon-edit"></i>',
        run: '<i class="codicon codicon-play"></i>',
        check: '<i class="codicon codicon-pass"></i>',
        loading: '<i class="codicon codicon-loading codicon-modifier-spin"></i>',
        done: '<i class="codicon codicon-check"></i>',
        error: '<i class="codicon codicon-error"></i>',
        create: '<i class="codicon codicon-new-file"></i>',
        list: '<i class="codicon codicon-list-tree"></i>',
        terminal: '<i class="codicon codicon-terminal"></i>'
    };

    // File extension → { tag, color } for colored language badges in progress steps
    var FILE_EXT_BADGES = {
        '.ts':    { tag: 'TS',   color: '#3178c6' },
        '.tsx':   { tag: 'TSX',  color: '#3178c6' },
        '.js':    { tag: 'JS',   color: '#f0db4f' },
        '.jsx':   { tag: 'JSX',  color: '#f0db4f' },
        '.json':  { tag: 'JSON', color: '#a8a038' },
        '.py':    { tag: 'PY',   color: '#3572a5' },
        '.css':   { tag: 'CSS',  color: '#563d7c' },
        '.scss':  { tag: 'SCSS', color: '#c6538c' },
        '.html':  { tag: 'HTML', color: '#e34c26' },
        '.md':    { tag: 'MD',   color: '#519aba' },
        '.yaml':  { tag: 'YAML', color: '#cb171e' },
        '.yml':   { tag: 'YML',  color: '#cb171e' },
        '.sh':    { tag: 'SH',   color: '#4eaa25' },
        '.ps1':   { tag: 'PS',   color: '#012456' },
        '.rs':    { tag: 'RS',   color: '#dea584' },
        '.go':    { tag: 'GO',   color: '#00add8' },
        '.java':  { tag: 'JAVA', color: '#b07219' },
        '.cs':    { tag: 'C#',   color: '#178600' },
        '.cpp':   { tag: 'C++',  color: '#f34b7d' },
        '.c':     { tag: 'C',    color: '#555555' },
        '.rb':    { tag: 'RB',   color: '#701516' },
        '.swift': { tag: 'SWIFT',color: '#f05138' },
        '.vue':   { tag: 'VUE',  color: '#41b883' },
        '.svelte':{ tag: 'SVLT', color: '#ff3e00' },
        '.sql':   { tag: 'SQL',  color: '#e38c00' },
        '.xml':   { tag: 'XML',  color: '#f26522' },
        '.toml':  { tag: 'TOML', color: '#9c4121' },
    };

    /** Extract a file extension badge HTML from a label string, or return '' */
    function fileBadgeHtml(label) {
        if (!label) return '';
        // Match common file name patterns (name.ext) in the label
        var m = label.match(/[\w.\-\/\\]+\.(\w+)/);
        if (!m) return '';
        var ext = '.' + m[1].toLowerCase();
        var badge = FILE_EXT_BADGES[ext];
        if (!badge) return '';
        return ' <span class="pc-file-badge" style="background:' + badge.color + '">' + badge.tag + '</span>';
    }

    /** Render label HTML with the file path portion as a clickable link */
    function labelWithFileLink(label, filePath) {
        if (!label) return '';
        if (!filePath) return escapeHtml(label) + fileBadgeHtml(label);
        // Find the file path portion in the label (last path-like segment)
        var m = label.match(/([\w.\-\/\\]+\.(\w+))/);
        if (!m) return escapeHtml(label) + fileBadgeHtml(label);
        var fileName = m[1];
        var idx = label.indexOf(fileName);
        var before = label.substring(0, idx);
        var after = label.substring(idx + fileName.length);
        return escapeHtml(before) +
            '<span class="pc-file-link">' + escapeHtml(fileName) + '</span>' +
            escapeHtml(after) + fileBadgeHtml(label);
    }

    // ── History toggle (triggered by extension command) ──
    function toggleHistoryPanel() {
        const open = historyPanel.classList.toggle('open');
        if (open) {
            vscode.postMessage({ type: 'requestSessionList' });
        }
    }

    function renderHistoryList(sessions, activeId) {
        historyList.innerHTML = '';
        if (sessions.length === 0) {
            historyList.innerHTML = '<div style="padding:10px;opacity:0.5;font-size:12px;">No chat history</div>';
            return;
        }
        for (const s of sessions) {
            const item = document.createElement('div');
            item.className = 'history-item' + (s.id === activeId ? ' active' : '');
            const ago = formatTimeAgo(s.updatedAt);
            item.innerHTML =
                '<span class="hi-title">' + escapeHtml(s.title) + '</span>' +
                '<span class="hi-meta">' + s.messageCount + ' msgs &middot; ' + ago + '</span>' +
                '<button class="hi-delete" title="Delete chat">&times;</button>';
            item.querySelector('.hi-title').addEventListener('click', () => {
                vscode.postMessage({ type: 'switchSession', sessionId: s.id });
                historyPanel.classList.remove('open');
            });
            item.querySelector('.hi-delete').addEventListener('click', (e) => {
                e.stopPropagation();
                vscode.postMessage({ type: 'deleteSession', sessionId: s.id });
            });
            historyList.appendChild(item);
        }
    }

    function formatTimeAgo(ts) {
        const diff = Date.now() - ts;
        const mins = Math.floor(diff / 60000);
        if (mins < 1) { return 'just now'; }
        if (mins < 60) { return mins + 'm ago'; }
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) { return hrs + 'h ago'; }
        const days = Math.floor(hrs / 24);
        if (days < 30) { return days + 'd ago'; }
        return new Date(ts).toLocaleDateString();
    }

    // ── Attachment State ──
    let pendingImages = [];   // array of data URIs
    let pendingFiles = [];    // array of { name, content }

    // Auto-resize textarea
    inputEl.addEventListener('input', () => {
        inputEl.style.height = 'auto';
        inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
    });

    // Send message on Enter
    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            // Don't send if slash autocomplete is open (handled by capture listener)
            if (slashAutocompleteEl && slashAutocompleteEl.classList.contains('open')) { return; }
            e.preventDefault();
            sendCurrentMessage();
        }
    });

    function sendCurrentMessage() {
        const text = inputEl.value.trim();
        if (!text && pendingImages.length === 0 && pendingFiles.length === 0) { return; }
        closeModeMenu();
        closeModelMenu();
        closeAttachMenu();
        const msg = { type: 'sendMessage', text: text || '(see attachments)', mode: currentMode };
        if (pendingImages.length > 0) { msg.images = pendingImages.slice(); }
        if (pendingFiles.length > 0) { msg.files = pendingFiles.slice(); }
        vscode.postMessage(msg);
        inputEl.value = '';
        inputEl.style.height = 'auto';
        clearAttachments();
        closeSlashAutocomplete();
        setPlanReadyVisibility(false);
    }


    if (btnAttach) {
        btnAttach.addEventListener('click', function(e) {
            e.stopPropagation();
            toggleAttachMenu();
        });
    }

    if (attachMenuEl) {
        attachMenuEl.querySelectorAll('[data-attach-kind]').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                const kind = btn.getAttribute('data-attach-kind');
                closeAttachMenu();
                if (kind === 'file') {
                    vscode.postMessage({ type: 'attachFile' });
                } else {
                    vscode.postMessage({ type: 'attachContext', kind: kind });
                }
            });
        });
    }

    // Send / Stop button
    if (btnSend) {
        btnSend.addEventListener('click', () => {
            if (agentRunning) {
                vscode.postMessage({ type: 'cancelAgent' });
            } else {
                sendCurrentMessage();
            }
        });
    }

    // MCP Tools button
    if (btnTools) {
        btnTools.addEventListener('click', () => vscode.postMessage({ type: 'manageMcpServers' }));
    }

    function setAgentRunning(running) {
        agentRunning = running;
        closeModeMenu();
        closeAttachMenu();
        if (!btnSend) return;
        if (modeTriggerEl) {
            modeTriggerEl.disabled = running;
        }
        if (running) {
            btnSend.classList.add('stop-mode');
            btnSend.innerHTML = AGENT_STOP_ICON;
            btnSend.title = 'Stop agent (cancel)';
        } else {
            btnSend.classList.remove('stop-mode');
            btnSend.innerHTML = '<i class=\"codicon codicon-arrow-up\"></i>';
            btnSend.title = 'Send message (Enter)';
        }
    }

    function getWorkingIndicatorText(status) {
        if (status && /^Thinking\b/i.test(status)) {
            return currentProvider === 'copilot-cli' ? 'Copilot CLI thinking' : 'Thinking';
        }
        return status || 'Working';
    }

    function pinWorkingIndicatorToBottom() {
        if (!workingEl || !workingEl.classList.contains('active')) { return; }
        if (activeWorkingBlockId) { return; }
        messagesEl.appendChild(workingEl);
    }

    function showGlobalWorkingIndicator(text) {
        if (!workingEl) { return; }
        workingTextEl.textContent = text || (currentProvider === 'copilot-cli' ? 'Copilot CLI thinking' : 'Thinking');
        workingEl.classList.add('active');
        pinWorkingIndicatorToBottom();
    }

    function hideGlobalWorkingIndicator() {
        if (!workingEl) { return; }
        workingEl.classList.remove('active');
    }

    function renderSourcesCard(agentName, query, citations) {
        if (!messagesEl || !citations || citations.length === 0) { return; }
        var visibleCitations = citations.slice(0, 3);
        var card = document.createElement('div');
        card.className = 'sources-card';
        var header = document.createElement('div');
        header.className = 'sources-header';
        header.innerHTML =
            '<i class="codicon codicon-search" aria-hidden="true"></i>' +
            '<span class="sources-title">' + escapeHtml(agentName) + ' \u2014 Sources</span>' +
            '<span class="sources-count">' + citations.length + '</span>';
        card.appendChild(header);
        if (query) {
            var q = document.createElement('div');
            q.className = 'sources-query';
            q.textContent = '\u201C' + query + '\u201D';
            card.appendChild(q);
        }
        var list = document.createElement('ol');
        list.className = 'sources-list';
        visibleCitations.forEach(function(c) {
            var li = document.createElement('li');
            li.className = 'sources-item';
            var titleEl;
            if (c.url) {
                titleEl = document.createElement('a');
                titleEl.href = c.url;
                titleEl.target = '_blank';
                titleEl.rel = 'noopener noreferrer';
            } else {
                titleEl = document.createElement('span');
            }
            titleEl.className = 'sources-item-title';
            titleEl.textContent = c.title || ('Result ' + c.index);
            li.appendChild(titleEl);
            var meta = document.createElement('span');
            meta.className = 'sources-item-meta';
            var score = (typeof c.rerankerScore === 'number') ? c.rerankerScore
                      : (typeof c.score === 'number' ? c.score : null);
            if (score !== null) { meta.textContent = ' \u00B7 score ' + score.toFixed(2); }
            li.appendChild(meta);
            if (c.snippet) {
                var snip = document.createElement('div');
                snip.className = 'sources-item-snippet';
                snip.textContent = compactSourceSnippet(c.snippet);
                li.appendChild(snip);
            }
            list.appendChild(li);
        });
        card.appendChild(list);
        if (citations.length > visibleCitations.length) {
            var more = document.createElement('div');
            more.className = 'sources-more';
            more.textContent = '+' + (citations.length - visibleCitations.length) + ' more source' + (citations.length - visibleCitations.length === 1 ? '' : 's') + ' used in the standup';
            card.appendChild(more);
        }
        messagesEl.appendChild(card);
        pinWorkingIndicatorToBottom();
    }

    function compactSourceSnippet(snippet) {
        var compact = String(snippet || '').replace(/\s+/g, ' ').trim();
        if (compact.length <= 120) { return compact; }
        return compact.slice(0, 117).trimEnd() + '...';
    }

    function getModePlaceholder(mode) {
        if (activeDevTeamId) { return 'Ask the Junior Dev Team to plan, build, review, or test...'; }
        if (activeCustomAgentId) { return 'Ask this custom agent for help...'; }
        if (mode === 'ask') { return 'Ask Junior about the codebase...'; }
        if (mode === 'plan') { return 'Plan the work before execution...'; }
        return 'Ask Junior anything...';
    }

    function setChatMode(mode) {
        currentMode = mode || 'agent';
        var meta = MODE_META[currentMode] || MODE_META.agent;
        var displayLabel = meta.label;
        var displayIcon = meta.icon;
        if (activeDevTeamId) {
            var team = devTeams.find(function(t) { return t.id === activeDevTeamId; });
            if (team) {
                displayLabel = team.name;
                displayIcon = MODE_META.agent.icon;
            }
        } else if (activeCustomAgentId) {
            var ag = customAgents.find(function(a) { return a.id === activeCustomAgentId; });
            if (ag) {
                displayLabel = ag.name;
                displayIcon = ag.source === 'agent-md' ? '<i class="codicon codicon-organization"></i>' : '<i class="codicon codicon-person"></i>';
            }
        }
        if (modeTriggerLabelEl) {
            modeTriggerLabelEl.textContent = displayLabel;
        }
        if (modeTriggerIconEl) {
            modeTriggerIconEl.innerHTML = displayIcon;
        }
        modeOptions.forEach(function(btn) {
            var active = !activeCustomAgentId && !activeDevTeamId && btn.dataset.mode === currentMode;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-checked', active ? 'true' : 'false');
        });
        renderCustomAgentList();
        renderDevTeamList();
        if (!agentRunning && inputEl) {
            inputEl.placeholder = getModePlaceholder(currentMode);
        }
    }

    function renderCustomAgentList() {
        if (!customAgentListEl) { return; }
        customAgentListEl.innerHTML = '';
        customAgents.forEach(function(ag) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'mode-option mode-option-custom' + (ag.id === activeCustomAgentId ? ' active' : '');
            btn.setAttribute('role', 'menuitemradio');
            btn.setAttribute('aria-checked', ag.id === activeCustomAgentId ? 'true' : 'false');
            btn.dataset.customAgentId = ag.id;
            var icon = document.createElement('span');
            icon.className = 'mode-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.innerHTML = ag.source === 'agent-md' ? '<i class="codicon codicon-organization"></i>' : '<i class="codicon codicon-person"></i>';
            var label = document.createElement('span');
            label.className = 'mode-option-label';
            label.textContent = ag.name;
            if (ag.scope === 'workspace') {
                var scope = document.createElement('span');
                scope.className = 'mode-option-scope';
                scope.textContent = ag.source === 'agent-md' ? 'MD' : 'WS';
                label.appendChild(scope);
            }
            var actions = document.createElement('span');
            actions.className = 'mode-option-actions';
            if (!ag.readonly) {
                var editBtn = document.createElement('button');
                editBtn.type = 'button';
                editBtn.title = 'Edit agent';
                editBtn.innerHTML = '<i class="codicon codicon-edit"></i>';
                editBtn.addEventListener('click', function(ev) {
                    ev.stopPropagation();
                    closeModeMenu();
                    vscode.postMessage({ type: 'editCustomAgent', id: ag.id });
                });
                var delBtn = document.createElement('button');
                delBtn.type = 'button';
                delBtn.title = 'Delete agent';
                delBtn.innerHTML = '<i class="codicon codicon-trash"></i>';
                delBtn.addEventListener('click', function(ev) {
                    ev.stopPropagation();
                    vscode.postMessage({ type: 'deleteCustomAgent', id: ag.id });
                });
                actions.appendChild(editBtn);
                actions.appendChild(delBtn);
            }
            var check = document.createElement('span');
            check.className = 'mode-option-check';
            check.setAttribute('aria-hidden', 'true');
            check.innerHTML = '<i class="codicon codicon-check"></i>';
            btn.appendChild(icon);
            btn.appendChild(label);
            btn.appendChild(actions);
            btn.appendChild(check);
            btn.addEventListener('click', function() {
                activeCustomAgentId = ag.id;
                activeDevTeamId = null;
                closeModeMenu();
                setPlanReadyVisibility(false);
                vscode.postMessage({ type: 'selectCustomAgent', id: ag.id });
                inputEl.focus();
            });
            customAgentListEl.appendChild(btn);
        });
    }

    function renderDevTeamList() {
        if (!devTeamListEl) { return; }
        devTeamListEl.innerHTML = '';
        devTeams.forEach(function(team) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'mode-option mode-option-custom' + (team.id === activeDevTeamId ? ' active' : '');
            btn.setAttribute('role', 'menuitemradio');
            btn.setAttribute('aria-checked', team.id === activeDevTeamId ? 'true' : 'false');
            var icon = document.createElement('span');
            icon.className = 'mode-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.innerHTML = MODE_META.agent.icon;
            var label = document.createElement('span');
            label.className = 'mode-option-label';
            label.textContent = team.name;
            if (team.scope === 'workspace') {
                var scope = document.createElement('span');
                scope.className = 'mode-option-scope';
                scope.textContent = 'WS';
                label.appendChild(scope);
            }
            var actions = document.createElement('span');
            actions.className = 'mode-option-actions';
            var editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.title = 'Edit Dev Team';
            editBtn.innerHTML = '<i class="codicon codicon-edit"></i>';
            editBtn.addEventListener('click', function(ev) {
                ev.stopPropagation();
                closeModeMenu();
                vscode.postMessage({ type: 'editDevTeam', id: team.id });
            });
            var delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.title = 'Delete Dev Team';
            delBtn.innerHTML = '<i class="codicon codicon-trash"></i>';
            delBtn.addEventListener('click', function(ev) {
                ev.stopPropagation();
                vscode.postMessage({ type: 'deleteDevTeam', id: team.id });
            });
            actions.appendChild(editBtn);
            actions.appendChild(delBtn);
            var check = document.createElement('span');
            check.className = 'mode-option-check';
            check.setAttribute('aria-hidden', 'true');
            check.innerHTML = '<i class="codicon codicon-check"></i>';
            btn.appendChild(icon);
            btn.appendChild(label);
            btn.appendChild(actions);
            btn.appendChild(check);
            btn.addEventListener('click', function() {
                activeDevTeamId = team.id;
                activeCustomAgentId = null;
                closeModeMenu();
                setPlanReadyVisibility(false);
                vscode.postMessage({ type: 'selectDevTeam', id: team.id });
                inputEl.focus();
            });
            devTeamListEl.appendChild(btn);
        });
    }

    function closeModeMenu() {
        if (!modeSwitchEl || !modeMenuEl || !modeTriggerEl) { return; }
        modeSwitchEl.classList.remove('open');
        modeMenuEl.classList.add('hidden');
        modeTriggerEl.setAttribute('aria-expanded', 'false');
    }

    function toggleModeMenu() {
        if (!modeSwitchEl || !modeMenuEl || !modeTriggerEl || modeTriggerEl.disabled) { return; }
        closeAttachMenu();
        closeModelMenu();
        var open = modeMenuEl.classList.contains('hidden');
        modeSwitchEl.classList.toggle('open', open);
        modeMenuEl.classList.toggle('hidden', !open);
        modeTriggerEl.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function setPlanReadyVisibility(visible) {
        if (!planActionBarEl) { return; }
        planActionBarEl.classList.toggle('hidden', !visible);
    }

    function appendAssistantProviderBadge(container, provider) {
        if ((provider || currentProvider) !== 'copilot-cli') { return; }
        const badge = document.createElement('div');
        badge.className = 'assistant-provider-badge';
        badge.innerHTML = '<span class="assistant-provider-icon" aria-hidden="true"><svg viewBox="0 0 16 16" focusable="false"><path d="M6.25 2.5a.75.75 0 0 1 1.5 0v1.15h3A2.25 2.25 0 0 1 13 5.9v4.2a2.25 2.25 0 0 1-2.25 2.25h-3V13.5a.75.75 0 0 1-1.5 0v-1.15h-.8A2.45 2.45 0 0 1 3 9.9V9a.75.75 0 0 1 1.5 0v.9c0 .52.42.95.95.95h5.3a.75.75 0 0 0 .75-.75V5.9a.75.75 0 0 0-.75-.75h-5.3A.95.95 0 0 0 4.5 6.1V7a.75.75 0 0 1-1.5 0v-.9A2.45 2.45 0 0 1 5.45 3.65h.8V2.5Z" fill="currentColor"></path><path d="M1.53 7.47a.75.75 0 0 1 1.06 0L4 8.88l1.41-1.41a.75.75 0 1 1 1.06 1.06l-1.94 1.94a.75.75 0 0 1-1.06 0L1.53 8.53a.75.75 0 0 1 0-1.06Z" fill="currentColor"></path></svg></span><span>Copilot CLI</span>';
        container.appendChild(badge);
    }

    function permissionLabel(permission) {
        if (permission === 'write') { return 'Can edit'; }
        if (permission === 'read') { return 'Read only'; }
        return 'Review only';
    }

    function devTeamMemberIcon(member) {
        var text = ((member && (member.role + ' ' + (member.agentName || ''))) || '').toLowerCase();
        if (/lead|architect|planner|principal/.test(text)) { return '🏗️'; }
        if (/front\s*end|ui|ux|design|web/.test(text)) { return '🎨'; }
        if (/back\s*end|api|server|service|platform/.test(text)) { return '🔧'; }
        if (/test|qa|quality|review|code reviewer/.test(text)) { return '🧪'; }
        if (/doc|scribe|writer|readme/.test(text)) { return '📋'; }
        if (/security|auth|threat|risk/.test(text)) { return '🛡️'; }
        if (/data|db|database|sql|search/.test(text)) { return '🗄️'; }
        if (/devops|infra|deploy|cloud|ops/.test(text)) { return '🚀'; }
        if (/human|people|team|hr|teammate/.test(text)) { return '👥'; }
        if (/sme|expert|domain|hpde|hr/.test(text)) { return '💡'; }
        if (member && member.permission === 'write') { return '🛠️'; }
        if (member && member.permission === 'read') { return '🔎'; }
        return '✨';
    }

    function devTeamMemberStatusText(member) {
        if (member.status === 'failed') { return 'Unavailable'; }
        return '';
    }

    function appendDevTeamResponseHeader(container, team) {
        if (!team || !Array.isArray(team.members) || team.members.length === 0) { return; }
        const header = document.createElement('div');
        header.className = 'dev-team-response-header';
        const title = document.createElement('div');
        title.className = 'dev-team-response-title';
        const icon = document.createElement('span');
        icon.className = 'dev-team-response-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = '<i class="codicon codicon-organization"></i>';
        const name = document.createElement('span');
        name.textContent = team.name || 'Junior Dev Team';
        title.appendChild(icon);
        title.appendChild(name);
        const roster = document.createElement('div');
        roster.className = 'dev-team-response-roster';
        team.members.forEach(function(member) {
            const chip = document.createElement('span');
            chip.className = 'dev-team-member-chip permission-' + (member.permission || 'review') + (member.status === 'failed' ? ' consult-failed' : member.status === 'executed' ? ' consult-executed' : '');
            chip.title = permissionLabel(member.permission) + (member.deploymentId ? ' · ' + member.deploymentId : '') + (member.error ? ' · ' + member.error : '');
            var status = devTeamMemberStatusText(member);
            chip.innerHTML =
                '<span class="dev-team-member-icon" aria-hidden="true">' + escapeHtml(devTeamMemberIcon(member)) + '</span>' +
                (status ? '<span class="dev-team-member-status">' + escapeHtml(status) + '</span>' : '') +
                '<span class="dev-team-member-name">' + escapeHtml(member.role || 'Member') + '</span>' +
                (member.agentName ? '<span class="dev-team-member-agent">' + escapeHtml(member.agentName) + '</span>' : '');
            roster.appendChild(chip);
        });
        header.appendChild(title);
        header.appendChild(roster);
        container.appendChild(header);
    }

    function renderUserMessageItem(item) {
        closeLiveNarration();
        const el = document.createElement('div');
        el.className = 'msg user';
        let inner = '<div class="label">You</div>';
        if (item.images && item.images.length > 0) {
            inner += '<div class="user-attachments">';
            for (const src of item.images) {
                inner += '<img src="' + escapeHtml(src) + '" class="user-attach-img" />';
            }
            inner += '</div>';
        }
        if (item.fileNames && item.fileNames.length > 0) {
            inner += '<div class="user-attachments">';
            for (const name of item.fileNames) {
                inner += '<span class="user-attach-file">&#128196; ' + escapeHtml(name) + '</span>';
            }
            inner += '</div>';
        }
        inner += '<div class="content">' + escapeHtml(item.text) + '</div>';
        el.innerHTML = inner;
        messagesEl.appendChild(el);
    }

    function renderAssistantMessageItem(item) {
        if (!item.text) { return; }
        closeLiveNarration();
        const assistantEl = document.createElement('div');
        assistantEl.className = 'msg assistant' + (item.provider === 'copilot-cli' ? ' cli-provider' : '');
        appendAssistantProviderBadge(assistantEl, item.provider);
        appendDevTeamResponseHeader(assistantEl, item.team);
        const contentEl = document.createElement('div');
        contentEl.className = 'content';
        renderAssistantContent(contentEl, item.text, item.team);
        assistantEl.appendChild(contentEl);
        messagesEl.appendChild(assistantEl);
    }

    function renderNarrationItem(item) {
        closeLiveNarration();
        var narRow = document.createElement('div');
        narRow.className = 'narration-row';
        narRow.innerHTML = renderMarkdownLite(item.text);
        messagesEl.appendChild(narRow);
    }

    function renderDevTeamRoomEventItem(item) {
        appendDevTeamRoomEvent(item.event || item);
    }

    function appendDevTeamRoomEvent(event) {
        if (!event) { return; }
        closeLiveNarration();
        var row = document.createElement('div');
        row.className = 'dev-team-room-event status-' + escapeClassName(event.status || 'started');
        var member = event.memberRole ? {
            role: event.memberRole,
            agentName: event.agentName,
            permission: event.permission || 'review',
            status: event.status === 'failed' ? 'failed' : event.status === 'done' ? 'consulted' : undefined
        } : null;
        var iconHtml = member
            ? '<span class="dev-team-room-icon" aria-hidden="true">' + escapeHtml(devTeamMemberIcon(member)) + '</span>'
            : '<span class="dev-team-room-icon team" aria-hidden="true"><i class="codicon codicon-organization"></i></span>';
        var agentText = event.agentName ? '<span class="dev-team-room-agent">' + escapeHtml(event.agentName) + '</span>' : '';
        var meta = [event.phase ? formatDevTeamPhase(event.phase) : '', event.status ? formatDevTeamStatus(event.status) : '']
            .filter(Boolean)
            .join(' · ');
        row.innerHTML =
            iconHtml +
            '<div class="dev-team-room-copy">' +
                '<div class="dev-team-room-title"><span>' + escapeHtml(event.title || event.teamName || 'Junior Dev Team') + '</span>' + agentText + '</div>' +
                (event.detail ? '<div class="dev-team-room-detail">' + escapeHtml(event.detail) + '</div>' : '') +
                (meta ? '<div class="dev-team-room-meta">' + escapeHtml(meta) + '</div>' : '') +
            '</div>';
        messagesEl.appendChild(row);
    }

    function formatDevTeamPhase(phase) {
        if (phase === 'execute') { return 'implementation pass'; }
        if (phase === 'review') { return 'review pass'; }
        return 'consult pass';
    }

    function formatDevTeamStatus(status) {
        if (status === 'opened') { return 'standup started'; }
        if (status === 'completed') { return 'standup finished'; }
        if (status === 'blocked') { return 'blocker'; }
        if (status === 'failed') { return 'unavailable'; }
        if (status === 'done') { return 'done'; }
        return 'working';
    }

    function escapeClassName(value) {
        return String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    }

    function appendNarrationText(text) {
        if (!text) { return; }
        if (!currentNarrationEl || !currentNarrationEl.parentNode) {
            currentNarrationEl = document.createElement('div');
            currentNarrationEl.className = 'narration-row';
            currentNarrationText = '';
            messagesEl.appendChild(currentNarrationEl);
        }
        currentNarrationText += text;
        currentNarrationEl.innerHTML = renderMarkdownLite(currentNarrationText);
    }

    function closeLiveNarration() {
        currentNarrationEl = null;
        currentNarrationText = '';
    }

    function renderReasoningItem(item) {
        if (!item || !item.text) { return; }
        closeLiveReasoning();
        var panel = createReasoningPanel(false);
        panel.bodyEl.textContent = item.text;
        messagesEl.appendChild(panel.root);
    }

    function createReasoningPanel(open) {
        var details = document.createElement('details');
        details.className = 'reasoning-panel';
        if (open) { details.open = true; }
        var summary = document.createElement('summary');
        summary.className = 'reasoning-summary';
        summary.innerHTML = '<span class="reasoning-icon">\u2728</span><span class="reasoning-label">Thinking</span>';
        details.appendChild(summary);
        var body = document.createElement('div');
        body.className = 'reasoning-body';
        details.appendChild(body);
        return { root: details, bodyEl: body };
    }

    function startLiveReasoning() {
        if (currentReasoningEl && currentReasoningEl.parentNode) { return; }
        closeLiveNarration();
        var panel = createReasoningPanel(!currentAssistantTeam && !activeDevTeamId);
        currentReasoningEl = panel.root;
        currentReasoningBodyEl = panel.bodyEl;
        currentReasoningText = '';
        messagesEl.appendChild(currentReasoningEl);
        scrollToBottom();
    }

    function appendReasoningText(text) {
        if (!text) { return; }
        if (!currentReasoningEl || !currentReasoningEl.parentNode) {
            startLiveReasoning();
        }
        currentReasoningText += text;
        currentReasoningBodyEl.textContent = currentReasoningText;
    }

    function closeLiveReasoning() {
        if (currentReasoningEl && currentReasoningBodyEl && !currentReasoningText) {
            // Empty panel — drop it rather than leave a stray "Thinking" row.
            if (currentReasoningEl.parentNode) {
                currentReasoningEl.parentNode.removeChild(currentReasoningEl);
            }
        } else if (currentReasoningEl) {
            // Collapse the panel after a short grace period so the user can
            // still skim the last reasoning lines once the visible answer
            // starts streaming.
            var elToCollapse = currentReasoningEl;
            setTimeout(function () {
                if (elToCollapse && elToCollapse.parentNode) {
                    elToCollapse.open = false;
                }
            }, 1800);
        }
        currentReasoningEl = null;
        currentReasoningBodyEl = null;
        currentReasoningText = '';
    }

    function renderErrorItem(item) {
        showLocalError(item.message);
    }

    function restoreWorkingBlockItem(block) {
        createWorkingBlock({
            id: block.id,
            title: block.title,
            status: block.status,
            summary: block.summary,
            entries: [],
            startedAt: block.startedAt,
            completedAt: block.completedAt,
        });
        for (const entry of block.entries || []) {
            if (entry.kind === 'progress') {
                appendWorkingTextEntry(block.id, entry);
            } else if (entry.kind === 'action') {
                appendWorkingActionEntry(block.id, entry);
            } else if (entry.kind === 'terminal') {
                appendWorkingTerminalEntry(block.id, entry);
            }
        }
        if (block.status === 'completed') {
            completeWorkingBlock(block.id, block.summary || block.title, block.completedAt || block.startedAt || Date.now());
        }
    }

    function restoreTranscript(transcript) {
        if (!transcript || !Array.isArray(transcript.items)) { return; }
        for (const item of transcript.items) {
            switch (item.kind) {
                case 'user':
                    renderUserMessageItem(item);
                    break;
                case 'assistant':
                    renderAssistantMessageItem(item);
                    break;
                case 'narration':
                    renderNarrationItem(item);
                    break;
                case 'dev-team-room-event':
                    renderDevTeamRoomEventItem(item);
                    break;
                case 'reasoning':
                    renderReasoningItem(item);
                    break;
                case 'working-block':
                    restoreWorkingBlockItem(item.block);
                    break;
                case 'error':
                    renderErrorItem(item);
                    break;
            }
        }
        currentAssistantEl = null;
        currentContentEl = null;
        activeWorkingBlockId = null;
        pinWorkingIndicatorToBottom();
        scrollToBottom();
    }

    var contextMeterEl = document.getElementById('context-meter');
    if (contextMeterEl) {
        contextMeterEl.addEventListener('click', () => vscode.postMessage({ type: 'showTokenUsage' }));
    }

    if (modelSelectEl) {
        modelSelectEl.addEventListener('change', () => {
            const deploymentId = modelSelectEl.value;
            if (deploymentId) {
                vscode.postMessage({ type: 'selectModelById', deploymentId });
            }
        });
    }

    if (modelTriggerEl) {
        modelTriggerEl.addEventListener('click', function(e) {
            e.stopPropagation();
            toggleModelMenu();
        });
    }

    if (reasoningTriggerEl) {
        reasoningTriggerEl.addEventListener('click', function(e) {
            e.stopPropagation();
            toggleReasoningMenu();
        });
    }

    if (modelSearchEl) {
        modelSearchEl.addEventListener('input', function() {
            renderModelOptions();
        });
    }

    if (modelReasoningSubmenuEl) {
        modelReasoningSubmenuEl.addEventListener('mouseenter', function() {
            cancelReasoningClose();
        });
        modelReasoningSubmenuEl.addEventListener('mouseleave', function() {
            if (reasoningAnchorEl) { scheduleReasoningClose(); }
        });
    }

    if (providerSelectEl) {
        providerSelectEl.addEventListener('change', () => {
            const provider = providerSelectEl.value;
            vscode.postMessage({ type: 'selectAgentProvider', provider });
        });
    }

    if (permissionSelectEl) {
        permissionSelectEl.addEventListener('change', () => {
            const level = permissionSelectEl.value || 'default';
            vscode.postMessage({ type: 'selectPermissionLevel', level });
        });
    }

    if (modeTriggerEl) {
        modeTriggerEl.addEventListener('click', function(e) {
            e.stopPropagation();
            toggleModeMenu();
        });
    }

    modeOptions.forEach(function(btn) {
        btn.addEventListener('click', function() {
            var mode = btn.dataset.mode || 'agent';
            // Selecting a built-in mode clears any active custom agent.
            if (activeCustomAgentId) {
                activeCustomAgentId = null;
                vscode.postMessage({ type: 'selectCustomAgent', id: null });
            }
            if (activeDevTeamId) {
                activeDevTeamId = null;
                vscode.postMessage({ type: 'selectDevTeam', id: null });
            }
            setChatMode(mode);
            closeModeMenu();
            setPlanReadyVisibility(false);
            vscode.postMessage({ type: 'selectChatMode', mode: mode });
            inputEl.focus();
        });
    });

    // "+ Create custom agent…" footer row.
    var createAgentBtn = modeMenuEl ? modeMenuEl.querySelector('[data-action="create-custom-agent"]') : null;
    if (createAgentBtn) {
        createAgentBtn.addEventListener('click', function() {
            closeModeMenu();
            vscode.postMessage({ type: 'createCustomAgent' });
        });
    }

    var createDevTeamBtn = modeMenuEl ? modeMenuEl.querySelector('[data-action="create-dev-team"]') : null;
    if (createDevTeamBtn) {
        createDevTeamBtn.addEventListener('click', function() {
            closeModeMenu();
            vscode.postMessage({ type: 'createDevTeam' });
        });
    }

    document.addEventListener('click', function(e) {
        if (modeSwitchEl && modeSwitchEl.contains(e.target)) { return; }
        if (modelControlEl && modelControlEl.contains(e.target)) { return; }
        if (reasoningControlEl && reasoningControlEl.contains(e.target)) { return; }
        if ((attachMenuEl && attachMenuEl.contains(e.target)) || (btnAttach && btnAttach.contains(e.target))) { return; }
        closeModeMenu();
        closeModelMenu();
        closeReasoningMenu();
        closeAttachMenu();
    });

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            closeModeMenu();
            closeModelMenu();
            closeReasoningMenu();
            closeAttachMenu();
        }
    });

    if (btnRunPlan) {
        btnRunPlan.addEventListener('click', function() {
            setPlanReadyVisibility(false);
            vscode.postMessage({ type: 'runPlanInAgent' });
        });
    }

    function setAgentProviders(providers, activeProvider) {
        if (!providerSelectEl) { return; }

        const current = activeProvider || providerSelectEl.value || 'local';
        providerSelectEl.innerHTML = '';

        for (const provider of providers || []) {
            const opt = document.createElement('option');
            opt.value = provider.value;
            opt.textContent = provider.label;
            providerSelectEl.appendChild(opt);
        }

        providerSelectEl.disabled = !providers || providers.length <= 1;
        const nextValue = Array.from(providerSelectEl.options).some(opt => opt.value === current)
            ? current
            : (providerSelectEl.options[0] ? providerSelectEl.options[0].value : 'local');
        providerSelectEl.value = nextValue;
        currentProvider = nextValue || 'local';
    }

    function setPermissionLevel(level) {
        currentPermissionLevel = level || 'default';
        if (!permissionSelectEl) { return; }

        const nextValue = Object.prototype.hasOwnProperty.call(PERMISSION_META, currentPermissionLevel)
            ? currentPermissionLevel
            : 'default';
        permissionSelectEl.value = nextValue;
        permissionSelectEl.title = PERMISSION_META[nextValue].description;
    }

    function setModels(models, activeDeployment, reasoning) {
        if (!modelSelectEl) { return; }
        currentModels = Array.isArray(models) ? models.slice() : [];
        const current = activeDeployment || modelSelectEl.value || currentActiveDeployment;
        modelSelectEl.innerHTML = '';
        if (currentModels.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'No models configured';
            modelSelectEl.appendChild(opt);
            modelSelectEl.disabled = true;
            currentActiveDeployment = '';
            updateModelTrigger();
            renderModelOptions();
            setReasoningConfig(null);
            return;
        }

        for (const m of currentModels) {
            const opt = document.createElement('option');
            opt.value = m.deploymentId;
            const label = m.name || m.deploymentId;
            opt.textContent = label;
            opt.title = m.title || (label + (label !== m.deploymentId ? ' — ' + m.deploymentId : ''));
            if (m.disabled) { opt.disabled = true; }
            modelSelectEl.appendChild(opt);
        }
        modelSelectEl.disabled = false;
        if (current) {
            modelSelectEl.value = current;
        }
        currentActiveDeployment = modelSelectEl.value || currentModels[0].deploymentId;
        updateModelTrigger();
        renderModelOptions();
        setReasoningConfig(reasoning);
    }

    function setReasoningConfig(reasoning) {
        currentReasoningConfig = reasoning || null;
        const visible = !!(reasoning && reasoning.visible);
        if (!visible) {
            if (modelTriggerMetaEl) { modelTriggerMetaEl.textContent = ''; }
            updateReasoningTrigger();
            closeReasoningMenu();
            return;
        }

        updateModelTrigger();
        updateReasoningTrigger();
        renderReasoningOptions();
        if (modelNoteEl) {
            modelNoteEl.textContent = reasoning.wireApi === 'responses'
                ? (reasoning.summary === 'none' ? 'Reasoning summaries are hidden for this model.' : '')
                : 'Set Azure OpenAI Wire API to responses to use these controls.';
        }
    }

    function toggleModelMenu() {
        if (!modelMenuEl || !modelTriggerEl || modelTriggerEl.disabled) { return; }
        closeModeMenu();
        closeReasoningMenu();
        closeAttachMenu();
        const open = modelMenuEl.classList.contains('hidden');
        modelControlEl.classList.toggle('open', open);
        modelMenuEl.classList.toggle('hidden', !open);
        modelTriggerEl.classList.toggle('active', open);
        modelTriggerEl.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open && modelSearchEl) {
            modelSearchEl.value = '';
            renderModelOptions();
            closeReasoningSubmenu();
            positionModelMenu();
            setTimeout(function() { modelSearchEl.focus(); }, 0);
        }
    }

    function closeModelMenu() {
        if (!modelMenuEl || !modelTriggerEl) { return; }
        modelControlEl.classList.remove('open');
        modelMenuEl.classList.add('hidden');
        modelTriggerEl.classList.remove('active');
        modelTriggerEl.setAttribute('aria-expanded', 'false');
    }

    function toggleReasoningMenu() {
        if (!modelReasoningSubmenuEl || !reasoningTriggerEl || reasoningTriggerEl.disabled) { return; }
        closeModeMenu();
        closeModelMenu();
        closeAttachMenu();
        const open = modelReasoningSubmenuEl.classList.contains('hidden');
        if (open) {
            renderReasoningOptions();
            modelReasoningSubmenuEl.classList.remove('hidden');
            reasoningControlEl.classList.add('open');
            reasoningTriggerEl.classList.add('active');
            reasoningTriggerEl.setAttribute('aria-expanded', 'true');
            positionReasoningMenu();
        } else {
            closeReasoningMenu();
        }
    }

    function closeReasoningMenu() {
        clearReasoningHoverTimer();
        cancelReasoningClose();
        closeReasoningSubmenu();
        if (reasoningControlEl) { reasoningControlEl.classList.remove('open'); }
        if (reasoningTriggerEl) {
            reasoningTriggerEl.classList.remove('active');
            reasoningTriggerEl.setAttribute('aria-expanded', 'false');
        }
    }

    function toggleAttachMenu() {
        if (!attachMenuEl) {
            vscode.postMessage({ type: 'attachFile' });
            return;
        }
        const open = attachMenuEl.classList.contains('hidden');
        closeModeMenu();
        closeModelMenu();
        attachMenuEl.classList.toggle('hidden', !open);
        if (btnAttach) {
            btnAttach.classList.toggle('active', open);
            btnAttach.setAttribute('aria-expanded', open ? 'true' : 'false');
        }
    }

    function closeAttachMenu() {
        if (!attachMenuEl) { return; }
        attachMenuEl.classList.add('hidden');
        if (btnAttach) {
            btnAttach.classList.remove('active');
            btnAttach.setAttribute('aria-expanded', 'false');
        }
    }

    function positionModelMenu() {
        if (!modelMenuEl || !modelControlEl) { return; }
        modelMenuEl.style.left = '0px';
        const rect = modelMenuEl.getBoundingClientRect();
        const margin = 8;
        let offset = 0;
        if (rect.left < margin) {
            offset = margin - rect.left;
        } else if (rect.right > window.innerWidth - margin) {
            offset = window.innerWidth - margin - rect.right;
        }
        modelMenuEl.style.left = offset + 'px';
    }

    function openReasoningSubmenu(anchorEl) {
        if (!modelReasoningSubmenuEl || !currentReasoningConfig || !anchorEl) { return; }
        cancelReasoningClose();
        reasoningAnchorEl = anchorEl;
        renderReasoningOptions();
        modelReasoningSubmenuEl.classList.remove('hidden');
        positionReasoningSubmenu();
    }

    function closeReasoningSubmenu() {
        if (!modelReasoningSubmenuEl) { return; }
        modelReasoningSubmenuEl.classList.add('hidden');
        modelReasoningSubmenuEl.classList.remove('open-left', 'open-right', 'open-inside');
        modelReasoningSubmenuEl.style.transform = '';
        modelReasoningSubmenuEl.style.top = '';
        reasoningAnchorEl = null;
    }

    function positionReasoningMenu() {
        if (!modelReasoningSubmenuEl || !reasoningControlEl) { return; }
        modelReasoningSubmenuEl.classList.remove('open-left', 'open-right', 'open-inside');
        modelReasoningSubmenuEl.style.left = '0px';
        modelReasoningSubmenuEl.style.right = 'auto';
        modelReasoningSubmenuEl.style.top = '';
        modelReasoningSubmenuEl.style.transform = '';
        const rect = modelReasoningSubmenuEl.getBoundingClientRect();
        const margin = 8;
        let offset = 0;
        if (rect.left < margin) {
            offset = margin - rect.left;
        } else if (rect.right > window.innerWidth - margin) {
            offset = window.innerWidth - margin - rect.right;
        }
        modelReasoningSubmenuEl.style.left = offset + 'px';
    }

    function positionReasoningSubmenu() {
        if (!modelReasoningSubmenuEl || !reasoningAnchorEl || !modelMenuEl) { return; }
        modelReasoningSubmenuEl.classList.remove('open-left', 'open-right', 'open-inside');
        modelReasoningSubmenuEl.style.transform = '';
        const anchorRect = reasoningAnchorEl.getBoundingClientRect();
        const menuRect = modelMenuEl.getBoundingClientRect();
        const margin = 8;
        modelReasoningSubmenuEl.style.top = '0px';
        modelReasoningSubmenuEl.classList.add('open-right');

        const submenuHeight = modelReasoningSubmenuEl.getBoundingClientRect().height;
        const preferredViewportTop = anchorRect.bottom - submenuHeight;
        const clampedViewportTop = Math.max(margin, preferredViewportTop);
        modelReasoningSubmenuEl.style.top = (clampedViewportTop - menuRect.top) + 'px';

        let rect = modelReasoningSubmenuEl.getBoundingClientRect();
        if (rect.left >= margin && rect.right <= window.innerWidth - margin) { return; }

        if (rect.right > window.innerWidth - margin) {
            modelReasoningSubmenuEl.classList.remove('open-right');
            modelReasoningSubmenuEl.classList.add('open-left');
            rect = modelReasoningSubmenuEl.getBoundingClientRect();
        }
        if (rect.left >= margin && rect.right <= window.innerWidth - margin) { return; }

        modelReasoningSubmenuEl.classList.remove('open-left', 'open-right');
        modelReasoningSubmenuEl.classList.add('open-inside');
        rect = modelReasoningSubmenuEl.getBoundingClientRect();
        if (rect.left < margin) {
            modelReasoningSubmenuEl.style.transform = 'translateX(' + (margin - rect.left) + 'px)';
        } else if (rect.right > window.innerWidth - margin) {
            modelReasoningSubmenuEl.style.transform = 'translateX(' + (window.innerWidth - margin - rect.right) + 'px)';
        } else {
            modelReasoningSubmenuEl.style.transform = '';
        }
    }

    function updateModelTrigger() {
        const selected = currentModels.find(m => m.deploymentId === currentActiveDeployment) || currentModels[0];
        if (modelTriggerEl) { modelTriggerEl.disabled = currentModels.length === 0; }
        if (modelTriggerLabelEl) { modelTriggerLabelEl.textContent = selected ? (selected.name || selected.deploymentId) : 'No models configured'; }
        if (modelTriggerMetaEl) { modelTriggerMetaEl.textContent = ''; }
        updateReasoningTrigger();
    }

    function updateReasoningTrigger() {
        const visible = !!(currentReasoningConfig && currentReasoningConfig.visible);
        if (reasoningControlEl) { reasoningControlEl.classList.toggle('hidden', !visible); }
        if (reasoningTriggerEl) {
            reasoningTriggerEl.disabled = !visible;
            reasoningTriggerEl.title = visible ? 'Choose thinking effort' : 'Thinking effort is unavailable for this model';
        }
        if (reasoningTriggerLabelEl) {
            reasoningTriggerLabelEl.textContent = visible ? formatReasoningEffort(currentReasoningConfig.effort) : 'Reasoning';
        }
    }

    function scheduleReasoningHover(anchorEl, model) {
        clearReasoningHoverTimer();
        cancelReasoningClose();
        if (!model || !model.supportsReasoning || !currentReasoningConfig || !currentReasoningConfig.visible) { return; }
        reasoningHoverTimer = setTimeout(function() {
            openReasoningSubmenu(anchorEl);
        }, 650);
    }

    function clearReasoningHoverTimer() {
        if (reasoningHoverTimer) {
            clearTimeout(reasoningHoverTimer);
            reasoningHoverTimer = null;
        }
    }

    function scheduleReasoningClose() {
        clearReasoningHoverTimer();
        cancelReasoningClose();
        reasoningCloseTimer = setTimeout(function() {
            closeReasoningSubmenu();
        }, 220);
    }

    function cancelReasoningClose() {
        if (reasoningCloseTimer) {
            clearTimeout(reasoningCloseTimer);
            reasoningCloseTimer = null;
        }
    }

    function renderModelOptions() {
        if (!modelListEl) { return; }
        closeReasoningSubmenu();
        const query = (modelSearchEl && modelSearchEl.value || '').trim().toLowerCase();
        modelListEl.innerHTML = '';
        const filtered = currentModels.filter(function(m) {
            const label = (m.name || m.deploymentId || '').toLowerCase();
            return !query || label.includes(query) || (m.deploymentId || '').toLowerCase().includes(query);
        });
        if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'model-note';
            empty.textContent = 'No matching models';
            modelListEl.appendChild(empty);
            return;
        }
        filtered.forEach(function(m) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'model-option' + (m.deploymentId === currentActiveDeployment ? ' active' : '');
            btn.setAttribute('role', 'menuitemradio');
            btn.setAttribute('aria-checked', m.deploymentId === currentActiveDeployment ? 'true' : 'false');
            const label = m.name || m.deploymentId;
            btn.title = label + (label !== m.deploymentId ? ' - ' + m.deploymentId : '');
            btn.innerHTML = '<span class="model-option-check"><i class="codicon codicon-check"></i></span>' +
                '<span class="model-option-name"></span>' +
                '<span class="model-option-meta"></span>';
            btn.querySelector('.model-option-name').textContent = label;
            const meta = btn.querySelector('.model-option-meta');
            if (meta) { meta.textContent = m.supportsReasoning ? 'Supports reasoning' : ''; }
            btn.addEventListener('click', function() {
                currentActiveDeployment = m.deploymentId;
                modelSelectEl.value = m.deploymentId;
                updateModelTrigger();
                renderModelOptions();
                closeModelMenu();
                vscode.postMessage({ type: 'selectModelById', deploymentId: m.deploymentId });
                inputEl.focus();
            });
            modelListEl.appendChild(btn);
        });
    }

    function renderReasoningOptions() {
        if (!modelReasoningSubmenuEl || !currentReasoningConfig) { return; }
        const effortGroup = modelReasoningSubmenuEl.querySelector('[data-reasoning-group="effort"]');
        const summaryGroup = modelReasoningSubmenuEl.querySelector('[data-reasoning-group="summary"]');
        if (effortGroup) {
            effortGroup.innerHTML = '<div class="reasoning-section-title">Thinking Effort</div>';
            [
                ['none', 'None', 'No reasoning applied'],
                ['low', 'Low', 'Faster responses with less reasoning'],
                ['medium', 'Medium', 'Balanced reasoning and speed'],
                ['high', 'High', 'Greater reasoning depth but slower'],
                ['xhigh', 'Xhigh', 'Maximum reasoning depth but slower']
            ].forEach(function(option) {
                effortGroup.appendChild(createReasoningOption('effort', option[0], option[1], option[2], currentReasoningConfig.effort === option[0]));
            });
        }
        if (summaryGroup) {
            summaryGroup.innerHTML = '<div class="reasoning-section-title">Summary</div>';
            [
                ['auto', 'Auto', 'Let the model decide'],
                ['detailed', 'Detailed', 'Always request a summary'],
                ['none', 'None', 'Hide the reasoning panel stream']
            ].forEach(function(option) {
                summaryGroup.appendChild(createReasoningOption('summary', option[0], option[1], option[2], currentReasoningConfig.summary === option[0]));
            });
        }
        updateModelTrigger();
    }

    function createReasoningOption(kind, value, label, meta, active) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'reasoning-option' + (active ? ' active' : '');
        btn.setAttribute('role', 'menuitemradio');
        btn.setAttribute('aria-checked', active ? 'true' : 'false');
        btn.innerHTML = '<span class="reasoning-option-check"><i class="codicon codicon-check"></i></span>' +
            '<span class="reasoning-option-label"></span>' +
            '<span class="reasoning-option-meta"></span>';
        btn.querySelector('.reasoning-option-label').textContent = label;
        btn.querySelector('.reasoning-option-meta').textContent = meta;
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            if (kind === 'effort') {
                currentReasoningConfig.effort = value;
                vscode.postMessage({ type: 'updateReasoningConfig', effort: value });
            } else {
                currentReasoningConfig.summary = value;
                vscode.postMessage({ type: 'updateReasoningConfig', summary: value });
            }
            updateReasoningTrigger();
            renderReasoningOptions();
            renderModelOptions();
        });
        return btn;
    }

    function formatReasoningEffort(effort) {
        const value = effort || 'high';
        return value.charAt(0).toUpperCase() + value.slice(1);
    }

    // ── Image paste from clipboard ──
    inputEl.addEventListener('paste', (e) => {
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) { return; }
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.type.startsWith('image/')) {
                e.preventDefault();
                const file = item.getAsFile();
                if (file) { readImageFile(file); }
                return;
            }
        }
    });

    // ── Drag and drop files/images ──
    const inputArea = document.getElementById('input-area');
    inputArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        inputArea.classList.add('drag-over');
    });
    inputArea.addEventListener('dragleave', (e) => {
        e.preventDefault();
        inputArea.classList.remove('drag-over');
    });
    inputArea.addEventListener('drop', (e) => {
        e.preventDefault();
        inputArea.classList.remove('drag-over');
        const files = e.dataTransfer && e.dataTransfer.files;
        if (!files) { return; }
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (file.type.startsWith('image/')) {
                readImageFile(file);
            } else {
                readTextFile(file);
            }
        }
    });

    function readImageFile(file) {
        if (file.size > 20 * 1024 * 1024) {
            showLocalError('Image too large (max 20 MB).');
            return;
        }
        const reader = new FileReader();
        reader.onload = function() {
            pendingImages.push(reader.result);
            refreshAttachPreview();
        };
        reader.readAsDataURL(file);
    }

    function readTextFile(file) {
        if (file.size > 1024 * 1024) {
            showLocalError('File too large (max 1 MB). Use the attach button for workspace files.');
            return;
        }
        const reader = new FileReader();
        reader.onload = function() {
            pendingFiles.push({ name: file.name, content: reader.result });
            refreshAttachPreview();
        };
        reader.readAsText(file);
    }

    function refreshAttachPreview() {
        if (!attachPreview) { return; }
        attachPreview.innerHTML = '';
        pendingImages.forEach((dataUri, idx) => {
            const pill = document.createElement('div');
            pill.className = 'attach-pill image-pill';
            pill.innerHTML = '<img src="' + escapeHtml(dataUri) + '" class="attach-thumb"/>' +
                '<span>Image ' + (idx + 1) + '</span>' +
                '<button class="attach-remove" title="Remove">&times;</button>';
            pill.querySelector('.attach-remove').addEventListener('click', () => {
                pendingImages.splice(idx, 1);
                refreshAttachPreview();
            });
            attachPreview.appendChild(pill);
        });
        pendingFiles.forEach((f, idx) => {
            const pill = document.createElement('div');
            pill.className = 'attach-pill file-pill' + (f.contextKind ? ' context-pill' : '');
            const icon = f.contextKind ? '<i class="codicon codicon-quote"></i>' : '<i class="codicon codicon-file"></i>';
            pill.innerHTML = '<span class="attach-file-icon">' + icon + '</span>' +
                '<span>' + escapeHtml(f.name) + '</span>' +
                '<button class="attach-remove" title="Remove">&times;</button>';
            pill.querySelector('.attach-remove').addEventListener('click', () => {
                pendingFiles.splice(idx, 1);
                refreshAttachPreview();
            });
            attachPreview.appendChild(pill);
        });
        attachPreview.style.display = (pendingImages.length + pendingFiles.length > 0) ? 'flex' : 'none';
    }

    function clearAttachments() {
        pendingImages = [];
        pendingFiles = [];
        if (attachPreview) {
            attachPreview.innerHTML = '';
            attachPreview.style.display = 'none';
        }
    }

    // ── Slash Command Autocomplete ──
    var slashCommands = [];  // populated from extension
    var slashActiveIndex = -1;
    var slashAutocompleteEl = document.getElementById('slash-autocomplete');
    var slashPendingRequest = false;

    function updateSlashAutocomplete() {
        if (!slashAutocompleteEl) { return; }
        var text = inputEl.value;

        // Only trigger when first char is / and cursor is in the command portion
        var match = text.match(/^\/(\S*)$/);
        if (!match) {
            closeSlashAutocomplete();
            return;
        }

        // Request fresh command list from the extension when needed
        if (slashCommands.length === 0) {
            if (!slashPendingRequest) {
                slashPendingRequest = true;
                vscode.postMessage({ type: 'requestSlashCommands' });
            }
            return;
        }

        var filter = match[1].toLowerCase();
        var filtered = slashCommands.filter(function(c) {
            return c.name.toLowerCase().indexOf('/' + filter) === 0 || c.name.toLowerCase().indexOf(filter) !== -1;
        });

        if (filtered.length === 0) {
            closeSlashAutocomplete();
            return;
        }

        slashActiveIndex = 0;
        slashAutocompleteEl.innerHTML = '';
        filtered.forEach(function(cmd, idx) {
            var item = document.createElement('div');
            item.className = 'slash-item' + (idx === 0 ? ' active' : '');
            item.innerHTML = '<span class="slash-name">' + escapeHtml(cmd.name) + '</span>' +
                '<span class="slash-desc">' + escapeHtml(cmd.description) + '</span>';
            item.addEventListener('mousedown', function(e) {
                e.preventDefault();
                selectSlashCommand(cmd.name);
            });
            slashAutocompleteEl.appendChild(item);
        });
        slashAutocompleteEl.classList.add('open');
    }

    function closeSlashAutocomplete() {
        if (slashAutocompleteEl) {
            slashAutocompleteEl.classList.remove('open');
            slashAutocompleteEl.innerHTML = '';
        }
        slashActiveIndex = -1;
        // Reset so next / will request fresh commands from disk
        slashCommands = [];
        slashPendingRequest = false;
    }

    function selectSlashCommand(name) {
        inputEl.value = name + ' ';
        inputEl.focus();
        closeSlashAutocomplete();
        // Resize textarea
        inputEl.style.height = 'auto';
        inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
    }

    // Hook into input events for slash autocomplete
    inputEl.addEventListener('input', function() {
        updateSlashAutocomplete();
    });

    // Keyboard navigation inside autocomplete
    inputEl.addEventListener('keydown', function(e) {
        if (!slashAutocompleteEl || !slashAutocompleteEl.classList.contains('open')) { return; }
        var items = slashAutocompleteEl.querySelectorAll('.slash-item');
        if (items.length === 0) { return; }

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (slashActiveIndex < items.length - 1) { slashActiveIndex++; }
            items.forEach(function(it, i) { it.classList.toggle('active', i === slashActiveIndex); });
            items[slashActiveIndex].scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (slashActiveIndex > 0) { slashActiveIndex--; }
            items.forEach(function(it, i) { it.classList.toggle('active', i === slashActiveIndex); });
            items[slashActiveIndex].scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Tab' || (e.key === 'Enter' && slashActiveIndex >= 0)) {
            e.preventDefault();
            e.stopPropagation();
            var activeItem = items[slashActiveIndex];
            if (activeItem) {
                var name = activeItem.querySelector('.slash-name').textContent;
                selectSlashCommand(name);
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeSlashAutocomplete();
        }
    }, true);  // use capture to intercept before the Enter-to-send handler

    function showLocalError(text) {
        const el = document.createElement('div');
        el.className = 'error-msg';
        el.style.whiteSpace = 'pre-wrap';
        el.textContent = text;
        messagesEl.appendChild(el);
        scrollToBottom();
    }

    function renderPlan(steps) {
        if (!planPanelEl) { return; }
        if (!steps || steps.length === 0) {
            planPanelEl.classList.add('hidden');
            planPanelEl.classList.remove('expanded');
            return;
        }
        planPanelEl.classList.remove('hidden');

        const icons = { pending: '\u25CB', in_progress: '\u25CF', completed: '\u2713', failed: '\u2717' };
        const completed = steps.filter(s => s.status === 'completed').length;
        const current = steps.find(s => s.status === 'in_progress');
        // Count in_progress as part of progress so "1/5" shows while working on step 1
        const progress = current ? completed + 1 : completed;

        var progressText;
        var nextPending = steps.find(function(s) { return s.status === 'pending'; });
        if (current) {
            progressText = current.title + '... (' + progress + '/' + steps.length + ')';
        } else if (completed === steps.length) {
            progressText = 'Completed (' + completed + '/' + steps.length + ')';
        } else if (nextPending) {
            progressText = nextPending.title + '... (' + progress + '/' + steps.length + ')';
        } else {
            progressText = '(' + progress + '/' + steps.length + ')';
        }
        planPanelEl.querySelector('.plan-progress').textContent = progressText;

        const stepsEl = planPanelEl.querySelector('.plan-steps');
        stepsEl.innerHTML = steps.map(function(s) {
            return '<div class="plan-step ' + s.status + '">' +
                '<span class="plan-icon">' + icons[s.status] + '</span>' +
                '<span>' + escapeHtml(s.title) + '</span>' +
            '</div>';
        }).join('');
    }

    var _scrollPending = false;
    function scrollToBottom() {
        if (_scrollPending) { return; }
        _scrollPending = true;
        requestAnimationFrame(() => {
            _scrollPending = false;
            messagesEl.scrollTop = messagesEl.scrollHeight;
        });
    }

    // ── Progressive markdown rendering during streaming ──

    /** Render accumulated streamRawText as markdown into currentContentEl */
    function renderStreamMarkdown() {
        if (!currentContentEl) { return; }
        // Save scroll position intent
        var atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
        renderAssistantContent(currentContentEl, streamRawText, getCurrentAssistantRenderTeam());
        if (atBottom) { scrollToBottom(); }
    }

    function getCurrentAssistantRenderTeam() {
        return currentAssistantTeam || (currentAssistantEl && currentAssistantEl.__devTeam) || null;
    }

    /** Schedule a debounced markdown re-render */
    function scheduleStreamRender() {
        if (streamRenderTimer) { clearTimeout(streamRenderTimer); }
        streamRenderTimer = setTimeout(function() {
            streamRenderTimer = null;
            renderStreamMarkdown();
        }, STREAM_RENDER_DEBOUNCE);
    }

    /** Start the smooth drain interval that moves chars from buffer to rawText */
    function startStreamDrain() {
        if (streamDrainTimer) { return; } // already running
        streamDrainTimer = setInterval(function() {
            if (streamBuffer.length === 0) {
                clearInterval(streamDrainTimer);
                streamDrainTimer = null;
                // Final render when buffer empties
                scheduleStreamRender();
                return;
            }
            // Use faster rate when a large chunk is buffered (e.g. final response dump)
            var base = streamBuffer.length > 80 ? STREAM_DRAIN_CHARS_FAST : STREAM_DRAIN_CHARS;
            var count = Math.min(base, streamBuffer.length);
            // Don't break in the middle of a word — extend to next space/newline if close
            if (count < streamBuffer.length) {
                var next = streamBuffer.indexOf(' ', count);
                var nextNl = streamBuffer.indexOf('\n', count);
                if (next === -1 || (nextNl !== -1 && nextNl < next)) { next = nextNl; }
                if (next !== -1 && next - count < 8) { count = next + 1; }
            }
            streamRawText += streamBuffer.slice(0, count);
            streamBuffer = streamBuffer.slice(count);
            scheduleStreamRender();
        }, STREAM_DRAIN_INTERVAL);
    }

    /** Flush all buffered text immediately (used when tearing down without animation) */
    function flushStreamBuffer() {
        if (streamDrainTimer) { clearInterval(streamDrainTimer); streamDrainTimer = null; }
        if (streamRenderTimer) { clearTimeout(streamRenderTimer); streamRenderTimer = null; }
        streamRawText += streamBuffer;
        streamBuffer = '';
    }

    /** Finalize the assistant message after the drain completes naturally */
    var pendingEndMessage = null;
    function assistantStreamPending() {
        return !!pendingEndMessage || !!currentAssistantEl || streamBuffer.length > 0 || !!streamDrainTimer || !!streamRenderTimer;
    }

    function finishAgentDoneWhenIdle() {
        if (!pendingAgentDone || assistantStreamPending()) { return; }
        pendingAgentDone = false;
        inputEl.disabled = false;
        inputEl.placeholder = getModePlaceholder(currentMode);
        inputEl.focus();
        setAgentRunning(false);
        hideGlobalWorkingIndicator();
    }

    function finalizeAssistantMessage() {
        if (!pendingEndMessage) { return; }
        var els = pendingEndMessage;
        pendingEndMessage = null;
        if (els.contentEl) {
            var rawText = streamRawText.trim();
            if (rawText.length > 0) {
                renderAssistantContent(els.contentEl, streamRawText, els.team || getCurrentAssistantRenderTeam());
            } else {
                if (els.assistantEl && els.assistantEl.parentNode) {
                    els.assistantEl.parentNode.removeChild(els.assistantEl);
                }
            }
        }
        currentAssistantEl = null;
        currentContentEl = null;
        currentAssistantTeam = null;
        streamRawText = '';
        streamBuffer = '';
        scrollToBottom();
        finishAgentDoneWhenIdle();
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ── Ask-user interactive question form ──
    function renderAskUser(msg) {
        const questions = Array.isArray(msg.questions) ? msg.questions : [];
        if (questions.length === 0) { return; }

        const dialog = document.createElement('div');
        dialog.className = 'ask-dialog';
        dialog.dataset.requestId = msg.requestId;

        // Per-question state: selected option labels + freeform text.
        const state = questions.map(function() { return { selected: [], freeform: '' }; });

        questions.forEach(function(q, qi) {
            const qEl = document.createElement('div');
            qEl.className = 'ask-question';

            const textEl = document.createElement('div');
            textEl.className = 'ask-q-text';
            textEl.textContent = q.question;
            qEl.appendChild(textEl);

            if (q.detail) {
                const detailEl = document.createElement('div');
                detailEl.className = 'ask-q-detail';
                detailEl.textContent = q.detail;
                qEl.appendChild(detailEl);
            }

            const hasOptions = Array.isArray(q.options) && q.options.length > 0;
            const multi = q.multiSelect === true;
            // Default true unless explicitly disabled. Free-text-only when no options.
            const allowFree = !hasOptions || q.allowFreeformInput !== false;

            if (hasOptions) {
                const optsEl = document.createElement('div');
                optsEl.className = 'ask-options';
                q.options.forEach(function(opt) {
                    const label = document.createElement('label');
                    label.className = 'ask-option';

                    const input = document.createElement('input');
                    input.type = multi ? 'checkbox' : 'radio';
                    input.name = 'ask_' + msg.requestId + '_' + qi;
                    input.value = opt.label;

                    const body = document.createElement('div');
                    body.className = 'ask-option-body';
                    const lab = document.createElement('div');
                    lab.className = 'ask-option-label';
                    lab.textContent = opt.label;
                    if (opt.recommended) {
                        const rec = document.createElement('span');
                        rec.className = 'ask-option-rec';
                        rec.textContent = 'Recommended';
                        lab.appendChild(rec);
                    }
                    body.appendChild(lab);
                    if (opt.description) {
                        const desc = document.createElement('div');
                        desc.className = 'ask-option-desc';
                        desc.textContent = opt.description;
                        body.appendChild(desc);
                    }

                    input.addEventListener('change', function() {
                        if (multi) {
                            if (input.checked) {
                                if (state[qi].selected.indexOf(opt.label) === -1) { state[qi].selected.push(opt.label); }
                            } else {
                                state[qi].selected = state[qi].selected.filter(function(v) { return v !== opt.label; });
                            }
                            label.classList.toggle('selected', input.checked);
                        } else {
                            state[qi].selected = [opt.label];
                            Array.prototype.forEach.call(optsEl.querySelectorAll('.ask-option'), function(el) {
                                el.classList.remove('selected');
                            });
                            label.classList.add('selected');
                        }
                        updateSubmitState();
                    });

                    label.appendChild(input);
                    label.appendChild(body);
                    optsEl.appendChild(label);
                });
                qEl.appendChild(optsEl);
            }

            if (allowFree) {
                const ta = document.createElement('textarea');
                ta.className = 'ask-freeform';
                ta.rows = 1;
                ta.placeholder = hasOptions ? 'Or type a custom answer…' : 'Type your answer…';
                ta.addEventListener('input', function() {
                    state[qi].freeform = ta.value;
                    ta.style.height = 'auto';
                    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
                    updateSubmitState();
                });
                ta.addEventListener('keydown', function(e) {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        submit();
                    }
                });
                qEl.appendChild(ta);
            }

            dialog.appendChild(qEl);
        });

        const actions = document.createElement('div');
        actions.className = 'ask-actions';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn-ask-cancel';
        cancelBtn.textContent = 'Skip';
        const submitBtn = document.createElement('button');
        submitBtn.className = 'btn-ask-submit';
        submitBtn.textContent = 'Submit';
        actions.appendChild(cancelBtn);
        actions.appendChild(submitBtn);
        dialog.appendChild(actions);

        function answerFor(qi) {
            const values = state[qi].selected.slice();
            const free = (state[qi].freeform || '').trim();
            if (free) { values.push(free); }
            return values;
        }

        function isComplete() {
            for (let qi = 0; qi < questions.length; qi++) {
                if (answerFor(qi).length === 0) { return false; }
            }
            return true;
        }

        function updateSubmitState() {
            submitBtn.disabled = !isComplete();
        }

        let resolved = false;
        function finish(cancelled) {
            if (resolved) { return; }
            resolved = true;
            const answers = {};
            const summaryParts = [];
            questions.forEach(function(q, qi) {
                const values = cancelled ? [] : answerFor(qi);
                answers[q.header] = values;
                if (!cancelled) {
                    summaryParts.push(q.question + ' → ' + (values.length ? values.join(', ') : '(skipped)'));
                }
            });
            vscode.postMessage({ type: 'askUserResponse', requestId: msg.requestId, answers: answers, cancelled: !!cancelled });

            // Lock the form and show a compact summary.
            dialog.classList.add('answered');
            Array.prototype.forEach.call(dialog.querySelectorAll('input, textarea, button'), function(el) {
                el.disabled = true;
            });
            const summary = document.createElement('div');
            summary.className = 'ask-answered-summary';
            summary.textContent = cancelled ? 'Skipped.' : summaryParts.join('  •  ');
            dialog.appendChild(summary);
        }

        function submit() {
            if (!isComplete()) { return; }
            finish(false);
        }

        submitBtn.addEventListener('click', submit);
        cancelBtn.addEventListener('click', function() { finish(true); });

        updateSubmitState();
        messagesEl.appendChild(dialog);
        pinWorkingIndicatorToBottom();
        scrollToBottom();
        const firstField = dialog.querySelector('input, textarea');
        if (firstField) { firstField.focus(); }
    }

    // ── Unique ID for copy buttons ──
    let codeBlockId = 0;

    function normalizePathologicalWrappedText(text) {
        return text.replace(/```[\s\S]*?```|[^`]+/g, function(segment) {
            if (segment.startsWith('```')) {
                return segment;
            }

            var paragraphs = segment.split(/\n{2,}/);
            var normalized = [];
            var run = [];

            function isShortNeutralParagraph(paragraph) {
                var line = paragraph.trim();
                if (!line) { return false; }
                if (/^\s*(?:[-*+]\s|\d+\.\s|#|>|\|)/.test(line)) { return false; }
                var words = line.split(/\s+/).filter(Boolean);
                return words.length > 0 && words.length <= 3 && line.length <= 24;
            }

            function flushRun() {
                if (run.length >= 4) {
                    normalized.push(run.map(function(part) { return part.trim(); }).join(' '));
                } else {
                    normalized.push.apply(normalized, run);
                }
                run = [];
            }

            paragraphs.forEach(function(paragraph) {
                var lines = paragraph.split('\n');
                var nonEmptyLines = lines.filter(function(line) { return line.trim().length > 0; });

                if (nonEmptyLines.length >= 4) {
                    var markdownLike = nonEmptyLines.some(function(line) {
                        return /^\s*(?:[-*+]\s|\d+\.\s|#|>|\|)/.test(line);
                    });
                    var shortLineCount = nonEmptyLines.filter(function(line) {
                        var words = line.trim().split(/\s+/).filter(Boolean);
                        return words.length > 0 && words.length <= 3 && line.trim().length <= 24;
                    }).length;

                    if (!markdownLike && shortLineCount / nonEmptyLines.length >= 0.8) {
                        flushRun();
                        normalized.push(nonEmptyLines.map(function(line) { return line.trim(); }).join(' '));
                        return;
                    }
                }

                if (isShortNeutralParagraph(paragraph)) {
                    run.push(paragraph);
                    return;
                }

                flushRun();
                normalized.push(paragraph);
            });

            flushRun();
            return normalized.join('\n\n');
        });
    }

    function renderMarkdownLite(text) {
        text = normalizePathologicalWrappedText(text);
        // Normalize repeated separator lines that can appear from model/tool output.
        // This avoids rendering stacks of visual rules with no explanatory content.
        text = text.replace(/(?:^\s*---+\s*$\n?){2,}/gm, '\n');
        // Remove all separator-only lines (---, ***, ___) to avoid ghost horizontal rules.
        text = text.replace(/^\s*([-*_])\1{2,}\s*$/gm, '');
        // Remove unicode/dash rule-like lines (box drawing, long dashes, mixed punctuation rules).
        text = text.replace(/^\s*[-_=*~\u2500-\u2503\u2012-\u2015]{8,}\s*$/gm, '');
        // Collapse very large blank-line runs from tool/model separators.
        text = text.replace(/\n{4,}/g, '\n\n\n');

        let html = escapeHtml(text);

        // Extract fenced code blocks first to avoid markdown transforms inside code.
        const codeBlocks = [];
        html = html.replace(/\x60\x60\x60(\w*)\n([\s\S]*?)\x60\x60\x60/g, function(match, lang, code) {
            const id = 'codeblock-' + (codeBlockId++);
            const token = '%%CODEBLOCK_' + codeBlocks.length + '%%';
            codeBlocks.push(
                '<div class="code-block-wrapper">' +
                    '<div class="code-block-header">' +
                        (lang ? '<span class="code-lang">' + escapeHtml(lang) + '</span>' : '') +
                        '<button class="copy-btn" data-code-id="' + id + '" title="Copy code">&#128203; Copy</button>' +
                    '</div>' +
                    '<pre><code id="' + id + '">' + code + '</code></pre>' +
                '</div>'
            );
            return token;
        });

        // Inline code (` ... `)
        html = html.replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>');
        // Bold
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        // Italic
        html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

        // Headings
        html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
        html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
        html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

        // Unordered list items + grouping
        html = html.replace(/^\s*[-*]\s+(.+)$/gm, '<li>$1</li>');
        html = html.replace(/(?:<li>[\s\S]*?<\/li>\n?)+/g, function(block) {
            return '<ul>' + block.replace(/\n/g, '') + '</ul>';
        });

        // Ordered list items + grouping
        html = html.replace(/^\s*\d+\.\s+(.+)$/gm, '<li data-ordered="1">$1</li>');
        html = html.replace(/(?:<li data-ordered="1">[\s\S]*?<\/li>\n?)+/g, function(block) {
            return '<ol>' + block.replace(/ data-ordered="1"/g, '').replace(/\n/g, '') + '</ol>';
        });

        // Restore fenced code blocks
        html = html.replace(/%%CODEBLOCK_(\d+)%%/g, function(match, idx) {
            return codeBlocks[parseInt(idx, 10)] || '';
        });

        // Strip excess blank lines around block-level elements to avoid double-spacing
        // with white-space:pre-wrap (block margins + visible newlines = too much space).
        html = html.replace(/\n{2,}(?=<(?:h[1-3]|ul|ol|div|pre)[\s>])/g, '\n');
        html = html.replace(/(<\/(?:h[1-3]|ul|ol|div|pre)>)\n{2,}/g, '$1\n');

        // Final guard: drop any <hr> tags that could have slipped from model text transforms.
        html = html.replace(/<hr\s*\/?>/gi, '');
        // Final guard: remove any line that is still only rule-like punctuation after transforms.
        html = html.replace(/(^|\n)\s*[-_=*~\u2500-\u2503\u2012-\u2015]{8,}\s*(?=\n|$)/g, '$1');

        return html;
    }

    function renderAssistantContent(contentEl, text, team) {
        if (!contentEl) { return; }
        contentEl.innerHTML = renderAssistantMarkdown(text, team);
        applyDevTeamSpeakerDecorations(contentEl, team);
    }

    function renderAssistantMarkdown(text, team) {
        var tokenized = tokenizeDevTeamSpeakerHeadings(text || '', team);
        var html = decorateDevTeamSpeakerTokens(decorateDevTeamSpeakerHeadings(renderMarkdownLite(tokenized.text), team), tokenized.members);
        return decoratePlainDevTeamSpeakerLines(html, team);
    }

    function applyDevTeamSpeakerDecorations(contentEl, team) {
        if (!team || !Array.isArray(team.members) || team.members.length === 0 || !contentEl) { return; }
        var synthesis = htmlToNode(devTeamSynthesisHeadingHtml(team));
        if (synthesis) { contentEl.insertBefore(synthesis, contentEl.firstChild); }

        var membersByKey = devTeamMembersBySpeakerKey(team);
        Array.from(contentEl.childNodes).forEach(function(node) {
            if (node.nodeType !== Node.TEXT_NODE || !node.textContent) { return; }
            var parts = node.textContent.split(/(\n)/);
            var fragment = document.createDocumentFragment();
            var changed = false;
            parts.forEach(function(part) {
                if (part === '\n') {
                    fragment.appendChild(document.createTextNode(part));
                    return;
                }
                var plain = part.trim().replace(/:$/, '');
                var member = plain ? membersByKey.get(normalizeDevTeamSpeakerKey(plain)) : undefined;
                if (member) {
                    var heading = htmlToNode(devTeamSpeakerHeadingHtml(member));
                    if (heading) { fragment.appendChild(heading); }
                    changed = true;
                    return;
                }
                fragment.appendChild(document.createTextNode(part));
            });
            if (changed && node.parentNode) {
                node.parentNode.replaceChild(fragment, node);
            }
        });
    }

    function htmlToNode(html) {
        var template = document.createElement('template');
        template.innerHTML = html.trim();
        return template.content.firstElementChild;
    }

    function tokenizeDevTeamSpeakerHeadings(text, team) {
        if (!team || !Array.isArray(team.members) || team.members.length === 0 || !text) { return { text: text, members: [] }; }
        var membersByKey = devTeamMembersBySpeakerKey(team);
        var tokenMembers = [];
        var tokenText = text.split('\n').map(function(line) {
            if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) { return line; }
            var trimmed = line.trim();
            if (!trimmed) { return line; }
            var heading = trimmed.match(/^#{1,3}\s+(.+)$/);
            var plain = (heading ? heading[1] : trimmed)
                .replace(/^\*\*(.+?)\*\*:?$/, '$1')
                .replace(/^<strong>(.+?)<\/strong>:?$/i, '$1')
                .replace(/:$/, '')
                .trim();
            var member = membersByKey.get(normalizeDevTeamSpeakerKey(plain));
            if (!member) { return line; }
            var token = '%%DEVTEAM_SPEAKER_' + tokenMembers.length + '%%';
            tokenMembers.push(member);
            return token;
        }).join('\n');
        return { text: tokenText, members: tokenMembers };
    }

    function decorateDevTeamSpeakerTokens(html, members) {
        if (!members || members.length === 0 || !html) { return html; }
        return html.replace(/%%DEVTEAM_SPEAKER_(\d+)%%/g, function(match, indexText) {
            var member = members[parseInt(indexText, 10)];
            return member ? devTeamSpeakerHeadingHtml(member) : '';
        });
    }

    function decorateDevTeamSpeakerHeadings(html, team) {
        if (!team || !Array.isArray(team.members) || team.members.length === 0 || !html) { return html; }
        var membersByKey = devTeamMembersBySpeakerKey(team);
        return html.replace(/<h([1-3])>([\s\S]*?)<\/h\1>/g, function(match, level, labelHtml) {
            var plain = labelHtml.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            var member = membersByKey.get(normalizeDevTeamSpeakerKey(plain));
            if (!member) { return match; }
            return devTeamSpeakerHeadingHtml(member);
        });
    }

    function decoratePlainDevTeamSpeakerLines(html, team) {
        if (!team || !Array.isArray(team.members) || team.members.length === 0 || !html) { return html; }
        var membersByKey = devTeamMembersBySpeakerKey(team);
        return html.split('\n').map(function(line) {
            var plain = line
                .replace(/<strong>(.*?)<\/strong>/gi, '$1')
                .replace(/<em>(.*?)<\/em>/gi, '$1')
                .replace(/<[^>]+>/g, '')
                .replace(/&amp;/g, '&')
                .replace(/\s+/g, ' ')
                .trim()
                .replace(/:$/, '');
            if (!plain) { return line; }
            var member = membersByKey.get(normalizeDevTeamSpeakerKey(plain));
            return member ? devTeamSpeakerHeadingHtml(member) : line;
        }).join('\n');
    }

    function devTeamSynthesisHeadingHtml(team) {
        return '<div class="dev-team-speaker-heading team-synthesis">' +
            '<span class="dev-team-speaker-icon team" aria-hidden="true"><i class="codicon codicon-organization"></i></span>' +
            '<span class="dev-team-speaker-name">' + escapeHtml(team.name || 'Junior Dev Team') + '</span>' +
            '<span class="dev-team-speaker-agent">Synthesis</span>' +
            '</div>';
    }

    function devTeamSpeakerHeadingHtml(member) {
        var agent = member.agentName ? '<span class="dev-team-speaker-agent">' + escapeHtml(member.agentName) + '</span>' : '';
        return '<div class="dev-team-speaker-heading permission-' + escapeClassName(member.permission || 'review') + '">' +
            '<span class="dev-team-speaker-icon" aria-hidden="true">' + escapeHtml(devTeamMemberIcon(member)) + '</span>' +
            '<span class="dev-team-speaker-name">' + escapeHtml(member.role || 'Member') + '</span>' +
            agent +
            '</div>';
    }

    function devTeamMembersBySpeakerKey(team) {
        var members = new Map();
        (team.members || []).forEach(function(member) {
            if (member.role) { members.set(normalizeDevTeamSpeakerKey(member.role), member); }
            if (member.agentName) { members.set(normalizeDevTeamSpeakerKey(member.agentName), member); }
            if (member.role && member.agentName) {
                members.set(normalizeDevTeamSpeakerKey(member.role + ' / ' + member.agentName), member);
                members.set(normalizeDevTeamSpeakerKey(member.role + ' (' + member.agentName + ')'), member);
            }
        });
        return members;
    }

    function normalizeDevTeamSpeakerKey(value) {
        return String(value || '').toLowerCase().replace(/&amp;/g, '&').replace(/[^a-z0-9]+/g, ' ').trim();
    }

    // ── Delegate click handler for copy buttons ──
    messagesEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.copy-btn');
        if (!btn) { return; }
        const codeId = btn.getAttribute('data-code-id');
        const codeEl = document.getElementById(codeId);
        if (!codeEl) { return; }
        const text = codeEl.textContent || '';
        navigator.clipboard.writeText(text).then(() => {
            btn.textContent = '\u2713 Copied!';
            setTimeout(() => { btn.innerHTML = '&#128203; Copy'; }, 2000);
        }).catch(() => {
            btn.textContent = 'Failed';
            setTimeout(() => { btn.innerHTML = '&#128203; Copy'; }, 2000);
        });
    });

    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.type) {
            case 'addUserMessage': {
                renderUserMessageItem(msg);
                scrollToBottom();
                break;
            }
            case 'restoreTranscript': {
                restoreTranscript(msg.transcript);
                scrollToBottom();
                break;
            }
            case 'startAssistantMessage': {
                closeLiveNarration();
                closeLiveReasoning();
                currentAssistantTeam = msg.team || null;
                currentAssistantEl = document.createElement('div');
                currentAssistantEl.__devTeam = currentAssistantTeam;
                currentAssistantEl.className = 'msg assistant' + (currentProvider === 'copilot-cli' ? ' cli-provider' : '');
                appendAssistantProviderBadge(currentAssistantEl, currentProvider);
                appendDevTeamResponseHeader(currentAssistantEl, currentAssistantTeam);
                currentContentEl = document.createElement('div');
                currentContentEl.className = 'content';
                currentAssistantEl.appendChild(currentContentEl);
                messagesEl.appendChild(currentAssistantEl);
                pinWorkingIndicatorToBottom();
                streamRawText = '';
                streamBuffer = '';
                scrollToBottom();
                break;
            }
            case 'appendAssistantText': {
                if (currentContentEl) {
                    streamBuffer += msg.text;
                    startStreamDrain();
                }
                break;
            }
            case 'endAssistantMessage': {
                // If drain is still running, let it finish naturally then finalize
                if (streamBuffer.length > 0 || streamDrainTimer) {
                    pendingEndMessage = { contentEl: currentContentEl, assistantEl: currentAssistantEl, team: getCurrentAssistantRenderTeam() };
                    // Patch the drain loop to call finalizeAssistantMessage when done
                    if (streamDrainTimer) { clearInterval(streamDrainTimer); streamDrainTimer = null; }
                    streamDrainTimer = setInterval(function() {
                        if (streamBuffer.length === 0) {
                            clearInterval(streamDrainTimer);
                            streamDrainTimer = null;
                            scheduleStreamRender();
                            // Allow the last render to paint before finalizing
                            setTimeout(finalizeAssistantMessage, STREAM_RENDER_DEBOUNCE + 20);
                            return;
                        }
                        var base = streamBuffer.length > 80 ? STREAM_DRAIN_CHARS_FAST : STREAM_DRAIN_CHARS;
                        var count = Math.min(base, streamBuffer.length);
                        if (count < streamBuffer.length) {
                            var next = streamBuffer.indexOf(' ', count);
                            var nextNl = streamBuffer.indexOf('\n', count);
                            if (next === -1 || (nextNl !== -1 && nextNl < next)) { next = nextNl; }
                            if (next !== -1 && next - count < 8) { count = next + 1; }
                        }
                        streamRawText += streamBuffer.slice(0, count);
                        streamBuffer = streamBuffer.slice(count);
                        scheduleStreamRender();
                    }, STREAM_DRAIN_INTERVAL);
                } else {
                    // Nothing buffered — finalize immediately
                    flushStreamBuffer();
                    if (currentContentEl) {
                        var rawText = streamRawText.trim();
                        if (rawText.length > 0) {
                            renderAssistantContent(currentContentEl, streamRawText, getCurrentAssistantRenderTeam());
                        } else {
                            if (currentAssistantEl && currentAssistantEl.parentNode) {
                                currentAssistantEl.parentNode.removeChild(currentAssistantEl);
                            }
                        }
                    }
                    currentAssistantEl = null;
                    currentContentEl = null;
                    currentAssistantTeam = null;
                    streamRawText = '';
                    streamBuffer = '';
                    scrollToBottom();
                    finishAgentDoneWhenIdle();
                }
                break;
            }
            case 'toolCall': {
                closeLiveNarration();
                toolStateById.set(msg.id, {
                    name: msg.name,
                    args: safeParseJson(msg.args || '{}')
                });
                // Suppress plan-management tools and any tool covered by a working block
                if (HIDDEN_TOOLS.has(msg.name) || activeWorkingBlockId) { break; }
                const block = document.createElement('div');
                block.className = 'tool-block';
                block.dataset.toolId = msg.id;
                block.innerHTML =
                    '<div class="tool-header">' +
                        '<span class="tool-icon">&#9881;</span>' +
                        '<span class="tool-name">' + escapeHtml(msg.name) + '</span>' +
                        '<span class="tool-status">running...</span>' +
                    '</div>' +
                    '<div class="tool-detail">' + escapeHtml(formatJson(msg.args)) + '</div>';
                block.querySelector('.tool-header').addEventListener('click', () => {
                    block.classList.toggle('expanded');
                });
                messagesEl.appendChild(block);
                pinWorkingIndicatorToBottom();
                scrollToBottom();
                break;
            }
            case 'toolResult': {
                // Suppress plan-management tools and tools covered by a working block
                var _toolState = toolStateById.get(msg.id);
                if ((_toolState && HIDDEN_TOOLS.has(_toolState.name)) || activeWorkingBlockId) {
                    toolStateById.delete(msg.id);
                    break;
                }
                const block = messagesEl.querySelector('.tool-block[data-tool-id="' + CSS.escape(msg.id) + '"]');
                if (block) {
                    const state = toolStateById.get(msg.id) || { name: 'tool', args: {} };
                    const statusSpan = block.querySelector('.tool-status');
                    statusSpan.textContent = msg.success ? 'done' : 'failed';
                    const resultDiv = document.createElement('div');
                    resultDiv.className = 'tool-result ' + (msg.success ? 'success' : 'failure');
                    const summary = summarizeToolActivity(state.name, state.args, !!msg.success);
                    if (msg.success) {
                        resultDiv.textContent = summary;
                    } else {
                        resultDiv.textContent = summary + '\n' + truncate(msg.result || '', 800);
                    }
                    block.appendChild(resultDiv);
                    toolStateById.delete(msg.id);
                }
                scrollToBottom();
                break;
            }
            case 'confirmAction': {
                const dialog = document.createElement('div');
                dialog.className = 'confirm-dialog';
                dialog.dataset.actionId = msg.actionId;
                let diffHtml = '';
                if (msg.diff) {
                    const diffLines = msg.diff.split('\n').map(line => {
                        const esc = escapeHtml(line);
                        if (line.startsWith('+ ')) { return '<span class="diff-add">' + esc + '</span>'; }
                        if (line.startsWith('- ')) { return '<span class="diff-del">' + esc + '</span>'; }
                        return '<span class="diff-ctx">' + esc + '</span>';
                    });
                    diffHtml = '<div class="diff-preview"><pre>' + diffLines.join('\n') + '</pre></div>';
                }
                const isWriteOp = msg.category === 'write';
                dialog.innerHTML =
                    '<p>&#9888; ' + escapeHtml(msg.description) + '</p>' +
                    diffHtml +
                    '<div class="confirm-actions">' +
                        '<button class="btn-approve">' + (isWriteOp ? 'Keep' : 'Allow') + '</button>' +
                        '<button class="btn-session">' + (isWriteOp ? 'Keep for Session' : 'Allow for Session') + '</button>' +
                        '<button class="btn-deny">' + (isWriteOp ? 'Undo' : 'Deny') + '</button>' +
                    '</div>';
                dialog.querySelector('.btn-approve').addEventListener('click', () => {
                    vscode.postMessage({ type: 'confirmAction', actionId: msg.actionId, approved: true });
                    dialog.remove();
                });
                dialog.querySelector('.btn-session').addEventListener('click', () => {
                    vscode.postMessage({ type: 'confirmAction', actionId: msg.actionId, approved: true, allowSession: true, category: msg.category });
                    dialog.remove();
                });
                dialog.querySelector('.btn-deny').addEventListener('click', () => {
                    vscode.postMessage({ type: 'confirmAction', actionId: msg.actionId, approved: false });
                    dialog.remove();
                });
                messagesEl.appendChild(dialog);
                pinWorkingIndicatorToBottom();
                scrollToBottom();
                break;
            }
            case 'askUser': {
                renderAskUser(msg);
                break;
            }
            case 'continueIteration': {
                const dialog = document.createElement('div');
                dialog.className = 'continue-iteration-dialog';
                dialog.innerHTML =
                    '<p>Continue to iterate?</p>' +
                    '<div class="continue-subtitle">Junior has been working on this problem for a while (' + msg.iterationCount + ' iterations). It can continue to iterate, or you can send a new message to refine your prompt.</div>' +
                    '<div class="continue-actions">' +
                        '<button class="btn-continue">Continue</button>' +
                        '<button class="btn-pause">Pause</button>' +
                    '</div>';
                dialog.querySelector('.btn-continue').addEventListener('click', () => {
                    vscode.postMessage({ type: 'continueIteration', shouldContinue: true });
                    dialog.remove();
                });
                dialog.querySelector('.btn-pause').addEventListener('click', () => {
                    vscode.postMessage({ type: 'continueIteration', shouldContinue: false });
                    dialog.remove();
                });
                messagesEl.appendChild(dialog);
                pinWorkingIndicatorToBottom();
                scrollToBottom();
                break;
            }
            case 'fileChangeTick': {
                // Update working block entry with diff stats — only for write/edit actions
                var WRITE_ACTION_TYPES = { create: true, edit: true };
                for (var [, eRec] of workingEntriesById) {
                    if (eRec.entry.filePath && msg.file &&
                        WRITE_ACTION_TYPES[eRec.entry.actionType] &&
                        (eRec.entry.filePath === msg.file ||
                         eRec.entry.filePath.endsWith('/' + msg.file) ||
                         eRec.entry.filePath.endsWith('\\' + msg.file))) {
                        eRec.entry.additions = msg.additions;
                        eRec.entry.deletions = msg.deletions;
                        renderWorkingActionRow(eRec.el, eRec.entry);
                    }
                }
                const dock = document.getElementById('file-change-dock');
                if (!dock) break;
                dock.classList.remove('hidden');

                // Add file to list if not already there
                const filesEl = dock.querySelector('.dock-files');
                const existing = filesEl.querySelector(`[data-file="${CSS.escape(msg.file)}"]`);
                if (!existing) {
                    const entry = document.createElement('div');
                    entry.className = 'dock-file-entry';
                    entry.dataset.file = msg.file;
                    entry.innerHTML =
                        '<div class="dock-file-row">' +
                            '<span class="dock-file-toggle">&#9654;</span>' +
                            '<span class="dock-file-name" title="Click to review changes in editor">' + escapeHtml(msg.file) + '</span>' +
                            '<span class="dock-file-counts">' +
                                '<span class="dock-add">+' + msg.additions + '</span>' +
                                '<span class="dock-del">-' + msg.deletions + '</span>' +
                            '</span>' +
                            '<span class="dock-file-actions">' +
                                '<button class="file-btn-editor" title="Open side-by-side diff">&#128462;</button>' +
                                '<button class="file-btn-keep" title="Keep this file">&#10003;</button>' +
                                '<button class="file-btn-undo" title="Undo this file">&#8617;</button>' +
                            '</span>' +
                        '</div>' +
                        '<div class="dock-inline-diff hidden" data-diff-file="' + escapeHtml(msg.file) + '">' +
                            '<div class="dock-diff-loading">Loading diff\u2026</div>' +
                        '</div>';
                    // Click file name to open inline diff in main editor (GHCP-style)
                    entry.querySelector('.dock-file-name').addEventListener('click', (e) => {
                        e.stopPropagation();
                        vscode.postMessage({ type: 'showInlineDiff', file: msg.file });
                    });
                    // Click toggle arrow to expand/collapse sidebar diff preview
                    const toggleDiff = (e) => {
                        e.stopPropagation();
                        const diffPanel = entry.querySelector('.dock-inline-diff');
                        const toggle = entry.querySelector('.dock-file-toggle');
                        const isHidden = diffPanel.classList.contains('hidden');
                        if (isHidden) {
                            diffPanel.classList.remove('hidden');
                            toggle.classList.add('expanded');
                            if (diffPanel.querySelector('.dock-diff-loading')) {
                                vscode.postMessage({ type: 'requestFileDiff', file: msg.file });
                            }
                        } else {
                            diffPanel.classList.add('hidden');
                            toggle.classList.remove('expanded');
                        }
                    };
                    entry.querySelector('.dock-file-toggle').addEventListener('click', toggleDiff);
                    // Open side-by-side VS Code diff editor
                    entry.querySelector('.file-btn-editor').addEventListener('click', (e) => {
                        e.stopPropagation();
                        vscode.postMessage({ type: 'openFileDiff', file: msg.file });
                    });
                    // Per-file button listeners
                    entry.querySelector('.file-btn-keep').addEventListener('click', (e) => {
                        e.stopPropagation();
                        vscode.postMessage({ type: 'fileChangeFileAction', file: msg.file, action: 'keep' });
                    });
                    entry.querySelector('.file-btn-undo').addEventListener('click', (e) => {
                        e.stopPropagation();
                        vscode.postMessage({ type: 'fileChangeFileAction', file: msg.file, action: 'undo' });
                    });
                    filesEl.appendChild(entry);
                } else {
                    // Update counts on existing entry
                    const addEl = existing.querySelector('.dock-add');
                    const delEl = existing.querySelector('.dock-del');
                    if (addEl) addEl.textContent = '+' + msg.additions;
                    if (delEl) delEl.textContent = '-' + msg.deletions;
                    // Invalidate cached diff so next expand re-fetches
                    const diffPanel = existing.querySelector('.dock-inline-diff');
                    if (diffPanel && !diffPanel.classList.contains('hidden')) {
                        // Diff is visible — re-fetch updated content
                        vscode.postMessage({ type: 'requestFileDiff', file: msg.file });
                    } else if (diffPanel) {
                        // Mark as needing reload
                        diffPanel.innerHTML = '<div class="dock-diff-loading">Loading diff\u2026</div>';
                    }
                }

                // Update summary counts
                const allEntries = filesEl.querySelectorAll('.dock-file-entry');
                let totalAdd = 0, totalDel = 0;
                allEntries.forEach(e => {
                    totalAdd += parseInt(e.querySelector('.dock-add').textContent.slice(1)) || 0;
                    totalDel += parseInt(e.querySelector('.dock-del').textContent.slice(1)) || 0;
                });
                dock.querySelector('.dock-summary').textContent =
                    allEntries.length === 1 ? '1 file changed' : allEntries.length + ' files changed';
                dock.querySelector('.dock-counts .dock-add').textContent = '+' + totalAdd;
                dock.querySelector('.dock-counts .dock-del').textContent = '-' + totalDel;
                break;
            }
            case 'fileDiffContent': {
                const diffPanel = document.querySelector('.dock-inline-diff[data-diff-file="' + CSS.escape(msg.file) + '"]');
                if (!diffPanel) break;
                if (!msg.diff) {
                    diffPanel.innerHTML = '<div class="dock-diff-empty">No changes detected</div>';
                    break;
                }
                // Parse diff lines and render with syntax highlighting
                const lines = msg.diff.split('\n');
                let html = '<pre class="dock-diff-content">';
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    const escaped = escapeHtml(line.length > 2 ? line.substring(2) : '');
                    const prefix = line.substring(0, 2);
                    if (prefix === '+ ') {
                        html += '<div class="diff-line diff-line-add"><span class="diff-gutter">+</span><span class="diff-text">' + escaped + '</span></div>';
                    } else if (prefix === '- ') {
                        html += '<div class="diff-line diff-line-del"><span class="diff-gutter">\u2212</span><span class="diff-text">' + escaped + '</span></div>';
                    } else if (line === '  ---') {
                        html += '<div class="diff-line diff-line-sep"><span class="diff-gutter">\u22EE</span><span class="diff-text">\u2500\u2500\u2500</span></div>';
                    } else {
                        html += '<div class="diff-line diff-line-ctx"><span class="diff-gutter"> </span><span class="diff-text">' + escapeHtml(line.length > 2 ? line.substring(2) : line) + '</span></div>';
                    }
                }
                html += '</pre>';
                diffPanel.innerHTML = html;
                break;
            }
            case 'fileChangeResolved': {
                const dock = document.getElementById('file-change-dock');
                if (!dock) break;
                dock.classList.add('resolved');
                const actionsEl = dock.querySelector('.dock-actions');
                const cls = msg.action === 'kept' ? 'dock-resolved-kept' : 'dock-resolved-undone';
                const label = msg.action === 'kept' ? 'Kept' : 'Undone';
                actionsEl.innerHTML = '<span class="dock-resolved-label ' + cls + '">' + label + '</span>';
                break;
            }
            case 'fileChangeFileResolved': {
                const dock = document.getElementById('file-change-dock');
                if (!dock) break;
                const entry = dock.querySelector(`[data-file="${CSS.escape(msg.file)}"]`);
                if (entry) {
                    entry.classList.add('resolved');
                    const actionsSpan = entry.querySelector('.dock-file-actions');
                    if (actionsSpan) {
                        const statusCls = msg.action === 'kept' ? 'kept' : 'undone';
                        const statusLabel = msg.action === 'kept' ? '\u2713' : '\u21a9';
                        actionsSpan.innerHTML = '<span class="dock-file-status ' + statusCls + '">' + statusLabel + '</span>';
                    }
                }
                // Recalculate totals from non-resolved entries
                const filesEl = dock.querySelector('.dock-files');
                const remaining = filesEl.querySelectorAll('.dock-file-entry:not(.resolved)');
                const allEntries = filesEl.querySelectorAll('.dock-file-entry');
                let totalAdd = 0, totalDel = 0;
                remaining.forEach(e => {
                    totalAdd += parseInt(e.querySelector('.dock-add').textContent.slice(1)) || 0;
                    totalDel += parseInt(e.querySelector('.dock-del').textContent.slice(1)) || 0;
                });
                dock.querySelector('.dock-counts .dock-add').textContent = '+' + totalAdd;
                dock.querySelector('.dock-counts .dock-del').textContent = '-' + totalDel;
                const unresolvedCount = remaining.length;
                if (unresolvedCount === 0) {
                    dock.querySelector('.dock-summary').textContent = allEntries.length + ' files resolved';
                } else {
                    dock.querySelector('.dock-summary').textContent =
                        unresolvedCount === 1 ? '1 file remaining' : unresolvedCount + ' files remaining';
                }
                break;
            }
            case 'error': {
                showLocalError(msg.message);
                break;
            }
            case 'modelChanged': {
                if (modelSelectEl && msg.model) {
                    const opt = Array.from(modelSelectEl.options).find(o => o.textContent === msg.model || o.value === msg.model);
                    if (opt) {
                        modelSelectEl.value = opt.value;
                        currentActiveDeployment = opt.value;
                        updateModelTrigger();
                        renderModelOptions();
                    }
                }
                break;
            }
            case 'setModels': {
                setModels(msg.models, msg.activeDeployment, msg.reasoning);
                break;
            }
            case 'setAgentProviders': {
                setAgentProviders(msg.providers, msg.activeProvider);
                break;
            }
            case 'setAgentProvider': {
                if (providerSelectEl && msg.provider) {
                    providerSelectEl.value = msg.provider;
                }
                currentProvider = msg.provider || 'local';
                break;
            }
            case 'setPermissionLevel': {
                setPermissionLevel(msg.level || 'default');
                break;
            }
            case 'setChatMode': {
                setChatMode(msg.mode || 'agent');
                break;
            }
            case 'setCustomAgents': {
                customAgents = Array.isArray(msg.agents) ? msg.agents : [];
                activeCustomAgentId = msg.activeId || null;
                setChatMode(currentMode);
                break;
            }
            case 'setDevTeams': {
                devTeams = Array.isArray(msg.teams) ? msg.teams : [];
                activeDevTeamId = msg.activeId || null;
                setChatMode(currentMode);
                break;
            }
            case 'searchCitations': {
                renderSourcesCard(msg.agentName || 'Agent', msg.query || '', Array.isArray(msg.citations) ? msg.citations : []);
                scrollToBottom();
                break;
            }
            case 'planReady': {
                setPlanReadyVisibility(!!msg.visible);
                break;
            }
            case 'agentStarted': {
                pendingAgentDone = false;
                inputEl.disabled = true;
                inputEl.placeholder = currentMode === 'plan' ? 'Planning...' : currentMode === 'ask' ? 'Answering...' : 'Agent is working...';
                setAgentRunning(true);
                showGlobalWorkingIndicator(currentProvider === 'copilot-cli' ? 'Copilot CLI thinking' : 'Thinking');
                break;
            }
            case 'agentPlan': {
                renderPlan(msg.steps);
                break;
            }
            case 'sessionCleared': {
                closeLiveNarration();
                messagesEl.innerHTML = '';
                // Cancel any pending stream drain
                if (streamDrainTimer) { clearInterval(streamDrainTimer); streamDrainTimer = null; }
                if (streamRenderTimer) { clearTimeout(streamRenderTimer); streamRenderTimer = null; }
                pendingEndMessage = null;
                pendingAgentDone = false;
                streamBuffer = '';
                streamRawText = '';
                setAgentRunning(false);
                // Re-insert the working indicator (it was removed by innerHTML clear)
                if (workingEl) {
                    workingEl.classList.remove('active');
                    messagesEl.appendChild(workingEl);
                }
                currentAssistantEl = null;
                currentContentEl = null;
                currentAssistantTeam = null;
                toolStateById.clear();
                workingBlocksById.clear();
                workingEntriesById.clear();
                activeWorkingBlockId = null;
                clearAttachments();
                setPlanReadyVisibility(false);
                renderPlan([]);
                // Reset file-change dock
                const dockReset = document.getElementById('file-change-dock');
                if (dockReset) {
                    dockReset.classList.add('hidden');
                    dockReset.classList.remove('expanded', 'resolved');
                    dockReset.querySelector('.dock-files').innerHTML = '';
                    dockReset.querySelector('.dock-summary').textContent = '';
                    dockReset.querySelector('.dock-counts .dock-add').textContent = '+0';
                    dockReset.querySelector('.dock-counts .dock-del').textContent = '-0';
                    const actionsEl = dockReset.querySelector('.dock-actions');
                    actionsEl.innerHTML = '<button class="btn-keep">Keep All</button><button class="btn-undo">Undo All</button>';
                    actionsEl.querySelector('.btn-keep').addEventListener('click', () => {
                        vscode.postMessage({ type: 'fileChangeAction', action: 'keep' });
                    });
                    actionsEl.querySelector('.btn-undo').addEventListener('click', () => {
                        vscode.postMessage({ type: 'fileChangeAction', action: 'undo' });
                    });
                }
                break;
            }
            case 'setStatus': {
                if (msg.status) {
                    var liveBlock = getActiveWorkingBlock();
                    // Only show status bar for important/unusual messages
                    // Routine statuses (Thinking, Reading, etc.) are handled by working blocks
                    var isRoutine = /^(Thinking|Reading|Searching|Editing|Running command|Running tool|Checking|Continuing|Working)\b/i.test(msg.status);
                    if (!liveBlock && !isRoutine) {
                        statusEl.textContent = msg.status;
                        statusEl.classList.add('active');
                    } else {
                        statusEl.textContent = '';
                        statusEl.classList.remove('active');
                    }
                    inputEl.disabled = true;
                    inputEl.placeholder = 'Agent is working...';
                    setAgentRunning(true);
                    if (liveBlock) {
                        setWorkingBlockStatusText(liveBlock, msg.status);
                    }
                    if (liveBlock) {
                        hideGlobalWorkingIndicator();
                    } else {
                        showGlobalWorkingIndicator(getWorkingIndicatorText(msg.status));
                    }
                    scrollToBottom();
                } else {
                    statusEl.textContent = '';
                    statusEl.classList.remove('active');
                    if (!agentRunning) {
                        inputEl.disabled = false;
                        inputEl.placeholder = getModePlaceholder(currentMode);
                        inputEl.focus();
                    }
                    hideGlobalWorkingIndicator();
                    var activeBlock = getActiveWorkingBlock();
                    if (activeBlock) {
                        setWorkingBlockStatusText(activeBlock, '');
                    }
                }
                break;
            }
            case 'agentDone': {
                if (streamBuffer.length > 0 || streamDrainTimer) {
                    flushStreamBuffer();
                    if (currentContentEl && streamRawText.trim().length > 0) {
                        renderAssistantContent(currentContentEl, streamRawText, getCurrentAssistantRenderTeam());
                    }
                    pendingEndMessage = null;
                    currentAssistantEl = null;
                    currentContentEl = null;
                    currentAssistantTeam = null;
                    streamRawText = '';
                    streamBuffer = '';
                }
                inputEl.disabled = false;
                inputEl.placeholder = getModePlaceholder(currentMode);
                inputEl.focus();
                setAgentRunning(false);
                hideGlobalWorkingIndicator();
                // Remove any lingering continue-iteration dialog
                const continueDialog = messagesEl.querySelector('.continue-iteration-dialog');
                if (continueDialog) { continueDialog.remove(); }
                const liveBlock = getActiveWorkingBlock();
                if (liveBlock) {
                    finalizeWorkingBlock(liveBlock, liveBlock.data.summary || liveBlock.data.title, true);
                }
                activeWorkingBlockId = null;
                pendingAgentDone = true;
                finishAgentDoneWhenIdle();
                break;
            }
            case 'fileAttached': {
                // Extension read a workspace file and sent it back
                if (msg.name && msg.content) {
                    pendingFiles.push({ name: msg.name, content: msg.content });
                    refreshAttachPreview();
                }
                break;
            }
            case 'contextAttached': {
                if (msg.name && msg.content) {
                    pendingFiles.push({ name: msg.name, content: msg.content, contextKind: msg.kind });
                    refreshAttachPreview();
                }
                break;
            }
            case 'sessionList': {
                renderHistoryList(msg.sessions, msg.activeId);
                break;
            }
            case 'sessionSwitched': {
                // Panel was already cleared by sessionCleared — just close history
                historyPanel.classList.remove('open');
                break;
            }
            case 'toggleHistory': {
                toggleHistoryPanel();
                break;
            }
            case 'workingBlockStarted': {
                closeLiveNarration();
                if (activeWorkingBlockId && activeWorkingBlockId !== msg.block.id) {
                    const previousBlock = getActiveWorkingBlock();
                    if (previousBlock) {
                        previousBlock.el.classList.remove('live');
                    }
                }
                hideGlobalWorkingIndicator();
                createWorkingBlock(msg.block);
                activeWorkingBlockId = msg.block.id;
                scrollToBottom();
                break;
            }
            case 'workingTextAppended': {
                appendWorkingTextEntry(msg.blockId, msg.entry);
                scrollToBottom();
                break;
            }
            case 'workingActionAdded': {
                appendWorkingActionEntry(msg.blockId, msg.entry);
                scrollToBottom();
                break;
            }
            case 'workingActionUpdated': {
                updateWorkingActionEntry(msg.blockId, msg.entryId, msg);
                scrollToBottom();
                break;
            }
            case 'terminalOutput': {
                appendWorkingTerminalOutput(msg.line);
                break;
            }
            case 'workingBlockCompleted': {
                completeWorkingBlock(msg.blockId, msg.summary, msg.completedAt);
                scrollToBottom();
                break;
            }
            case 'narrationText': {
                appendNarrationText(msg.text || '');
                pinWorkingIndicatorToBottom();
                scrollToBottom();
                break;
            }
            case 'devTeamRoomEvent': {
                appendDevTeamRoomEvent(msg.event);
                pinWorkingIndicatorToBottom();
                scrollToBottom();
                break;
            }
            case 'reasoningStart': {
                startLiveReasoning();
                pinWorkingIndicatorToBottom();
                break;
            }
            case 'reasoningAppend': {
                appendReasoningText(msg.text || '');
                pinWorkingIndicatorToBottom();
                scrollToBottom();
                break;
            }
            case 'reasoningEnd': {
                closeLiveReasoning();
                break;
            }
            case 'tokenUsage': {
                // Update the SVG ring meter
                var meterFill = document.querySelector('#context-meter .meter-fill');
                var meterLabel = document.querySelector('#context-meter .meter-label');
                if (meterFill && meterLabel) {
                    var circumference = 2 * Math.PI * 8; // r=8 → ~50.27
                    var pctVal = msg.windowPct || 0;
                    var offset = circumference * (1 - pctVal / 100);
                    meterFill.setAttribute('stroke-dashoffset', String(offset));
                    meterLabel.textContent = pctVal + '%';
                    // Set tooltip on the meter
                    var meterEl = document.getElementById('context-meter');
                    if (meterEl) {
                        meterEl.title = 'Session Token Usage\n'
                            + '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n'
                            + msg.totalTokens + ' tokens (' + msg.requests + ' requests)\n'
                            + pctVal + '% of ' + msg.contextWindow + ' context window\n'
                            + '\n'
                            + 'Chat \u2014 ' + msg.chatTokens + ' (' + msg.chatPct + ')\n'
                            + '  Prompt:       ' + msg.chatPrompt + '  ' + msg.chatPromptPct + '\n'
                            + '  Completion:   ' + msg.chatCompletion + '  ' + msg.chatCompletionPct + '\n'
                            + '  Requests:     ' + msg.chatRequests + '\n'
                            + '\n'
                            + 'Inline \u2014 ' + msg.inlineTokens + ' (' + msg.inlinePct + ')\n'
                            + '  Prompt:       ' + msg.inlinePrompt + '  ' + msg.inlinePromptPct + '\n'
                            + '  Completion:   ' + msg.inlineCompletion + '  ' + msg.inlineCompletionPct + '\n'
                            + '  Requests:     ' + msg.inlineRequests + '\n'
                            + '\n'
                            + 'Click for details';
                    }
                    // Color the ring: green < 50%, yellow 50-75%, red > 75%
                    if (pctVal > 75) {
                        meterFill.style.stroke = 'var(--vscode-editorError-foreground, #f44)';
                    } else if (pctVal > 50) {
                        meterFill.style.stroke = 'var(--vscode-editorWarning-foreground, #fa0)';
                    } else {
                        meterFill.style.stroke = 'var(--vscode-progressBar-background, #0078d4)';
                    }
                }
                break;
            }
            case 'slashCommands': {
                slashCommands = msg.commands || [];
                slashPendingRequest = false;
                updateSlashAutocomplete();
                break;
            }
            case 'showSplash': {
                showSplashScreen(msg.showOnStartup);
                break;
            }
        }
    });

    // ── Splash Screen with Matrix Code Rain ──
    function showSplashScreen(showOnStartup) {
        if (document.getElementById('splash-overlay')) { return; }

        var overlay = document.createElement('div');
        overlay.id = 'splash-overlay';

        // Matrix rain canvas
        var canvas = document.createElement('canvas');
        canvas.id = 'splash-canvas';
        overlay.appendChild(canvas);

        // Content card
        var card = document.createElement('div');
        card.id = 'splash-card';
        card.innerHTML =
            '<h1>Junior</h1>' +
            '<p class="splash-subtitle">Your AI junior programmer</p>' +
            '<div class="splash-buttons">' +
                '<button class="splash-btn settings-btn" id="splash-settings">' +
                    '<i class="codicon codicon-gear"></i> Configure Settings' +
                '</button>' +
                '<button class="splash-btn apikey-btn" id="splash-apikey">' +
                    '<i class="codicon codicon-key"></i> Set API Key' +
                '</button>' +
            '</div>' +
            '<button class="splash-start" id="splash-start">Start Coding \u2192</button>' +
            '<div class="splash-checkbox">' +
                '<input type="checkbox" id="splash-startup-check"' + (showOnStartup ? ' checked' : '') + '>' +
                '<label for="splash-startup-check">Show this screen every time you start</label>' +
            '</div>';
        overlay.appendChild(card);
        document.body.appendChild(overlay);

        // Wire buttons
        document.getElementById('splash-settings').addEventListener('click', function () {
            vscode.postMessage({ type: 'splashOpenSettings' });
        });
        document.getElementById('splash-apikey').addEventListener('click', function () {
            vscode.postMessage({ type: 'splashSetApiKey' });
        });
        document.getElementById('splash-start').addEventListener('click', function () {
            dismissSplash();
        });

        function dismissSplash() {
            var chk = document.getElementById('splash-startup-check');
            vscode.postMessage({
                type: 'splashDismissed',
                showOnStartup: chk ? chk.checked : false
            });
            if (rainAnim) { cancelAnimationFrame(rainAnim); rainAnim = null; }
            overlay.style.opacity = '0';
            overlay.style.transition = 'opacity 0.4s';
            setTimeout(function () { overlay.remove(); }, 400);
        }

        // ── Matrix Rain Animation ──
        var ctx = canvas.getContext('2d');
        var rainAnim = null;
        var columns = [];
        var msColors = ['#F25022', '#7FBA00', '#00A4EF', '#FFB900'];
        var chars = '{}[]()<>=/;:.,!@#$%^&*0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
        var fontSize = 14;

        function resizeCanvas() {
            canvas.width = overlay.clientWidth;
            canvas.height = overlay.clientHeight;
            var colCount = Math.floor(canvas.width / fontSize);
            columns = [];
            for (var i = 0; i < colCount; i++) {
                columns[i] = Math.random() * canvas.height / fontSize;
            }
        }
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);

        function drawRain() {
            // Semi-transparent dark overlay for trail effect — blue-tinted
            ctx.fillStyle = 'rgba(0, 10, 25, 0.06)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.font = fontSize + 'px monospace';

            for (var i = 0; i < columns.length; i++) {
                var ch = chars[Math.floor(Math.random() * chars.length)];
                var color = msColors[Math.floor(Math.random() * msColors.length)];
                ctx.fillStyle = color;
                var x = i * fontSize;
                var y = columns[i] * fontSize;
                ctx.fillText(ch, x, y);

                if (y > canvas.height && Math.random() > 0.975) {
                    columns[i] = 0;
                }
                columns[i]++;
            }
            rainAnim = requestAnimationFrame(drawRain);
        }
        rainAnim = requestAnimationFrame(drawRain);
    }

    function getActiveWorkingBlock() {
        if (!activeWorkingBlockId) { return null; }
        return workingBlocksById.get(activeWorkingBlockId) || null;
    }

    function createWorkingBlock(block) {
        var titleText = block.title && block.title !== 'Working' ? block.title : '';
        var wrapper = document.createElement('div');
        wrapper.className = 'working-block-wrapper live' + (block.hidden ? ' hidden-working-block' : '');
        wrapper.dataset.blockId = block.id;

        var card = document.createElement('div');
        card.className = 'working-block expanded';
        card.innerHTML =
            '<div class="working-block-header">' +
                '<div class="wb-header-copy">' +
                    '<span class="wb-leading">Working</span>' +
                    '<span class="wb-title"' + (titleText ? '' : ' style="display:none"') + '>' + escapeHtml(titleText) + '</span>' +
                    '<span class="wb-summary"></span>' +
                '</div>' +
                '<span class="wb-chevron">\u25B6</span>' +
            '</div>' +
            '<div class="working-block-body">' +
                '<div class="wb-entries"></div>' +
            '</div>';
        wrapper.appendChild(card);

        var statusEl = document.createElement('div');
        statusEl.className = 'wb-live-status';
        statusEl.innerHTML = '<span class="wb-live-text">Working</span>';
        wrapper.appendChild(statusEl);

        var header = card.querySelector('.working-block-header');
        header.addEventListener('click', function() {
            if (wrapper.classList.contains('completed')) {
                card.classList.toggle('expanded');
            }
        });

        messagesEl.appendChild(wrapper);
        workingBlocksById.set(block.id, {
            data: block,
            el: wrapper,
            cardEl: card,
            entriesEl: card.querySelector('.wb-entries'),
            summaryEl: card.querySelector('.wb-summary'),
            titleEl: card.querySelector('.wb-title'),
            statusEl: statusEl,
            statusTextEl: statusEl.querySelector('.wb-live-text')
        });
    }

    function setWorkingBlockStatusText(record, text) {
        if (!record || !record.statusEl || !record.statusTextEl) { return; }
        var trimmed = (text || '').trim();
        if (!trimmed) {
            record.statusEl.style.display = 'none';
            record.statusTextEl.textContent = '';
            return;
        }
        record.statusEl.style.display = 'flex';
        record.statusTextEl.textContent = trimmed;
    }

    function createWorkingEntryElement(entry) {
        var row = document.createElement('div');
        row.className = 'wb-entry ' + entry.kind + (entry.kind === 'action' ? ' ' + entry.status : '');
        row.dataset.entryId = entry.id;

        if (entry.kind === 'progress') {
            row.innerHTML =
                '<span class="wb-progress-marker"></span>' +
                '<div class="wb-progress-text">' + renderMarkdownLite(entry.text) + '</div>';
            return row;
        }

        if (entry.kind === 'terminal') {
            row = document.createElement('pre');
            row.className = 'wb-terminal-output';
            row.dataset.entryId = entry.id;
            row.textContent = entry.text;
            return row;
        }

        row.innerHTML =
            '<span class="wb-action-icon">' + (PC_ICONS[entry.icon || 'loading'] || PC_ICONS.loading) + '</span>' +
            '<div class="wb-action-copy">' +
                '<div class="wb-action-text"></div>' +
                '<div class="wb-action-detail"></div>' +
            '</div>' +
            '<span class="wb-action-diff"></span>';
        renderWorkingActionRow(row, entry);
        return row;
    }

    function renderWorkingActionRow(row, entry) {
        row.className = 'wb-entry action ' + entry.status;
        var iconEl = row.querySelector('.wb-action-icon');
        if (iconEl) {
            iconEl.innerHTML = PC_ICONS[entry.icon || (entry.status === 'done' ? 'done' : entry.status === 'error' ? 'error' : 'loading')] || PC_ICONS.loading;
        }
        var textEl = row.querySelector('.wb-action-text');
        if (textEl) {
            textEl.innerHTML = entry.filePath ? labelWithFileLink(entry.text, entry.filePath) : escapeHtml(entry.text) + fileBadgeHtml(entry.text);
            textEl.title = entry.text || '';
            var fileLink = textEl.querySelector('.pc-file-link');
            if (fileLink && entry.filePath) {
                fileLink.addEventListener('click', function(e) {
                    e.stopPropagation();
                    vscode.postMessage({ type: 'openFile', filePath: entry.filePath });
                });
            }
        }
        var detailEl = row.querySelector('.wb-action-detail');
        if (detailEl) {
            detailEl.textContent = entry.detail || '';
            detailEl.title = entry.detail || '';
            detailEl.style.display = entry.detail ? 'block' : 'none';
        }
        var diffEl = row.querySelector('.wb-action-diff');
        if (diffEl && entry.additions != null) {
            diffEl.innerHTML = '<span class="diff-add">+' + entry.additions + '</span><span class="diff-del">-' + entry.deletions + '</span>';
        } else if (diffEl) {
            diffEl.innerHTML = '';
        }
    }

    function scrollWorkingBodyToBottom(record) {
        if (!record || !record.el) { return; }
        var body = record.el.querySelector('.working-block-body');
        if (body) {
            requestAnimationFrame(function () { body.scrollTop = body.scrollHeight; });
        }
    }

    function appendWorkingTextEntry(blockId, entry) {
        var record = workingBlocksById.get(blockId);
        if (!record) { return; }
        record.data.entries.push(entry);
        var row = createWorkingEntryElement(entry);
        record.entriesEl.appendChild(row);
        workingEntriesById.set(entry.id, { blockId: blockId, entry: entry, el: row });
        scrollWorkingBodyToBottom(record);
    }

    function appendWorkingActionEntry(blockId, entry) {
        var record = workingBlocksById.get(blockId);
        if (!record) { return; }
        record.data.entries.push(entry);
        var row = createWorkingEntryElement(entry);
        record.entriesEl.appendChild(row);
        workingEntriesById.set(entry.id, { blockId: blockId, entry: entry, el: row });
        scrollWorkingBodyToBottom(record);
    }

    function appendWorkingTerminalEntry(blockId, entry) {
        var record = workingBlocksById.get(blockId);
        if (!record) { return; }
        record.data.entries.push(entry);
        var row = createWorkingEntryElement(entry);
        record.entriesEl.appendChild(row);
        workingEntriesById.set(entry.id, { blockId: blockId, entry: entry, el: row });
        scrollWorkingBodyToBottom(record);
    }

    function updateWorkingActionEntry(blockId, entryId, patch) {
        var record = workingBlocksById.get(blockId);
        var entryRecord = workingEntriesById.get(entryId);
        if (!record || !entryRecord) { return; }
        entryRecord.entry.status = patch.status;
        if (patch.text) { entryRecord.entry.text = patch.text; }
        if (typeof patch.detail === 'string') { entryRecord.entry.detail = patch.detail; }
        if (typeof patch.filePath === 'string') { entryRecord.entry.filePath = patch.filePath; }
        if (typeof patch.icon === 'string') { entryRecord.entry.icon = patch.icon; }
        if (typeof patch.repeatCount === 'number') { entryRecord.entry.repeatCount = patch.repeatCount; }
        renderWorkingActionRow(entryRecord.el, entryRecord.entry);
        scrollWorkingBodyToBottom(record);
    }

    function appendWorkingTerminalOutput(line) {
        var record = getActiveWorkingBlock();
        if (!record) { return; }
        var termBlock = record.el.querySelector('.wb-terminal-output');
        if (!termBlock) {
            termBlock = document.createElement('pre');
            termBlock.className = 'wb-terminal-output';
            record.entriesEl.appendChild(termBlock);
        }
        var lineEl = document.createElement('span');
        lineEl.textContent = line + '\n';
        termBlock.appendChild(lineEl);
        while (termBlock.childNodes.length > 100) {
            termBlock.removeChild(termBlock.firstChild);
        }
        termBlock.scrollTop = termBlock.scrollHeight;
        scrollWorkingBodyToBottom(record);
        scrollToBottom();
    }

    function finalizeWorkingBlock(record, summary, collapse) {
        if (!record) { return; }
        record.data.status = 'completed';
        record.data.summary = summary || record.data.title || 'Completed';
        record.el.classList.remove('live');
        record.el.classList.add('completed');
        var cardEl = record.cardEl || record.el;
        cardEl.classList.add('completed');
        var leadingEl = record.el.querySelector('.wb-leading');
        if (leadingEl) {
            leadingEl.textContent = record.data.summary;
        }
        record.titleEl.style.display = 'none';
        record.summaryEl.textContent = '';
        setWorkingBlockStatusText(record, '');
        if (collapse) {
            cardEl.classList.remove('expanded');
        } else {
            cardEl.classList.add('expanded');
        }
    }

    function completeWorkingBlock(blockId, summary, completedAt) {
        var record = workingBlocksById.get(blockId);
        if (!record) { return; }
        record.data.completedAt = completedAt;
        // If the block has no entries, remove it from the DOM entirely
        var entryCount = record.entriesEl ? record.entriesEl.children.length : 0;
        if (entryCount === 0) {
            if (record.el.parentNode) { record.el.parentNode.removeChild(record.el); }
            workingBlocksById.delete(blockId);
        } else {
            finalizeWorkingBlock(record, summary, true);
        }
        if (activeWorkingBlockId === blockId) {
            activeWorkingBlockId = null;
        }
        if (agentRunning && !activeWorkingBlockId) {
            showGlobalWorkingIndicator(currentProvider === 'copilot-cli' ? 'Copilot CLI thinking' : 'Thinking');
        }
    }

    function formatJson(str) {
        try {
            return JSON.stringify(JSON.parse(str), null, 2);
        } catch (e) {
            return str;
        }
    }

    function safeParseJson(text) {
        try {
            return JSON.parse(text);
        } catch {
            return {};
        }
    }

    function summarizeToolActivity(name, args, success) {
        const a = args || {};
        if (!success) {
            switch (name) {
                case 'read_file': return 'Failed to read file: ' + (a.path || '(unknown)');
                case 'write_file': return 'Failed to write file: ' + (a.path || '(unknown)');
                case 'edit_file': return 'Failed to edit file: ' + (a.path || '(unknown)');
                case 'delete_file': return 'Failed to delete file: ' + (a.path || '(unknown)');
                case 'list_directory': return 'Failed to list directory: ' + (a.path || '.');
                case 'search_files': return 'File search failed: ' + (a.query || '(query)');
                case 'grep_search': return 'Text search failed: ' + (a.pattern || '(pattern)');
                case 'run_terminal_command': return 'Command failed: ' + (a.command || '(command)');
                default: return 'Failed: ' + name;
            }
        }

        switch (name) {
            case 'read_file': return 'Read file: ' + (a.path || '(unknown)');
            case 'write_file': return 'Wrote file: ' + (a.path || '(unknown)');
            case 'edit_file': return 'Edited file: ' + (a.path || '(unknown)');
            case 'delete_file': return 'Deleted file: ' + (a.path || '(unknown)');
            case 'list_directory': return 'Listed directory: ' + (a.path || '.');
            case 'search_files': return 'Searched file names for: ' + (a.query || '(query)');
            case 'grep_search': return 'Searched text pattern: ' + (a.pattern || '(pattern)');
            case 'semantic_search': return 'Semantic search: ' + (a.query || '(query)');
            case 'get_document_symbols': return 'Loaded symbols for: ' + (a.path || '(file)');
            case 'find_symbol': return 'Found symbol matches for: ' + (a.name || '(symbol)');
            case 'go_to_definition': return 'Resolved definition for: ' + (a.symbol || '(symbol)');
            case 'find_references': return 'Found references for: ' + (a.symbol || '(symbol)');
            case 'get_file_tree': return 'Loaded workspace file tree';
            case 'get_diagnostics': return 'Loaded diagnostics' + (a.path ? ' for ' + a.path : '');
            case 'get_open_editors': return 'Loaded open editors';
            case 'apply_code_action': return (a.apply ? 'Applied fix: ' : 'Listed fixes at ') + (a.path || '(file)') + ':' + (a.line || '?');
            case 'run_terminal_command': return 'Ran command: ' + truncate(String(a.command || '(command)'), 80);
            default: return 'Completed: ' + name;
        }
    }

    function truncate(text, max) {
        if (text.length <= max) return text;
        return text.slice(0, max) + '\n... (truncated)';
    }

    // --- Plan panel toggle ---
    if (planPanelEl) {
        planPanelEl.querySelector('.plan-header').addEventListener('click', () => {
            planPanelEl.classList.toggle('expanded');
        });
    }

    // --- Dock event listeners ---
    const dockEl = document.getElementById('file-change-dock');
    if (dockEl) {
        // Keep button
        dockEl.querySelector('.btn-keep').addEventListener('click', () => {
            vscode.postMessage({ type: 'fileChangeAction', action: 'keep' });
        });
        // Undo button
        dockEl.querySelector('.btn-undo').addEventListener('click', () => {
            vscode.postMessage({ type: 'fileChangeAction', action: 'undo' });
        });
        // Expand / collapse toggle
        dockEl.querySelector('.dock-header').addEventListener('click', (e) => {
            if (e.target.closest('.btn-keep') || e.target.closest('.btn-undo')) return;
            dockEl.classList.toggle('expanded');
        });
    }

    // Signal ready
    vscode.postMessage({ type: 'ready' });
})();

