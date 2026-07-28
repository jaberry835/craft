# test_teams_login_template.py
"""
UI test for Teams login template wiring.
Version: 0.242.072
Implemented in: 0.242.072

This test ensures the Teams SSO login template uses the local Teams SDK,
passes the configured Teams resource to the SDK, and toggles visible states
without browser display style mutations.
"""

import re
from pathlib import Path

import pytest
from playwright.sync_api import expect


REPO_ROOT = Path(__file__).resolve().parents[1]
LOGIN_TEMPLATE = REPO_ROOT / "application" / "single_app" / "templates" / "login.html"


def _read_template():
    return LOGIN_TEMPLATE.read_text(encoding="utf-8")


def _extract_inline_bootstrap_script(template_source):
    scripts = re.findall(r"<script>(.*?)</script>", template_source, flags=re.DOTALL)
    assert scripts, "Expected an inline Teams bootstrap script."
    return scripts[-1]


def _render_test_script(script_source):
    replacements = {
        "{{ enable_teams_sso|tojson }}": "true",
        "{{ teams_app_resource|tojson }}": '"api://simplechat.example/00000000-0000-0000-0000-000000000000"',
        "{{ custom_teams_origins|tojson }}": '["https://teams.microsoft.com"]',
        "{{ teams_success_redirect_path|tojson }}": '"/chats"',
        "{{ url_for('login', teams='false')|tojson }}": '"/login?teams=false"',
    }
    rendered = script_source.replace("detectAndAuthenticate();", "")
    for old, new in replacements.items():
        rendered = rendered.replace(old, new)
    return rendered


@pytest.mark.ui
def test_teams_login_template_uses_local_sdk_and_safe_visibility():
    """Validate the template uses local assets and Bootstrap visibility classes."""
    source = _read_template()

    assert "MicrosoftTeams.min.js') }}?v={{ config['VERSION'] }}" in source
    assert "https://res.cdn.office.net" not in source
    assert "https://statics.teams.cdn.office.net" not in source
    assert "style.display" not in source
    assert "classList.add('d-none')" in source
    assert "classList.remove('d-none')" in source
    assert "resources = [teamsSettings.appResource]" in source
    assert "fetch('/auth/teams/token-exchange'" in source


@pytest.mark.ui
def test_teams_login_bootstrap_helpers_run_in_browser(page):
    """Exercise Teams login helper behavior in Chromium."""
    source = _read_template()
    script_source = _render_test_script(_extract_inline_bootstrap_script(source))

    page.set_content(
        """
        <section id="loading-section" class="spinner-container">
            <div id="status-message"></div>
            <div id="status-detail"></div>
        </section>
        <section id="error-section" class="d-none">
            <div class="error-title"></div>
            <div id="error-message"></div>
            <button id="standard-login-btn" type="button">Sign in</button>
        </section>
        """
    )
    page.evaluate(
        """
        () => {
            window.microsoftTeams = {
                authentication: {
                    getAuthToken: async (options) => {
                        window.__teamsAuthOptions = options;
                        return 'teams-token';
                    }
                }
            };
        }
        """
    )
    page.add_script_tag(content=script_source)

    page.evaluate("showError('Token exchange failed.', 'Authentication Failed')")
    expect(page.locator("#loading-section")).to_have_class(re.compile(r".*d-none.*"))
    expect(page.locator("#error-section")).not_to_have_class(re.compile(r".*d-none.*"))
    expect(page.locator("#error-message")).to_have_text("Token exchange failed.")

    page.evaluate("getTeamsAuthToken()")
    auth_options = page.evaluate("window.__teamsAuthOptions")
    assert auth_options["resources"] == ["api://simplechat.example/00000000-0000-0000-0000-000000000000"]
    assert auth_options["silent"] is False