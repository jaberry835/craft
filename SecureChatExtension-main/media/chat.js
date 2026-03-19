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
    let activeProgressCard = null;  // the current .progress-card element
    let activeProgressTimeline = null; // the .pc-timeline inside it
    let pcBatchState = null; // tracks consecutive same-tool batching: { toolName, icon, count, items[], stepEl }
    let pcCurrentPlanTitle = null; // the plan step title the active card is tracking

    // Progress card icon map (icon name → unicode/emoji)
    const PC_ICONS = {
        search: '\uD83D\uDD0D',   // 🔍
        read: '\uD83D\uDCC4',     // 📄
        edit: '\u270F',            // ✏
        run: '\u25B6',             // ▶
        check: '\u2714',           // ✔
        loading: '\u25CF',         // ●
        done: '\u2713',            // ✓
        error: '\u2717'            // ✗
    };

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
                    var rawText = (currentContentEl.textContent || '').trim();
                    if (rawText.length > 0) {
                        currentContentEl.innerHTML = renderMarkdownLite(currentContentEl.textContent || '');
                    } else {
                        // Remove empty assistant bubble (model only made tool calls, no text)
                        if (currentAssistantEl && currentAssistantEl.parentNode) {
                            currentAssistantEl.parentNode.removeChild(currentAssistantEl);
                        }
                    }
                }
                currentAssistantEl = null;
                currentContentEl = null;
                scrollToBottom();
                break;
            }
            case 'toolCall': {
                toolStateById.set(msg.id, {
                    name: msg.name,
                    args: safeParseJson(msg.args || '{}')
                });
                // When a progress card is active, suppress the standalone tool-block
                if (activeProgressCard) { break; }
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
                // When a progress card is active, suppress the standalone tool-block result
                if (activeProgressCard) {
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
                scrollToBottom();
                break;
            }
            case 'fileChangeTick': {
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
                        '<span class="dock-file-name" title="Click to review changes">' + escapeHtml(msg.file) + '</span>' +
                        '<span class="dock-file-counts">' +
                            '<span class="dock-add">+' + msg.additions + '</span>' +
                            '<span class="dock-del">-' + msg.deletions + '</span>' +
                        '</span>' +
                        '<span class="dock-file-actions">' +
                            '<button class="file-btn-keep" title="Keep this file">&#10003;</button>' +
                            '<button class="file-btn-undo" title="Undo this file">&#8617;</button>' +
                        '</span>';
                    // Click file name to open diff
                    entry.querySelector('.dock-file-name').addEventListener('click', (e) => {
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
                setModels(msg.models, msg.activeDeployment);
                break;
            }
            case 'agentPlan': {
                renderPlan(msg.steps);
                // Detect plan step change and split the progress card
                if (msg.steps && activeProgressCard) {
                    var inProgress = msg.steps.find(function(s) { return s.status === 'in_progress'; });
                    var newPlanTitle = inProgress ? inProgress.title : null;
                    if (newPlanTitle && newPlanTitle !== pcCurrentPlanTitle) {
                        var hasSteps = activeProgressCard.querySelectorAll('.pc-step').length > 0;
                        if (hasSteps) {
                            // Card has content — close it and open a new one for the new step
                            closeCurrentProgressCard();
                            openProgressCard(newPlanTitle);
                        } else {
                            // Card is brand new (no steps yet) — just update the title to match
                            var titleEl = activeProgressCard.querySelector('.pc-title-text');
                            if (titleEl) { titleEl.textContent = newPlanTitle; }
                            pcCurrentPlanTitle = newPlanTitle;
                        }
                    }
                }
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
                activeProgressCard = null;
                activeProgressTimeline = null;
                pcBatchState = null;
                pcCurrentPlanTitle = null;
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
                // Fully release the progress card reference on agent completion
                activeProgressCard = null;
                activeProgressTimeline = null;
                pcBatchState = null;
                pcCurrentPlanTitle = null;
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
            case 'progressCardStart': {
                var newTitle = msg.title || 'Working';
                // Reuse the existing card if it has the same title (even if marked done from previous iteration)
                if (activeProgressCard) {
                    var existingTitle = activeProgressCard.querySelector('.pc-title-text');
                    var existingTitleText = existingTitle ? existingTitle.textContent.replace(/\s*\(\d+ steps?\)$/, '') : '';
                    if (existingTitleText === newTitle) {
                        // Re-activate the existing card
                        activeProgressCard.classList.remove('done');
                        activeProgressCard.classList.add('expanded');
                        activeProgressTimeline = activeProgressCard.querySelector('.pc-timeline');
                        // Restore title without the step-count suffix
                        if (existingTitle) { existingTitle.textContent = newTitle; }
                        pcCurrentPlanTitle = newTitle;
                        scrollToBottom();
                        break;
                    }
                    // Different title — close the old card properly
                    closeCurrentProgressCard();
                    activeProgressCard = null;
                    activeProgressTimeline = null;
                }
                openProgressCard(newTitle);
                scrollToBottom();
                break;
            }
            case 'progressCardStep': {
                if (!activeProgressTimeline) { break; }
                var icon = PC_ICONS[msg.icon] || '\u25CF';
                var statusCls = msg.status || 'running';
                var toolName = msg.toolName || '';

                // Skip meta-tools from the progress card
                if (toolName === 'set_plan' || toolName === 'update_plan_step') { break; }

                // ── Batch-completion update: tool just finished ──
                if (statusCls === 'done' || statusCls === 'error') {
                    // If we're batching this tool, just increment the done count
                    if (pcBatchState && pcBatchState.toolName === toolName && pcBatchState.stepEl) {
                        pcBatchState.doneCount = (pcBatchState.doneCount || 0) + 1;
                        if (statusCls === 'error') { pcBatchState.hasError = true; }
                        // If all items in the batch are done, finalize the line
                        if (pcBatchState.doneCount >= pcBatchState.count) {
                            finalizeBatchStep();
                        }
                        scrollToBottom();
                        break;
                    }
                    // Not batching — try to update a matching running step
                    var runningSteps = activeProgressTimeline.querySelectorAll('.pc-step.running');
                    var updated = false;
                    for (var i = 0; i < runningSteps.length; i++) {
                        var stepLabel = runningSteps[i].querySelector('.pc-step-label');
                        if (stepLabel && stepLabel.textContent === msg.label) {
                            runningSteps[i].className = 'pc-step ' + statusCls;
                            var stepIcon = runningSteps[i].querySelector('.pc-step-icon');
                            if (stepIcon) { stepIcon.textContent = statusCls === 'done' ? PC_ICONS.done : PC_ICONS.error; }
                            updated = true;
                            break;
                        }
                    }
                    if (updated) { scrollToBottom(); break; }
                }

                // ── New "running" step ──
                if (statusCls === 'running') {
                    // Check if this is a consecutive call of the same tool → batch it
                    if (pcBatchState && pcBatchState.toolName === toolName && pcBatchState.stepEl) {
                        pcBatchState.count++;
                        pcBatchState.items.push(msg.label);
                        // Update the label in-place to show the current item
                        var lbl = pcBatchState.stepEl.querySelector('.pc-step-label');
                        if (lbl) { lbl.textContent = msg.label; }
                        var det = pcBatchState.stepEl.querySelector('.pc-step-detail');
                        if (det) { det.textContent = '(' + pcBatchState.count + ')'; }
                        scrollToBottom();
                        break;
                    }
                    // Finalize any previous batch before starting a new line
                    if (pcBatchState && pcBatchState.stepEl) {
                        finalizeBatchStep();
                    }
                    // Remove any streaming terminal output block from the previous step
                    var prevTermBlock = activeProgressTimeline.querySelector('.pc-terminal-output');
                    if (prevTermBlock) { prevTermBlock.parentNode.removeChild(prevTermBlock); }
                    // Start a new batch tracker
                    pcBatchState = { toolName: toolName, icon: msg.icon, count: 1, doneCount: 0, items: [msg.label], stepEl: null, hasError: false };
                }

                // Create new step element
                var step = document.createElement('div');
                step.className = 'pc-step ' + statusCls;
                step.innerHTML =
                    '<span class="pc-step-icon">' + icon + '</span>' +
                    '<span class="pc-step-label">' + escapeHtml(msg.label || '') + '</span>' +
                    (msg.detail ? '<span class="pc-step-detail">' + escapeHtml(msg.detail) + '</span>' : '') +
                    '<span class="pc-step-status-dot"></span>';
                activeProgressTimeline.appendChild(step);
                // Track the DOM element for in-place updates
                if (pcBatchState && statusCls === 'running') {
                    pcBatchState.stepEl = step;
                }
                scrollToBottom();
                break;
            }
            case 'terminalOutput': {
                // Stream terminal lines into an output block within the current progress card
                if (activeProgressTimeline) {
                    var termBlock = activeProgressTimeline.querySelector('.pc-terminal-output');
                    if (!termBlock) {
                        termBlock = document.createElement('pre');
                        termBlock.className = 'pc-terminal-output';
                        activeProgressTimeline.appendChild(termBlock);
                    }
                    var lineEl = document.createElement('span');
                    lineEl.textContent = msg.line + '\n';
                    termBlock.appendChild(lineEl);
                    // Cap visible lines at 100
                    while (termBlock.childNodes.length > 100) {
                        termBlock.removeChild(termBlock.firstChild);
                    }
                    scrollToBottom();
                }
                break;
            }
            case 'progressCardEnd': {
                closeCurrentProgressCard();
                // Keep activeProgressCard reference alive for potential reuse
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
        }
    });

    /** Close the current progress card — finalize batches, remove if empty, mark done */
    function closeCurrentProgressCard() {
        if (pcBatchState && pcBatchState.stepEl) {
            finalizeBatchStep();
        }
        pcBatchState = null;
        if (!activeProgressCard) { return; }
        var hasSteps = activeProgressCard.querySelectorAll('.pc-step').length > 0;
        if (!hasSteps) {
            // Empty card — remove entirely
            if (activeProgressCard.parentNode) {
                activeProgressCard.parentNode.removeChild(activeProgressCard);
            }
            activeProgressCard = null;
            activeProgressTimeline = null;
            pcCurrentPlanTitle = null;
            return;
        }
        activeProgressCard.classList.add('done');
        // Mark any still-running steps as done
        var leftover = activeProgressCard.querySelectorAll('.pc-step.running');
        for (var j = 0; j < leftover.length; j++) {
            leftover[j].className = 'pc-step done';
            var ico = leftover[j].querySelector('.pc-step-icon');
            if (ico) { ico.textContent = PC_ICONS.done; }
        }
        // Update title to show step count (only if not already suffixed)
        var titleEl = activeProgressCard.querySelector('.pc-title-text');
        var stepCount = activeProgressCard.querySelectorAll('.pc-step').length;
        if (titleEl && stepCount > 0 && !/\(\d+ steps?\)$/.test(titleEl.textContent)) {
            titleEl.textContent = titleEl.textContent + ' (' + stepCount + ' step' + (stepCount !== 1 ? 's' : '') + ')';
        }
        // Keep reference alive for potential reuse by next progressCardStart
    }

    /** Open a new progress card with the given title */
    function openProgressCard(title) {
        var card = document.createElement('div');
        card.className = 'progress-card expanded';
        card.innerHTML =
            '<div class="progress-card-header">' +
                '<span class="pc-spinner"></span>' +
                '<span class="pc-done-icon">\u2713</span>' +
                '<span class="pc-title-text">' + escapeHtml(title) + '</span>' +
                '<span class="pc-toggle">\u25B6</span>' +
            '</div>' +
            '<div class="progress-card-body">' +
                '<div class="pc-timeline"></div>' +
            '</div>';
        card.querySelector('.progress-card-header').addEventListener('click', function() {
            card.classList.toggle('expanded');
        });
        messagesEl.appendChild(card);
        activeProgressCard = card;
        activeProgressTimeline = card.querySelector('.pc-timeline');
        pcCurrentPlanTitle = title;
    }

    /** Finalize a batched progress step — collapse "Reading X..." into "Read N files" */
    function finalizeBatchStep() {
        if (!pcBatchState || !pcBatchState.stepEl) { return; }
        var el = pcBatchState.stepEl;
        var count = pcBatchState.count;
        var hasErr = pcBatchState.hasError;
        var batchIcon = pcBatchState.icon || 'done';

        // Build summary label
        var summaryLabel;
        var tn = pcBatchState.toolName;
        if (count <= 1) {
            // Single item — keep original label, just mark done
            summaryLabel = null;
        } else if (tn === 'read_file') {
            summaryLabel = 'Read ' + count + ' files';
        } else if (tn === 'grep_search' || tn === 'search_files' || tn === 'semantic_search') {
            summaryLabel = 'Ran ' + count + ' searches';
        } else if (tn === 'edit_file' || tn === 'write_file') {
            summaryLabel = 'Edited ' + count + ' files';
        } else if (tn === 'list_directory') {
            summaryLabel = 'Listed ' + count + ' directories';
        } else if (tn === 'find_references' || tn === 'go_to_definition' || tn === 'find_symbol' || tn === 'get_document_symbols') {
            summaryLabel = 'Resolved ' + count + ' symbols';
        } else {
            summaryLabel = count + '\u00D7 ' + tn;
        }

        // Update the DOM
        el.className = 'pc-step ' + (hasErr ? 'error' : 'done');
        var stepIcon = el.querySelector('.pc-step-icon');
        if (stepIcon) { stepIcon.textContent = hasErr ? PC_ICONS.error : PC_ICONS[batchIcon] || PC_ICONS.done; }
        if (summaryLabel) {
            var lbl = el.querySelector('.pc-step-label');
            if (lbl) { lbl.textContent = summaryLabel; }
        }
        // Remove the running count detail
        var det = el.querySelector('.pc-step-detail');
        if (det && count > 1) { det.textContent = ''; }
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

