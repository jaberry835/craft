"""
Trigger user consent for new API permissions on the agentchatv2 app.

Run this once after adding new API permissions (e.g. Azure Service Management)
to trigger the consent dialog. This uses MSAL's device code flow, which
doesn't require any redirect URIs to be configured.

Usage:
    python trigger_consent.py
"""
import msal
import os
from dotenv import load_dotenv

load_dotenv()

CLIENT_ID = os.getenv("AZURE_CLIENT_ID", "6349498a-a2f9-4081-8b82-d2119ac8f23c")
TENANT_ID = os.getenv("AZURE_TENANT_ID", "03f141f3-496d-4319-bbea-a3e9286cab10")
AUTHORITY_HOST = os.getenv("AZURE_AUTHORITY_HOST", "https://login.microsoftonline.us")

# The scope we need the user to consent to
SCOPE = "https://management.usgovcloudapi.net/user_impersonation"

app = msal.PublicClientApplication(
    CLIENT_ID,
    authority=f"{AUTHORITY_HOST}/{TENANT_ID}",
)

print(f"Requesting consent for: {SCOPE}")
print(f"App: {CLIENT_ID}")
print()

# Try device code flow first (works without redirect URIs)
flow = app.initiate_device_flow(scopes=[SCOPE])
if "user_code" in flow:
    print(flow["message"])
    print()
    result = app.acquire_token_by_device_flow(flow)
else:
    # Device code not enabled; try interactive browser flow
    print("Device code flow not available, trying browser flow...")
    result = app.acquire_token_interactive(scopes=[SCOPE], prompt="consent")

if "access_token" in result:
    print()
    print("✅ Consent granted! Azure Service Management OBO should now work.")
    print("   Restart the MCP server and retry get_policy_compliance in Inspector.")
else:
    error = result.get("error_description", result.get("error", "Unknown error"))
    print()
    print(f"❌ Failed: {error}")
    if "AADSTS7000218" in str(error):
        print()
        print("The app doesn't allow public client flows.")
        print("Go to: App Registration > Authentication > Advanced settings")
        print('Set "Allow public client flows" to Yes, then rerun this script.')
