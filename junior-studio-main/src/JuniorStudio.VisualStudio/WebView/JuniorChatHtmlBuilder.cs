using System;
using System.IO;
using System.Reflection;

namespace JuniorStudio.VisualStudio.WebView
{
    internal static class JuniorChatHtmlBuilder
    {
        public static string Build()
        {
            const string chatScriptUri = "https://junior.local/chat.js";
            const string codiconFontUri = "https://junior.local/codicon.ttf";

            return @"<!DOCTYPE html>
<html lang=""en"">
<head>
<meta charset=""UTF-8"">
<meta name=""viewport"" content=""width=device-width, initial-scale=1.0"">
<style>
@font-face { font-family: codicon; font-display: block; src: url(""" + codiconFontUri + @""") format(""truetype""); }
.codicon { font: normal normal normal 16px/1 codicon; display: inline-block; text-align: center; -webkit-font-smoothing: antialiased; }
.codicon-search:before { content: ""\ea6d""; } .codicon-edit:before { content: ""\ea73""; } .codicon-file:before { content: ""\ea7b""; }
.codicon-new-file:before { content: ""\ea7f""; } .codicon-terminal:before { content: ""\ea85""; } .codicon-error:before { content: ""\ea87""; }
.codicon-check:before { content: ""\eab2""; } .codicon-loading:before { content: ""\eb19""; } .codicon-play:before { content: ""\eb2c""; }
.codicon-list-tree:before { content: ""\eb86""; } .codicon-pass:before { content: ""\eba4""; } .codicon-arrow-up:before { content: ""\eaa1""; }
.codicon-debug-stop:before { content: ""\eaf7""; } .codicon-add:before { content: ""\ea60""; } .codicon-person:before { content: ""\eb29""; }
.codicon-trash:before { content: ""\ea81""; } .codicon-chevron-down:before { content: ""\eab4""; }
.codicon-history:before { content: ""\ea82""; } .codicon-comment-discussion:before { content: ""\ea6b""; } .codicon-close:before { content: ""\ea76""; }
.codicon-loading.codicon-modifier-spin { animation: codicon-spin 1.5s steps(30) infinite; } @keyframes codicon-spin { 100% { transform: rotate(360deg); } }
:root {
  --vscode-sideBar-background: #1f1f1f; --vscode-sideBar-foreground: #cccccc; --vscode-foreground: #cccccc;
  --vscode-input-background: #2b2b2b; --vscode-input-foreground: #ffffff; --vscode-input-border: #3c3c3c;
  --vscode-button-background: #0e639c; --vscode-button-foreground: #ffffff; --vscode-button-hoverBackground: #1177bb;
  --vscode-panel-border: #3c3c3c; --vscode-widget-border: #454545; --vscode-textCodeBlock-background: rgba(0,0,0,0.22);
  --vscode-textLink-foreground: #4daafc; --vscode-editorWidget-background: #252526; --vscode-errorForeground: #f48771;
  --vscode-testing-iconPassed: #73c991; --vscode-scrollbarSlider-background: rgba(121,121,121,0.4); --vscode-descriptionForeground: #9d9d9d;
  --bg: var(--vscode-sideBar-background); --fg: var(--vscode-sideBar-foreground); --input-bg: var(--vscode-input-background);
  --input-fg: var(--vscode-input-foreground); --input-border: var(--vscode-input-border); --btn-bg: var(--vscode-button-background);
  --btn-fg: var(--vscode-button-foreground); --btn-hover: var(--vscode-button-hoverBackground); --border: var(--vscode-panel-border);
  --code-bg: var(--vscode-textCodeBlock-background); --user-msg: var(--vscode-textLink-foreground); --tool-bg: var(--vscode-editorWidget-background);
  --error-fg: var(--vscode-errorForeground); --success-fg: var(--vscode-testing-iconPassed); --scrollbar: var(--vscode-scrollbarSlider-background);
}
* { box-sizing: border-box; margin: 0; padding: 0; } html, body { height: 100%; font-family: Segoe UI, system-ui, sans-serif; font-size: 13px; color: var(--fg); background: var(--bg); }
body { display: flex; flex-direction: column; overflow: hidden; } button, select, textarea, input { font: inherit; }
#history-panel { display: none; } #messages { flex: 1; min-height: 0; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
#chat-toolbar { display: flex; align-items: center; gap: 4px; padding: 4px 8px; border-bottom: 1px solid var(--border); background: var(--bg); flex-shrink: 0; min-height: 28px; }
#chat-toolbar .ct-spacer { flex: 1; min-width: 0; overflow: hidden; }
#chat-toolbar .ct-title { font-size: 12px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 4px; }
#chat-toolbar .ct-btn { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border: 0; background: transparent; color: var(--btn-fg); border-radius: 4px; cursor: pointer; font-size: 14px; line-height: 1; }
#chat-toolbar .ct-btn:hover { background: rgba(255,255,255,.08); }
#chat-toolbar .ct-btn.active { background: rgba(255,255,255,.12); color: var(--fg); }
#history-panel { position: absolute; right: 8px; top: 32px; width: 280px; max-height: 50vh; overflow-y: auto; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; box-shadow: 0 4px 14px rgba(0,0,0,.45); z-index: 50; padding: 4px; }
#history-panel.open { display: block; }
.history-item { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 4px; cursor: pointer; }
.history-item:hover { background: rgba(255,255,255,.06); }
.history-item.active { background: rgba(77,170,252,.12); }
.history-item .hi-title { flex: 1; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.history-item .hi-meta { font-size: 10.5px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.history-item .hi-delete { border: 0; background: transparent; color: var(--vscode-descriptionForeground); cursor: pointer; font-size: 14px; line-height: 1; padding: 0 4px; border-radius: 3px; }
.history-item .hi-delete:hover { color: rgba(230,140,140,1); background: rgba(255,255,255,.08); }
#working-indicator { display: none; opacity: .75; font-size: 12px; } #working-indicator.active { display: block; }
.msg { line-height: 1.45; word-wrap: break-word; flex-shrink: 0; } .msg.user { background: rgba(77,170,252,.10); border-left: 3px solid var(--user-msg); border-radius: 6px; padding: 8px 10px; }
.msg.user .label { color: var(--user-msg); font-size: 11px; font-weight: 600; margin-bottom: 4px; text-transform: uppercase; } .msg.assistant { padding: 4px 0; }
.msg pre { overflow: auto; background: var(--code-bg); padding: 8px; border-radius: 4px; } .msg code { background: var(--code-bg); padding: 1px 3px; border-radius: 3px; }
.msg.assistant .content > *:first-child { margin-top: 0; }
.msg.assistant .content > *:last-child { margin-bottom: 0; }
.msg.assistant h1, .msg.assistant h2, .msg.assistant h3 { margin: 8px 0 2px 0; line-height: 1.25; font-weight: 600; color: var(--fg); }
.msg.assistant h1 { font-size: 16px; }
.msg.assistant h2 { font-size: 14.5px; }
.msg.assistant h3 { font-size: 13.5px; }
.msg.assistant ul, .msg.assistant ol { margin: 2px 0 4px 0; padding-left: 22px; }
.msg.assistant ul { list-style: disc outside; }
.msg.assistant ol { list-style: decimal outside; }
.msg.assistant li { margin: 1px 0; padding-left: 2px; }
.msg.assistant li::marker { color: var(--vscode-descriptionForeground); }
.msg.assistant strong { font-weight: 600; }
.msg.assistant em { font-style: italic; }
.msg.assistant a { color: var(--user-msg); text-decoration: underline; }
.msg.assistant blockquote { margin: 4px 0; padding: 2px 10px; border-left: 3px solid var(--border); color: var(--vscode-descriptionForeground); }
.msg.assistant .code-block-wrapper { margin: 8px 0; }
.approval-block { border: 1px solid var(--user-msg); border-left: 3px solid var(--user-msg); border-radius: 6px; background: rgba(77,170,252,.08); padding: 8px 10px; margin: 4px 0; display: flex; flex-direction: column; gap: 6px; }
.approval-block.resolved-allow { border-color: rgba(120,200,120,.5); border-left-color: rgba(120,200,120,.9); background: rgba(120,200,120,.06); }
.approval-block.resolved-deny { border-color: rgba(220,120,120,.5); border-left-color: rgba(220,120,120,.9); background: rgba(220,120,120,.06); }
.approval-title { font-size: 11px; font-weight: 600; color: var(--user-msg); text-transform: uppercase; letter-spacing: .04em; }
.approval-block.resolved-allow .approval-title { color: rgba(140,210,140,1); }
.approval-block.resolved-deny .approval-title { color: rgba(230,140,140,1); }
.approval-body { font-size: 12.5px; color: var(--fg); white-space: pre-wrap; word-break: break-word; font-family: Consolas, monospace; background: var(--code-bg); padding: 4px 6px; border-radius: 3px; }
.approval-actions { display: flex; align-items: center; gap: 6px; }
.approval-btn { font-size: 12px; padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border); background: transparent; color: var(--fg); cursor: pointer; }
.approval-btn:hover:not(:disabled) { background: rgba(255,255,255,.08); }
.approval-btn:disabled { opacity: .55; cursor: default; }
.approval-allow { border-color: rgba(120,200,120,.5); color: rgba(140,210,140,1); }
.approval-allow-session { border-color: rgba(110,170,230,.5); color: rgba(150,195,240,1); }
.approval-deny { border-color: rgba(220,120,120,.5); color: rgba(230,140,140,1); }
.approval-status { font-size: 11px; color: var(--vscode-descriptionForeground); margin-left: 4px; }
.code-block-wrapper { margin: 6px 0; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: var(--code-bg); }
.code-block-header { display: flex; align-items: center; justify-content: space-between; padding: 4px 8px; background: rgba(255,255,255,.04); border-bottom: 1px solid var(--border); font-size: 11px; }
.code-block-header .code-lang { color: var(--vscode-descriptionForeground); text-transform: lowercase; font-family: Consolas, monospace; letter-spacing: .02em; }
.code-block-header .copy-btn { display: inline-flex; align-items: center; gap: 4px; border: 0; background: transparent; color: var(--vscode-descriptionForeground); cursor: pointer; padding: 2px 6px; border-radius: 3px; font-size: 11px; line-height: 1; }
.code-block-header .copy-btn:hover { background: rgba(255,255,255,.08); color: var(--fg); }
.code-block-wrapper pre { margin: 0; border-radius: 0; background: transparent; padding: 8px 10px; }
#file-change-dock, #plan-panel.hidden, #plan-action-bar.hidden, .hidden { display: none !important; } #status-bar { min-height: 20px; padding: 3px 10px; font-size: 11px; opacity: .75; border-top: 1px solid var(--border); }
#input-area { flex-shrink: 0; border-top: 1px solid var(--border); background: var(--bg); padding: 8px; } #attach-preview { display: none; }
#attach-preview { gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
.attach-pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 6px 4px 4px; background: var(--tool-bg); border: 1px solid var(--border); border-radius: 6px; font-size: 12px; max-width: 220px; }
.attach-pill .attach-thumb { width: 28px; height: 28px; object-fit: cover; border-radius: 4px; flex-shrink: 0; }
.attach-pill .attach-file-icon { font-size: 14px; opacity: .8; }
.attach-pill span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.attach-pill .attach-remove { border: 0; background: transparent; color: var(--vscode-descriptionForeground); cursor: pointer; padding: 0 4px; font-size: 14px; line-height: 1; border-radius: 3px; }
.attach-pill .attach-remove:hover { background: rgba(255,255,255,.08); color: var(--fg); }
.user-attachments { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0; }
.user-attach-img { max-width: 240px; max-height: 180px; border-radius: 6px; border: 1px solid var(--border); }
.user-attach-file { display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; background: var(--tool-bg); border: 1px solid var(--border); border-radius: 4px; font-size: 12px; }
#composer-shell { border: 1px solid var(--input-border); background: var(--input-bg); border-radius: 8px; padding: 6px; } #input { width: 100%; min-height: 42px; max-height: 180px; resize: none; border: 0; outline: 0; color: var(--input-fg); background: transparent; }
#composer-toolbar, #provider-bar { display: flex; align-items: center; gap: 4px; } #composer-toolbar { margin-top: 4px; } #provider-bar { margin-top: 6px; font-size: 11px; opacity: .9; }
.composer-spacer { flex: 1; } .composer-btn, .mode-trigger, .model-trigger, #btn-run-plan { display: inline-flex; align-items: center; gap: 4px; border: 0; color: var(--btn-fg); background: transparent; border-radius: 4px; height: 24px; padding: 0 6px; cursor: pointer; font-size: 12px; line-height: 1; white-space: nowrap; }
.composer-btn .codicon, .mode-trigger .codicon, .model-trigger .codicon { font-size: 14px; }
.mode-icon { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; flex: 0 0 14px; }
.mode-icon svg { width: 14px; height: 14px; display: block; }
#btn-send { width: 28px; height: 24px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
#btn-send .codicon { font-size: 14px; }
.composer-btn:hover, .mode-trigger:hover, .model-trigger:hover, #btn-run-plan:hover { background: rgba(255,255,255,.08); } #btn-send { background: var(--btn-bg); position: relative; }
#btn-send.stop-mode { background: rgba(255,255,255,.04); }
#btn-send .send-spinner { position: absolute; inset: 1px; border-radius: 50%; border: 2px solid transparent; border-top-color: var(--vscode-progressBar-background, #0098ff); border-right-color: var(--vscode-progressBar-background, #0098ff); animation: junior-send-spin 0.9s linear infinite; pointer-events: none; }
#btn-send .send-stop { position: relative; display: inline-block; width: 8px; height: 8px; background: currentColor; border-radius: 1px; }
@keyframes junior-send-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
select, .model-search { color: var(--input-fg); background: var(--input-bg); border: 1px solid var(--input-border); border-radius: 4px; padding: 3px 6px; }
.mode-dropdown, .model-control { position: relative; } .mode-menu, .model-menu { position: absolute; bottom: 100%; left: 0; min-width: 220px; margin-bottom: 5px; padding: 6px; background: var(--tool-bg); border: 1px solid var(--border); border-radius: 6px; z-index: 20; box-shadow: 0 4px 16px rgba(0,0,0,.35); }
.mode-option, .model-option { display: flex; width: 100%; gap: 8px; align-items: center; color: var(--fg); background: transparent; border: 0; border-radius: 4px; padding: 6px; text-align: left; cursor: pointer; }
.mode-option:hover, .model-option:hover { background: rgba(255,255,255,.08); } .mode-option-check { margin-left: auto; visibility: hidden; } .mode-option.active .mode-option-check, .model-option.active .mode-option-check { visibility: visible; } #model-select { display: none; } #model-search { width: 100%; margin-bottom: 6px; }
.footer-select-control { display: inline-flex; align-items: center; gap: 4px; } #context-meter { margin-left: auto; font-size: 11px; color: var(--vscode-descriptionForeground); }
#slash-autocomplete { display: none; } #slash-autocomplete.open { display: block; position: absolute; bottom: 100%; left: 0; right: 0; background: var(--tool-bg); border: 1px solid var(--border); border-radius: 6px; }
.reasoning-block { margin: 4px 0 8px 0; padding: 4px 8px; background: rgba(255,255,255,.03); border-left: 2px solid #7e57c2; border-radius: 4px; font-size: 12px; }
.reasoning-block summary { cursor: pointer; color: #b39ddb; font-weight: 600; user-select: none; padding: 2px 0; }
.reasoning-block summary:hover { color: #d1c4e9; }
.reasoning-block .reasoning-text { margin-top: 4px; padding: 4px 0; color: var(--vscode-descriptionForeground); font-family: Segoe UI, system-ui, sans-serif; white-space: pre-wrap; word-wrap: break-word; background: transparent; }
.welcome-screen { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 32px 18px; text-align: center; gap: 14px; animation: welcome-fade .35s ease; }
@keyframes welcome-fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.welcome-logo { width: 56px; height: 56px; opacity: .9; }
.welcome-title { font-size: 20px; font-weight: 600; color: var(--fg); letter-spacing: -.01em; }
.welcome-subtitle { font-size: 13px; color: var(--vscode-descriptionForeground); max-width: 360px; line-height: 1.5; }
.welcome-section-label { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--vscode-descriptionForeground); margin-top: 8px; opacity: .85; }
.welcome-prompts { display: flex; flex-direction: column; gap: 6px; width: 100%; max-width: 380px; }
.welcome-prompt { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; background: var(--tool-bg); border: 1px solid var(--border); border-radius: 8px; color: var(--fg); text-align: left; cursor: pointer; transition: background .15s, border-color .15s, transform .1s; font-size: 12.5px; line-height: 1.4; }
.welcome-prompt:hover { background: rgba(255,255,255,.06); border-color: var(--vscode-textLink-foreground); }
.welcome-prompt:active { transform: scale(.99); }
.welcome-prompt .codicon { color: var(--vscode-textLink-foreground); flex-shrink: 0; margin-top: 1px; }
.welcome-prompt-text { flex: 1; }
.welcome-workspace { font-size: 12px; color: var(--vscode-descriptionForeground); padding: 6px 10px; background: var(--tool-bg); border: 1px solid var(--border); border-radius: 6px; max-width: 380px; word-break: break-all; }
.welcome-workspace code { background: transparent; padding: 0; color: var(--fg); }
.welcome-hint { font-size: 11.5px; color: var(--vscode-descriptionForeground); opacity: .8; max-width: 360px; line-height: 1.5; }
.working-block-wrapper { margin: 4px 0; flex-shrink: 0; }
.working-block-wrapper.hidden-working-block { display: none; }
.working-block { border-radius: 8px; border: 1px solid rgba(255,255,255,0.06); background: rgba(255,255,255,0.018); overflow: hidden; }
.working-block-wrapper.live .working-block { border-color: rgba(55, 148, 255, 0.2); }
.working-block-wrapper.completed .working-block { border-color: rgba(255,255,255,0.04); }
.working-block.completed .working-block-body { opacity: .55; transition: opacity .15s ease; }
.working-block.completed:hover .working-block-body { opacity: 1; }
.working-block-header { display: flex; align-items: center; gap: 6px; padding: 6px 10px; user-select: none; }
.working-block.completed .working-block-header { cursor: pointer; }
.working-block.completed .working-block-header:hover { background: rgba(255,255,255,0.035); }
.wb-header-copy { min-width: 0; display: flex; align-items: center; gap: 8px; flex: 1; }
.wb-leading { flex-shrink: 0; font-size: 12px; font-weight: 700; color: var(--user-msg); }
.working-block.completed .wb-leading { color: var(--vscode-descriptionForeground); font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; -webkit-text-fill-color: currentColor; }
.working-block.completed:hover .wb-leading { color: var(--fg); }
.wb-title { min-width: 0; white-space: nowrap; font-size: 12px; font-weight: 600; color: var(--fg); }
.working-block.completed .wb-title { display: none; }
.wb-summary { display: none; min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--vscode-descriptionForeground); }
.wb-chevron { flex-shrink: 0; width: 12px; text-align: center; opacity: .7; font-size: 10px; transition: transform .15s ease; }
.working-block-wrapper.live .wb-chevron { opacity: .35; }
.working-block.expanded .wb-chevron { transform: rotate(90deg); }
.working-block-body { display: none; padding: 0 10px 8px 10px; max-height: 300px; overflow-y: auto; }
.working-block-wrapper.live .working-block-body, .working-block.expanded .working-block-body { display: block; }
.wb-entries { display: flex; flex-direction: column; gap: 2px; }
.wb-entry { display: flex; align-items: flex-start; gap: 6px; animation: wb-fade-in .12s ease-out; }
@keyframes wb-fade-in { from { opacity: 0; transform: translateY(1px); } to { opacity: 1; transform: none; } }
.wb-entry.action { padding: 3px 0; }
.wb-entry.action.pending, .wb-entry.action.running { padding: 5px 8px; border-radius: 6px; background: rgba(55, 148, 255, 0.06); border: 1px solid rgba(55, 148, 255, 0.15); }
.wb-entry.action.error { padding: 5px 8px; border-radius: 6px; background: rgba(244, 71, 71, 0.06); border: 1px solid rgba(244, 71, 71, 0.18); }
.wb-action-icon { width: 16px; height: 16px; margin-top: 1px; display: inline-flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0; line-height: 1; }
.wb-entry.action.done .wb-action-icon { color: var(--vscode-descriptionForeground); }
.wb-entry.action.pending .wb-action-icon, .wb-entry.action.running .wb-action-icon { color: var(--user-msg); }
.wb-entry.action.error .wb-action-icon { color: var(--error-fg); }
.wb-action-copy { min-width: 0; flex: 1; }
.wb-action-text { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; font-size: 12px; line-height: 1.35; color: var(--fg); overflow-wrap: anywhere; }
.wb-entry.action.done .wb-action-text { color: var(--vscode-descriptionForeground); }
.wb-action-detail { margin-top: 1px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; font-size: 11px; color: var(--vscode-descriptionForeground); white-space: normal; overflow-wrap: anywhere; }
.wb-action-diff { display: inline-flex; gap: 6px; font-size: 11px; font-family: Consolas, monospace; margin-left: 8px; flex-shrink: 0; align-self: center; }
.wb-action-diff .diff-add { color: #4ec94e; } .wb-action-diff .diff-del { color: #f44747; }
.wb-live-status { display: flex; align-items: center; gap: 6px; padding: 4px 10px 6px; font-size: 12px; color: var(--vscode-descriptionForeground); }
.working-block-wrapper.completed .wb-live-status { display: none; }
.wb-live-text, #working-text, .working-block-wrapper.live .wb-leading { background: linear-gradient(90deg, var(--fg) 0%, var(--fg) 40%, #fff 50%, var(--fg) 60%, var(--fg) 100%); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; animation: text-shimmer 2s ease-in-out infinite; }
@keyframes text-shimmer { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }
.pc-file-link { cursor: pointer; color: var(--vscode-textLink-foreground); } .pc-file-link:hover { text-decoration: underline; }
.pc-file-badge { display: inline-block; font-size: 9px; font-weight: 700; line-height: 1; padding: 1px 4px; border-radius: 3px; color: #fff; margin-left: 5px; vertical-align: middle; letter-spacing: .3px; opacity: .9; }
.narration-row { padding: 4px 0; font-size: 12.5px; line-height: 1.5; }
.narration-row p { margin: 0 0 5px; } .narration-row p:last-child { margin-bottom: 0; }
</style>
</head>
<body>
<div id=""chat-toolbar""><button id=""btn-new-chat"" class=""ct-btn"" title=""New chat""><i class=""codicon codicon-add""></i></button><button id=""btn-toggle-history"" class=""ct-btn"" title=""Show chat history""><i class=""codicon codicon-history""></i></button><div class=""ct-spacer""><span id=""ct-active-title"" class=""ct-title""></span></div></div>
<div id=""history-panel""><div id=""history-list""></div></div>
<div id=""messages""><div id=""working-indicator""><span id=""working-text"">Thinking</span></div></div>
<div id=""file-change-dock"" class=""hidden""><div class=""dock-header""><span class=""dock-toggle""></span><span class=""dock-summary""></span><span class=""dock-counts""><span class=""dock-add"">+0</span> <span class=""dock-del"">-0</span></span><div class=""dock-actions""><button class=""btn-keep"">Keep All</button><button class=""btn-undo"">Undo All</button></div></div><div class=""dock-files""></div></div>
<div id=""plan-panel"" class=""hidden""><div class=""plan-header""><span class=""plan-toggle"">&#9654;</span><span class=""plan-title"">Plan</span><span class=""plan-progress""></span></div><div class=""plan-steps""></div></div>
<div id=""status-bar""></div>
<div id=""input-area""><div id=""attach-preview""></div><div id=""plan-action-bar"" class=""hidden""><span class=""plan-action-label"">Proceed from Plan</span><button id=""btn-run-plan"">Start Implementation</button></div><div id=""composer-shell"" style=""position:relative;""><div id=""slash-autocomplete""></div><textarea id=""input"" rows=""1"" placeholder=""Ask Junior anything..."" autofocus></textarea><div id=""composer-toolbar""><button id=""btn-attach"" class=""composer-btn"" title=""Attach context""><i class=""codicon codicon-add""></i></button><div id=""mode-switch"" class=""mode-dropdown""><button id=""mode-trigger"" class=""mode-trigger"" type=""button""><span id=""mode-trigger-icon"" class=""mode-icon""></span><span id=""mode-trigger-label"">Agent</span></button><div id=""mode-menu"" class=""mode-menu hidden""><button class=""mode-option active"" data-mode=""agent"" type=""button""><span class=""mode-option-label"">Agent</span><span class=""mode-option-check""><i class=""codicon codicon-check""></i></span></button><button class=""mode-option"" data-mode=""ask"" type=""button""><span class=""mode-option-label"">Ask</span><span class=""mode-option-check""><i class=""codicon codicon-check""></i></span></button><button class=""mode-option"" data-mode=""plan"" type=""button""><span class=""mode-option-label"">Plan</span><span class=""mode-option-check""><i class=""codicon codicon-check""></i></span></button><div id=""custom-agent-list""></div><div id=""dev-team-list""></div><button class=""mode-option mode-option-action"" data-action=""create-custom-agent"" type=""button""><span class=""mode-option-label"">Create custom agent...</span></button><button class=""mode-option mode-option-action"" data-action=""create-dev-team"" type=""button""><span class=""mode-option-label"">Create Dev Team...</span></button></div></div><div id=""model-control"" class=""model-control""><select id=""model-select""><option value=""junior-stub"">Junior Studio Stub</option></select><button id=""model-trigger"" class=""model-trigger"" type=""button""><span id=""model-trigger-label"">Junior Studio Stub</span><span id=""model-trigger-meta""></span><span><i class=""codicon codicon-chevron-down""></i></span></button><div id=""model-menu"" class=""model-menu hidden""><input id=""model-search"" class=""model-search"" type=""text"" placeholder=""Search models"" /><div id=""model-list"" class=""model-list""></div><div id=""model-reasoning-submenu"" class=""model-reasoning-submenu hidden""><div class=""reasoning-option-group"" data-reasoning-group=""effort""></div><div class=""reasoning-option-group"" data-reasoning-group=""summary""></div><div id=""model-note"" class=""model-note""></div></div></div></div><button id=""btn-tools"" class=""composer-btn"" title=""MCP Tools""><i class=""codicon codicon-list-tree""></i></button><div class=""composer-spacer""></div><button id=""btn-send"" class=""composer-btn"" title=""Send message (Enter)""><i class=""codicon codicon-arrow-up""></i></button></div></div><div id=""provider-bar""><label class=""footer-select-control""><select id=""provider-select""><option value=""local"">Local</option></select></label><label class=""footer-select-control""><select id=""permission-select""><option value=""default"">Default Approvals</option><option value=""bypass"">Bypass Approvals</option></select></label><div id=""context-meter""><span class=""meter-label"">0 / 128.0K (0%)</span></div></div></div>
<script>
(function () {
  var state = {};
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (message) { window.chrome.webview.postMessage(message); },
      getState: function () { return state; },
      setState: function (next) { state = next || {}; return state; }
    };
  };
  window.chrome.webview.addEventListener('message', function (event) {
    window.dispatchEvent(new MessageEvent('message', { data: event.data }));
  });
}());
</script>
<script src=""" + chatScriptUri + @"""></script>
</body>
</html>";
        }

        private static string ToFileUri(string path)
        {
            return new Uri(path).AbsoluteUri;
        }
    }
}