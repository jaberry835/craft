// @ts-nocheck
// JuniorGH webview script — loaded as an external file to avoid template-literal escaping issues.

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
    const workingEl = document.getElementById('working-indicator');
    const workingTextEl = document.getElementById('working-text');

    const btnAttach = document.getElementById('btn-attach');
    const btnSend = document.getElementById('btn-send');
    const btnTools = document.getElementById('btn-tools');
    const attachPreview = document.getElementById('attach-preview');
    const historyPanel = document.getElementById('history-panel');
    const historyList = document.getElementById('history-list');
    let currentAssistantEl = null;
    let currentContentEl = null;
    let agentRunning = false;
    const toolStateById = new Map();
    const workingBlocksById = new Map();
    const workingEntriesById = new Map();
    let activeWorkingBlockId = null;

    // ── Elapsed timer state ──
    let agentStartedTime = 0;
    let elapsedTimerHandle = null;

    function startElapsedTimer() {
        stopElapsedTimer();
        elapsedTimerHandle = setInterval(function() {
            if (!agentRunning || !agentStartedTime) { return; }
            var secs = Math.floor((Date.now() - agentStartedTime) / 1000);
            if (secs < 2) { return; } // Don't show for very short waits
            var elapsed = secs < 60 ? secs + 's' : Math.floor(secs / 60) + 'm ' + (secs % 60) + 's';
            // Append elapsed time to the working indicator text
            if (workingEl && workingEl.classList.contains('active')) {
                var base = workingTextEl.textContent.replace(/\s*\(\d+[ms]\s*\d*[s]?\)$/, '');
                workingTextEl.textContent = base + ' (' + elapsed + ')';
            }
        }, 1000);
    }

    function stopElapsedTimer() {
        if (elapsedTimerHandle) {
            clearInterval(elapsedTimerHandle);
            elapsedTimerHandle = null;
        }
        agentStartedTime = 0;
    }

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
        const msg = { type: 'sendMessage', text: text || '(see attachments)' };
        if (pendingImages.length > 0) { msg.images = pendingImages.slice(); }
        if (pendingFiles.length > 0) { msg.files = pendingFiles.slice(); }
        vscode.postMessage(msg);
        inputEl.value = '';
        inputEl.style.height = 'auto';
        clearAttachments();
        closeSlashAutocomplete();
    }


    if (btnAttach) {
        btnAttach.addEventListener('click', () => vscode.postMessage({ type: 'attachFile' }));
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
        if (!btnSend) return;
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

    function setModels(models, activeDeployment, disabled, title) {
        if (!modelSelectEl) { return; }
        const current = activeDeployment || modelSelectEl.value;
        modelSelectEl.innerHTML = '';
        if (title) {
            modelSelectEl.title = title;
        }
        if (!models || models.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'No models configured';
            modelSelectEl.appendChild(opt);
            modelSelectEl.disabled = true;
            return;
        }

        for (const m of models) {
            const opt = document.createElement('option');
            opt.value = m.deploymentId;
            opt.textContent = m.name;
            modelSelectEl.appendChild(opt);
        }
        modelSelectEl.disabled = !!disabled;
        if (current) {
            modelSelectEl.value = current;
        }
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
            pill.innerHTML = '<img src="' + dataUri + '" class="attach-thumb"/>' +
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
            pill.className = 'attach-pill file-pill';
            pill.innerHTML = '<span class="attach-file-icon">&#128196;</span>' +
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
        currentContentEl.innerHTML = renderMarkdownLite(streamRawText);
        if (atBottom) { scrollToBottom(); }
    }

    function flushAssistantStreamNow() {
        if (streamDrainTimer) { clearInterval(streamDrainTimer); streamDrainTimer = null; }
        if (streamRenderTimer) { clearTimeout(streamRenderTimer); streamRenderTimer = null; }
        if (streamBuffer.length > 0) {
            streamRawText += streamBuffer;
            streamBuffer = '';
        }
        renderStreamMarkdown();
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
    function finalizeAssistantMessage() {
        if (!pendingEndMessage) { return; }
        var els = pendingEndMessage;
        pendingEndMessage = null;
        if (els.contentEl) {
            var rawText = streamRawText.trim();
            if (rawText.length > 0) {
                els.contentEl.innerHTML = renderMarkdownLite(streamRawText);
            } else {
                if (els.assistantEl && els.assistantEl.parentNode) {
                    els.assistantEl.parentNode.removeChild(els.assistantEl);
                }
            }
        }
        currentAssistantEl = null;
        currentContentEl = null;
        streamRawText = '';
        streamBuffer = '';
        scrollToBottom();
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ── Unique ID for copy buttons ──
    let codeBlockId = 0;

    function renderMarkdownLite(text) {
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

        // Markdown tables: detect consecutive lines with pipe-delimited cells.
        // Match a header row, a separator row (|---|...), and one or more data rows.
        html = html.replace(/((?:^|\n)\|.+\|)\n\|[-:\s|]+\|\n((?:\|.+\|\n?)+)/g, function(match, headerLine, bodyBlock) {
            function parseCells(line) {
                return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(function(c) { return c.trim(); });
            }
            var headers = parseCells(headerLine.replace(/^\n/, ''));
            var thRow = '<tr>' + headers.map(function(h) { return '<th>' + h + '</th>'; }).join('') + '</tr>';
            var bodyRows = bodyBlock.trim().split('\n').map(function(line) {
                var cells = parseCells(line);
                return '<tr>' + cells.map(function(c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
            }).join('');
            return '<table>' + '<thead>' + thRow + '</thead>' + '<tbody>' + bodyRows + '</tbody>' + '</table>';
        });

        // Restore fenced code blocks
        html = html.replace(/%%CODEBLOCK_(\d+)%%/g, function(match, idx) {
            return codeBlocks[parseInt(idx, 10)] || '';
        });

        // Strip excess blank lines around block-level elements to avoid double-spacing
        // with white-space:pre-wrap (block margins + visible newlines = too much space).
        html = html.replace(/\n{2,}(?=<(?:h[1-3]|ul|ol|div|pre|table)[\s>])/g, '\n');
        html = html.replace(/(<\/(?:h[1-3]|ul|ol|div|pre|table)>)\n{2,}/g, '$1\n');

        // Wrap runs of bare text (between block elements) into <p> tags for proper spacing.
        // Only skip lines that start with known block-level HTML tags.
        var blockTagRe = /^<(?:h[1-3]|ul|ol|div|pre|table|thead|tbody|p|blockquote)[\s>\/]/;
        html = html.replace(/(^|\n)([^\n]+(?:\n(?!<(?:h[1-3]|ul|ol|div|pre|table|thead|tbody|p|blockquote)[\s>\/])[^\n]+)*)(?=\n|$)/g, function(match, prefix, content) {
            var trimmed = content.trim();
            if (!trimmed) { return match; }
            if (blockTagRe.test(trimmed)) { return match; }
            return prefix + '<p>' + trimmed.replace(/\n/g, '<br>') + '</p>';
        });

        // Final guard: drop any <hr> tags that could have slipped from model text transforms.
        html = html.replace(/<hr\s*\/?>/gi, '');
        // Final guard: remove any line that is still only rule-like punctuation after transforms.
        html = html.replace(/(^|\n)\s*[-_=*~\u2500-\u2503\u2012-\u2015]{8,}\s*(?=\n|$)/g, '$1');

        return html;
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
                const el = document.createElement('div');
                el.className = 'msg user';
                let inner = '<div class="label">You</div>';
                // Show attached images
                if (msg.images && msg.images.length > 0) {
                    inner += '<div class="user-attachments">';
                    for (const src of msg.images) {
                        inner += '<img src="' + src + '" class="user-attach-img" />';
                    }
                    inner += '</div>';
                }
                // Show attached file names
                if (msg.fileNames && msg.fileNames.length > 0) {
                    inner += '<div class="user-attachments">';
                    for (const name of msg.fileNames) {
                        inner += '<span class="user-attach-file">&#128196; ' + escapeHtml(name) + '</span>';
                    }
                    inner += '</div>';
                }
                inner += '<div class="content">' + escapeHtml(msg.text) + '</div>';
                el.innerHTML = inner;
                messagesEl.appendChild(el);
                scrollToBottom();
                break;
            }
            case 'startAssistantMessage': {
                // Hide status bar + working indicator — inline content takes over
                statusEl.textContent = '';
                statusEl.classList.remove('active');
                if (workingEl) { workingEl.classList.remove('active'); }
                currentAssistantEl = document.createElement('div');
                currentAssistantEl.className = 'msg assistant';
                currentContentEl = document.createElement('div');
                currentContentEl.className = 'content';
                currentAssistantEl.appendChild(currentContentEl);
                messagesEl.appendChild(currentAssistantEl);
                streamRawText = '';
                streamBuffer = '';
                scrollToBottom();
                break;
            }
            case 'appendAssistantText': {
                if (currentContentEl) {
                    streamRawText += msg.text;
                    renderStreamMarkdown();
                }
                break;
            }
            case 'endAssistantMessage': {
                flushAssistantStreamNow();
                if (currentContentEl) {
                    var rawText = streamRawText.trim();
                    if (rawText.length > 0) {
                        currentContentEl.innerHTML = renderMarkdownLite(streamRawText);
                    } else {
                        if (currentAssistantEl && currentAssistantEl.parentNode) {
                            currentAssistantEl.parentNode.removeChild(currentAssistantEl);
                        }
                    }
                }
                currentAssistantEl = null;
                currentContentEl = null;
                streamRawText = '';
                streamBuffer = '';
                pendingEndMessage = null;
                // Re-show thinking spinner if agent is still running between phases
                if (agentRunning && workingEl && !activeWorkingBlockId) {
                    workingTextEl.textContent = 'Thinking...';
                    workingEl.classList.add('active');
                    messagesEl.appendChild(workingEl);
                }
                scrollToBottom();
                break;
            }
            case 'toolCall': {
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
                // Auto-dismiss: remove dialog when session approval auto-resolved it
                if (msg.category === '__dismiss__') {
                    const existing = messagesEl.querySelector('.confirm-dialog[data-action-id="' + CSS.escape(msg.actionId) + '"]');
                    if (existing) { existing.remove(); }
                    break;
                }
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
                scrollToBottom();
                break;
            }
            case 'continueIteration': {
                const dialog = document.createElement('div');
                dialog.className = 'continue-iteration-dialog';
                dialog.innerHTML =
                    '<p>Continue to iterate?</p>' +
                    '<div class="continue-subtitle">JuniorGH has been working on this problem for a while (' + msg.iterationCount + ' iterations). It can continue to iterate, or you can send a new message to refine your prompt.</div>' +
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
                    }
                }
                break;
            }
            case 'setModels': {
                setModels(msg.models, msg.activeDeployment, msg.disabled, msg.title);
                break;
            }
            case 'agentPlan': {
                renderPlan(msg.steps);
                break;
            }
            case 'sessionCleared': {
                messagesEl.innerHTML = '';
                // Cancel any pending stream drain
                if (streamDrainTimer) { clearInterval(streamDrainTimer); streamDrainTimer = null; }
                if (streamRenderTimer) { clearTimeout(streamRenderTimer); streamRenderTimer = null; }
                pendingEndMessage = null;
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
                workingBlocksById.clear();
                workingEntriesById.clear();
                activeWorkingBlockId = null;
                clearAttachments();
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
                    statusEl.textContent = msg.status;
                    statusEl.classList.add('active');
                    inputEl.disabled = true;
                    inputEl.placeholder = 'Agent is working...';
                    setAgentRunning(true);
                    var liveBlock = getActiveWorkingBlock();
                    if (liveBlock) {
                        setWorkingBlockStatusText(liveBlock, msg.status);
                    }
                    if (liveBlock) {
                        if (workingEl) { workingEl.classList.remove('active'); }
                    } else {
                        if (workingEl) {
                            workingTextEl.textContent = 'Thinking...';
                            workingEl.classList.add('active');
                            messagesEl.appendChild(workingEl);
                        }
                    }
                    scrollToBottom();
                } else {
                    statusEl.textContent = '';
                    statusEl.classList.remove('active');
                    inputEl.disabled = false;
                    inputEl.placeholder = 'Ask JuniorGH anything...';
                    inputEl.focus();
                    setAgentRunning(false);
                    if (workingEl) { workingEl.classList.remove('active'); }
                    var activeBlock = getActiveWorkingBlock();
                    if (activeBlock) {
                        setWorkingBlockStatusText(activeBlock, '');
                    }
                }
                break;
            }
            case 'agentDone': {
                inputEl.disabled = false;
                inputEl.placeholder = 'Ask JuniorGH anything...';
                inputEl.focus();
                setAgentRunning(false);
                stopElapsedTimer();
                statusEl.textContent = '';
                statusEl.classList.remove('active');
                if (workingEl) { workingEl.classList.remove('active'); }
                // Remove any lingering continue-iteration dialog
                const continueDialog = messagesEl.querySelector('.continue-iteration-dialog');
                if (continueDialog) { continueDialog.remove(); }
                const liveBlock = getActiveWorkingBlock();
                if (liveBlock) {
                    finalizeWorkingBlock(liveBlock, liveBlock.data.summary || liveBlock.data.title, true);
                }
                activeWorkingBlockId = null;
                break;
            }
            case 'agentStarted': {
                // Activate stop button + thinking indicator at bottom of messages.
                // No status bar — that's only for detailed native runtime statuses.
                inputEl.disabled = true;
                inputEl.placeholder = 'Agent is working...';
                setAgentRunning(true);
                agentStartedTime = Date.now();
                startElapsedTimer();
                if (workingEl) {
                    workingTextEl.textContent = 'Thinking...';
                    workingEl.classList.add('active');
                    messagesEl.appendChild(workingEl);
                }
                scrollToBottom();
                break;
            }
            case 'thinkingText': {
                // Live thinking text streamed from the CLI — update the indicator
                // to show what the agent is actually doing instead of static "Thinking..."
                var snippet = (msg.text || '').trim();
                // Truncate long thinking text for the indicator display
                if (snippet.length > 120) {
                    snippet = snippet.substring(0, 117) + '…';
                }
                if (snippet) {
                    // When a working block is active, only update its status —
                    // hide the floating indicator to avoid duplicate text.
                    if (activeWorkingBlockId) {
                        var wbRecord = workingBlocksById.get(activeWorkingBlockId);
                        if (wbRecord) {
                            setWorkingBlockStatusText(wbRecord, snippet);
                        }
                        if (workingEl) { workingEl.classList.remove('active'); }
                    } else {
                        if (workingEl) {
                            workingTextEl.textContent = snippet;
                            // Re-show indicator if agent is running but it was hidden
                            // (e.g. after an assistant message was closed during a long pause)
                            if (agentRunning && !workingEl.classList.contains('active')) {
                                workingEl.classList.add('active');
                                messagesEl.appendChild(workingEl);
                            }
                        }
                    }
                }
                scrollToBottom();
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
                // Hide status bar + working indicator — working block takes over
                statusEl.textContent = '';
                statusEl.classList.remove('active');
                if (workingEl) { workingEl.classList.remove('active'); }
                if (activeWorkingBlockId && activeWorkingBlockId !== msg.block.id) {
                    const previousBlock = getActiveWorkingBlock();
                    if (previousBlock) {
                        previousBlock.el.classList.remove('live');
                    }
                }
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
                // Re-show thinking spinner if agent is still running between phases
                if (agentRunning && workingEl) {
                    workingTextEl.textContent = 'Thinking...';
                    workingEl.classList.add('active');
                    messagesEl.appendChild(workingEl);
                }
                scrollToBottom();
                break;
            }
            case 'narrationText': {
                // Hide status bar + working indicator when narration appears
                statusEl.textContent = '';
                statusEl.classList.remove('active');
                if (workingEl) { workingEl.classList.remove('active'); }
                var narRow = document.createElement('div');
                narRow.className = 'narration-row';
                narRow.innerHTML = renderMarkdownLite(msg.text);
                messagesEl.appendChild(narRow);
                scrollToBottom();
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
                    meterLabel.textContent = msg.totalTokens + ' / ' + msg.contextWindow + ' (' + pctVal + '%)';
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
                // Re-trigger autocomplete now that we have the list
                updateSlashAutocomplete();
                break;
            }
        }
    });

    function getActiveWorkingBlock() {
        if (!activeWorkingBlockId) { return null; }
        return workingBlocksById.get(activeWorkingBlockId) || null;
    }

    function createWorkingBlock(block) {
        var card = document.createElement('div');
        card.className = 'working-block live expanded';
        card.dataset.blockId = block.id;
        card.innerHTML =
            '<div class="working-block-header">' +
                '<div class="wb-header-copy">' +
                    '<span class="wb-leading">Working</span>' +
                    '<span class="wb-title">' + escapeHtml(block.title || 'Working') + '</span>' +
                    '<span class="wb-summary"></span>' +
                '</div>' +
                '<span class="wb-chevron">\u25B6</span>' +
            '</div>' +
            '<div class="working-block-body">' +
                '<div class="wb-entries"></div>' +
            '</div>';

        // Live status sits below the card as a sibling so it's always visible
        var statusEl = document.createElement('div');
        statusEl.className = 'wb-live-status';
        statusEl.innerHTML = '<span class="spinner-sm"></span><span class="wb-live-text">Working</span>';

        var header = card.querySelector('.working-block-header');
        header.addEventListener('click', function() {
            if (card.classList.contains('completed')) {
                card.classList.toggle('expanded');
            }
        });

        messagesEl.appendChild(card);
        messagesEl.appendChild(statusEl);
        workingBlocksById.set(block.id, {
            data: block,
            el: card,
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
        scrollToBottom();
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
            var fileLink = textEl.querySelector('.pc-file-link');
            if (fileLink && entry.filePath) {
                fileLink.addEventListener('click', function(e) {
                    e.stopPropagation();
                    var isWrite = entry.actionType === 'edit' || entry.actionType === 'create';
                    vscode.postMessage(isWrite
                        ? { type: 'openFileDiff', file: entry.filePath }
                        : { type: 'openFile', filePath: entry.filePath });
                });
            }
        }
        var detailEl = row.querySelector('.wb-action-detail');
        if (detailEl) {
            detailEl.textContent = entry.detail || '';
            detailEl.style.display = entry.detail ? 'block' : 'none';
        }
        var diffEl = row.querySelector('.wb-action-diff');
        if (diffEl && entry.additions != null) {
            diffEl.innerHTML = '<span class="diff-add">+' + entry.additions + '</span><span class="diff-del">-' + entry.deletions + '</span>';
        } else if (diffEl) {
            diffEl.innerHTML = '';
        }
    }

    function scrollWorkingBody(record) {
        var body = record && record.el && record.el.querySelector('.working-block-body');
        if (body) { body.scrollTop = body.scrollHeight; }
        // Also scroll the outer messages container so new entries stay visible
        scrollToBottom();
    }

    function appendWorkingTextEntry(blockId, entry) {
        var record = workingBlocksById.get(blockId);
        if (!record) { return; }
        record.data.entries.push(entry);
        var row = createWorkingEntryElement(entry);
        record.entriesEl.appendChild(row);
        workingEntriesById.set(entry.id, { blockId: blockId, entry: entry, el: row });
        scrollWorkingBody(record);
    }

    function appendWorkingActionEntry(blockId, entry) {
        var record = workingBlocksById.get(blockId);
        if (!record) { return; }
        record.data.entries.push(entry);
        var row = createWorkingEntryElement(entry);
        record.entriesEl.appendChild(row);
        workingEntriesById.set(entry.id, { blockId: blockId, entry: entry, el: row });
        scrollWorkingBody(record);
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
        renderWorkingActionRow(entryRecord.el, entryRecord.entry);
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
        scrollToBottom();
    }

    function finalizeWorkingBlock(record, summary, collapse) {
        if (!record) { return; }
        record.data.status = 'completed';
        record.data.summary = summary || record.data.title || 'Completed';
        record.el.classList.remove('live');
        record.el.classList.add('completed');
        // Replace header: show summary as the leading text (like GHCP "Created 5 todos and reviewed 6 files")
        var leadingEl = record.el.querySelector('.wb-leading');
        if (leadingEl) {
            leadingEl.textContent = record.data.summary;
        }
        record.titleEl.style.display = 'none';
        record.summaryEl.textContent = '';
        // Remove the external live-status element
        if (record.statusEl && record.statusEl.parentNode) {
            record.statusEl.parentNode.removeChild(record.statusEl);
        }
        if (collapse) {
            record.el.classList.remove('expanded');
        } else {
            record.el.classList.add('expanded');
        }
    }

    function completeWorkingBlock(blockId, summary, completedAt) {
        var record = workingBlocksById.get(blockId);
        if (!record) { return; }
        record.data.completedAt = completedAt;
        // If the block has no entries, remove it and its status element from the DOM entirely
        var entryCount = record.entriesEl ? record.entriesEl.children.length : 0;
        if (entryCount === 0) {
            if (record.el.parentNode) { record.el.parentNode.removeChild(record.el); }
            if (record.statusEl && record.statusEl.parentNode) { record.statusEl.parentNode.removeChild(record.statusEl); }
            workingBlocksById.delete(blockId);
        } else {
            finalizeWorkingBlock(record, summary, true);
        }
        if (activeWorkingBlockId === blockId) {
            activeWorkingBlockId = null;
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


