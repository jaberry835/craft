# 🔐 Azure Data Explorer (ADX) Consent Required

## What's Happening?

You're seeing this because your Azure app registration needs **consent** to access Azure Data Explorer (ADX) resources on your behalf. This is a **one-time setup** required for user impersonation.

## Error Details
- **Error Code**: `AADSTS65001`
- **Message**: "The user or administrator has not consented to use the application"
- **Solution**: Grant ADX permissions to your app registration

## 🔧 Quick Fix Options

### Option 1: Manual Consent (Recommended)

In your browser's **Developer Console** (F12), run:
```javascript
// Trigger ADX consent flow
authService.forceADXConsent();
```

### Option 2: Azure Portal Admin Consent

1. Go to **Azure Portal** → **Azure Active Directory** → **App registrations**
2. Find your app: **"Rude Chat App"** (ID: `5e9822c5-f870-4acb-b2e6-1852254d9cbb`)
3. Go to **API permissions**
4. Click **"Grant admin consent for [your tenant]"**

## 🔄 What Happens Next?

1. **Consent Dialog**: You'll see a Microsoft login page asking for ADX permissions
2. **Page Reload**: After consent, your page will reload
3. **Automatic Token**: ADX tokens will be acquired automatically going forward
4. **User Impersonation**: ADX queries will use your permissions instead of system permissions

## ⚡ Current Status

- ✅ **User Authentication**: Working (you're logged in)
- ❌ **ADX Consent**: Required (missing permissions)
- 🔄 **Token Caching**: Ready (will work after consent)

## 🛠️ For Developers

The consent flow has been **disabled automatically** to prevent popup blocking issues. Users must manually trigger consent when they're ready.

### Debug Information
- **App ID**: `5e9822c5-f870-4acb-b2e6-1852254d9cbb`
- **ADX Scope**: `https://kusto.kusto.usgovcloudapi.net/.default`
- **Auth Method**: User impersonation with cached tokens
- **Fallback**: System identity (DefaultAzureCredential) when user tokens unavailable

## 📋 Verification Steps

After granting consent:

1. Check browser console for: `✅ Silent ADX token acquisition successful`
2. API logs should show: `🔑 Using user token for ADX authentication (impersonation)`
3. ADX queries should work with user-specific permissions

---

**Need Help?** Check the console logs for detailed token acquisition status.
