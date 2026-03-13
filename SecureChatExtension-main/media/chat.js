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
    const workingEl = document.getElementById('working-indicator');
    const workingTextEl = document.getElementById('working-text');

    const btnAttach = document.getElementById('btn-attach');
    const attachPreview = document.getElementById('attach-preview');
    const historyPanel = document.getElementById('history-panel');
    const historyList = document.getElementById('history-list');
    let currentAssistantEl = null;
    let currentContentEl = null;
    const toolStateById = new Map();

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
                btnHistory.classList.remove('active');
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
    }


    if (btnAttach) {
        btnAttach.addEventListener('click', () => vscode.postMessage({ type: 'attachFile' }));
    }

    if (modelSelectEl) {
        modelSelectEl.addEventListener('change', () => {
            const deploymentId = modelSelectEl.value;
            if (deploymentId) {
                vscode.postMessage({ type: 'selectModelById', deploymentId });
            }
        });
    }

    function setModels(models, activeDeployment) {
        if (!modelSelectEl) { return; }
        const current = activeDeployment || modelSelectEl.value;
        modelSelectEl.innerHTML = '';
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
        modelSelectEl.disabled = false;
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
            planPanelEl.innerHTML = '';
            planPanelEl.style.display = 'none';
            return;
        }

        const rows = steps.map(s => {
            return '<div class="plan-step ' + s.status + '">' +
                '<span class="dot"></span>' +
                '<span class="label">' + escapeHtml(s.title) + '</span>' +
            '</div>';
        }).join('');

        planPanelEl.innerHTML = '<div class="plan-title">Plan</div>' + rows;
        planPanelEl.style.display = 'block';
    }

    function scrollToBottom() {
        requestAnimationFrame(() => {
            messagesEl.scrollTop = messagesEl.scrollHeight;
        });
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

        // Restore fenced code blocks
        html = html.replace(/%%CODEBLOCK_(\d+)%%/g, function(match, idx) {
            return codeBlocks[parseInt(idx, 10)] || '';
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
                currentAssistantEl = document.createElement('div');
                currentAssistantEl.className = 'msg assistant';
                currentContentEl = document.createElement('div');
                currentContentEl.className = 'content';
                currentAssistantEl.appendChild(currentContentEl);
                messagesEl.appendChild(currentAssistantEl);
                scrollToBottom();
                break;
            }
            case 'appendAssistantText': {
                if (currentContentEl) {
                    currentContentEl.textContent += msg.text;
                }
                scrollToBottom();
                break;
            }
            case 'endAssistantMessage': {
                if (currentContentEl) {
                    currentContentEl.innerHTML = renderMarkdownLite(currentContentEl.textContent || '');
                }
                currentAssistantEl = null;
                currentContentEl = null;
                scrollToBottom();
                break;
            }
            case 'toolCall': {
                const block = document.createElement('div');
                block.className = 'tool-block';
                block.dataset.toolId = msg.id;
                toolStateById.set(msg.id, {
                    name: msg.name,
                    args: safeParseJson(msg.args || '{}')
                });
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
                dialog.innerHTML =
                    '<p>&#9888; ' + escapeHtml(msg.description) + '</p>' +
                    '<div class="confirm-actions">' +
                        '<button class="btn-approve">Allow</button>' +
                        '<button class="btn-session">Allow for Session</button>' +
                        '<button class="btn-deny">Deny</button>' +
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
                setModels(msg.models, msg.activeDeployment);
                break;
            }
            case 'agentPlan': {
                renderPlan(msg.steps);
                break;
            }
            case 'sessionCleared': {
                messagesEl.innerHTML = '';
                // Re-insert the working indicator (it was removed by innerHTML clear)
                if (workingEl) {
                    workingEl.classList.remove('active');
                    messagesEl.appendChild(workingEl);
                }
                currentAssistantEl = null;
                currentContentEl = null;
                clearAttachments();
                renderPlan([]);
                break;
            }
            case 'setStatus': {
                if (msg.status) {
                    statusEl.textContent = msg.status;
                    statusEl.classList.add('active');
                    inputEl.disabled = true;
                    inputEl.placeholder = 'Agent is working...';
                    // Show inline spinner at bottom of messages
                    if (workingEl) {
                        workingTextEl.textContent = msg.status;
                        workingEl.classList.add('active');
                        // Keep spinner at the very end
                        messagesEl.appendChild(workingEl);
                        scrollToBottom();
                    }
                } else {
                    statusEl.textContent = '';
                    statusEl.classList.remove('active');
                    inputEl.disabled = false;
                    inputEl.placeholder = 'Ask Junior anything...';
                    inputEl.focus();
                    if (workingEl) { workingEl.classList.remove('active'); }
                }
                break;
            }
            case 'agentDone': {
                inputEl.disabled = false;
                inputEl.placeholder = 'Ask Junior anything...';
                inputEl.focus();
                if (workingEl) { workingEl.classList.remove('active'); }
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
        }
    });

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
            return 'Failed: ' + name;
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

    // Signal ready
    vscode.postMessage({ type: 'ready' });
})();

