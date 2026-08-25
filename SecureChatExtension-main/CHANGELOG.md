# Changelog

## 1.0.? — Date 06/5/2026

- **Delegated A2A Agent experimental ferature** 
- **Reasoning SElector UI changes** 
- **Q and A UI feature** 
- **Browser tools: Junior can now open web pages, inspect interactive elements, click controls, enter text, capture screenshots, and close its automated Chromium session. Navigated pages can also open in VS Code's browser preview for manual testing, with settings to disable the preview or specify a custom browser executable.**
- **Fix: server-side state (`useServerSideState`) now sends only incremental conversation items once a `previous_response_id` is held, instead of resending the full transcript — prevents oversized requests and the "please check your inputs and try again" stream error on long chats.**
- **Fix: server-side state now resets its `previous_response_id` marker when local context compaction rewrites the transcript, avoiding mismatches between provider-side state and Junior's compacted local history.**
- **Connect Cloud Agent: the Microsoft sign-in (Entra) auth mode now accepts multiple advanced sign-in scopes (one per line), including the `microsoft-sovereign-cloud` provider directives `VSCODE_CLIENT_ID:` / `VSCODE_TENANT:` alongside resource scopes like `api://<app-id>/MCPaccess`. All listed scopes are passed to `vscode.authentication.getSession`.**
- **Connect Cloud Agent: Microsoft sign-in provider is now a dropdown with Commercial Microsoft and Microsoft Sovereign Cloud options. Sovereign selection shows setup guidance and an action to open User Settings JSON for environment/custom URL configuration.**
- **Connect Cloud Agent: sovereign-cloud guidance now distinguishes built-in environments (for example `AzureUSGovernment`) from `custom` environments, and bearer-auth samples use the documented Azure Government endpoint URLs.**
