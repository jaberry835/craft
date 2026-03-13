// @ts-nocheck
// SecureChat webview script — loaded as an external file to avoid template-literal escaping issues.

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
    const modelSelectEl = document.getElementById('model-select');

    const btnAttach = document.getElementById('btn-attach');
    const attachPreview = document.getElementById('attach-preview');
    let currentAssistantEl = null;
    let currentContentEl = null;

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
        let html = escapeHtml(text);
        // Code blocks (``` ... ```)
        html = html.replace(/\x60\x60\x60(\w*)\n([\s\S]*?)\x60\x60\x60/g, function(match, lang, code) {
            const id = 'codeblock-' + (codeBlockId++);
            return '<div class="code-block-wrapper">' +
                '<div class="code-block-header">' +
                    (lang ? '<span class="code-lang">' + escapeHtml(lang) + '</span>' : '') +
                    '<button class="copy-btn" data-code-id="' + id + '" title="Copy code">&#128203; Copy</button>' +
                '</div>' +
                '<pre><code id="' + id + '">' + code + '</code></pre>' +
            '</div>';
        });
        // Inline code (` ... `)
        html = html.replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>');
        // Bold
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        // Italic
        html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
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
                    const statusSpan = block.querySelector('.tool-status');
                    statusSpan.textContent = msg.success ? 'done' : 'failed';
                    const resultDiv = document.createElement('div');
                    resultDiv.className = 'tool-result ' + (msg.success ? 'success' : 'failure');
                    resultDiv.textContent = truncate(msg.result, 2000);
                    block.appendChild(resultDiv);
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
                        '<button class="btn-deny">Deny</button>' +
                    '</div>';
                dialog.querySelector('.btn-approve').addEventListener('click', () => {
                    vscode.postMessage({ type: 'confirmAction', actionId: msg.actionId, approved: true });
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
            case 'sessionCleared': {
                messagesEl.innerHTML = '';
                currentAssistantEl = null;
                currentContentEl = null;
                clearAttachments();
                break;
            }
            case 'setStatus': {
                if (msg.status) {
                    statusEl.textContent = msg.status;
                    statusEl.classList.add('active');
                    // cancel button now in view title bar
                    inputEl.disabled = true;
                    inputEl.placeholder = 'Agent is working...';
                } else {
                    statusEl.textContent = '';
                    statusEl.classList.remove('active');
                    // cancel button now in view title bar
                    inputEl.disabled = false;
                    inputEl.placeholder = 'Ask SecureChat anything...';
                    inputEl.focus();
                }
                break;
            }
            case 'agentDone': {
                // cancel button now in view title bar
                inputEl.disabled = false;
                inputEl.placeholder = 'Ask SecureChat anything...';
                inputEl.focus();
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
        }
    });

    function formatJson(str) {
        try {
            return JSON.stringify(JSON.parse(str), null, 2);
        } catch (e) {
            return str;
        }
    }

    function truncate(text, max) {
        if (text.length <= max) return text;
        return text.slice(0, max) + '\n... (truncated)';
    }

    // Signal ready
    vscode.postMessage({ type: 'ready' });
})();
