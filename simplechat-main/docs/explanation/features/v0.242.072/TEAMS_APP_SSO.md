# Microsoft Teams App SSO

Implemented in version: **0.242.072**

## Overview

SimpleChat can run as a Microsoft Teams personal tab and authenticate users with Teams Single Sign-On (SSO). The feature uses the Teams JavaScript SDK in the browser and the Microsoft identity On-Behalf-Of (OBO) flow on the Flask backend.

This feature requires both a Teams app package and SimpleChat runtime configuration. The Teams package tells Teams what tab URL and Entra Application ID URI to use. The SimpleChat runtime flag enables Teams frame support, token exchange, secure cross-site session cookies, and app-level authentication handling.

## Dependencies

- Microsoft Teams app manifest with `webApplicationInfo` configured.
- Entra app registration with an exposed API scope such as `access_as_user`.
- `ENABLE_TEAMS_SSO=true` or the deployer `enableTeamsSso=true` parameter.
- Local Teams JavaScript SDK asset at `application/single_app/static/js/MicrosoftTeams.min.js`.

## Technical Specifications

### Backend

- `/login?teams=true` renders the Teams-aware login bootstrap page.
- `/auth/teams/token-exchange` accepts the Teams SSO assertion, exchanges it through MSAL OBO, and creates the Flask session.
- The token exchange endpoint is feature-gated by `ENABLE_TEAMS_SSO`.
- The global same-origin guard also protects the pre-session Teams token exchange POST.
- Session user data is populated from OBO ID token claims, the validated Teams assertion claims, and Microsoft Graph `/me` fallback data.

### Security Headers And Cookies

- When Teams SSO is disabled, `X-Frame-Options: DENY` remains active.
- When Teams SSO is enabled, CSP `frame-ancestors` includes configured Teams origins and `X-Frame-Options` is omitted.
- Teams SSO forces `SESSION_COOKIE_SAMESITE=None` and `SESSION_COOKIE_SECURE=true`.
- Commercial and Azure Government defaults are provided; custom clouds can set explicit Teams origins.

### Deployment

- `deployers/bicep/main.bicep` exposes `enableTeamsSso`, `teamsFrameAncestors`, `customTeamsOrigins`, and `teamsAppResource`.
- `deployers/bicep/modules/appService.bicep` sets the corresponding app settings and lets unauthenticated requests reach the app-level login flow when Teams SSO is enabled.
- `deployers/version.txt` was updated with the deployer patch version.

## Usage Instructions

1. Configure the Entra app registration **Expose an API** section.
2. Set the Application ID URI and `access_as_user` delegated scope.
3. Preauthorize Teams client applications for that scope.
4. Deploy SimpleChat with `enableTeamsSso=true` and `teamsAppResource` set to the Application ID URI.
5. Build a Teams package from `application/teams_app/manifest.template.json`, `color.png`, and `outline.png`.
6. Upload or publish the Teams package.
7. Open the SimpleChat tab in Teams.

See `docs/how-to/teams_app.md` for operator steps.

## Testing And Validation

- Functional tests cover Teams configuration, security header behavior, token-exchange request validation, and session user construction.
- UI tests cover login template structure, local SDK loading, configured Teams resource usage, and fallback behavior.
- Python syntax checks and template-focused checks validate the changed runtime files.

## Known Limitations

- The deployer does not publish the Teams app package; Teams app upload remains an administrator or developer action.
- Custom or air-gapped Teams clouds must provide explicit frame ancestors, SDK origins, and Application ID URI values.
- Teams SSO requires HTTPS because browsers require `Secure` cookies when `SameSite=None` is used.