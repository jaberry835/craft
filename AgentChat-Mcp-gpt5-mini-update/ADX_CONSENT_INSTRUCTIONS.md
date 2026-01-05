# ADX Consent Instructions

## 🔐 Granting ADX Consent

When you see this error in the browser console:
```
⚠️ ADX consent required. User needs to manually grant consent.
🔧 Call authService.forceADXConsent() to trigger consent flow.
```

### Method 1: Browser Console (Recommended)

1. **Check if Popups Are Allowed**
   - Press `F12` or `Ctrl+Shift+I` to open Developer Console
   - Go to the **Console** tab
   - Run: `window.authService.testPopups()`
   - If this returns `false`, allow popups:
     - Look for popup blocker notification in address bar
     - Click it and select "Always allow popups from this site"
     - Refresh the page

2. **Run the Consent Command**
   ```javascript
   window.authService.forceADXConsent()
   ```

3. **Grant Consent in Popup**
   - A popup window will appear with Azure consent page
   - Review the permissions requested
   - Click **"Accept"** to grant consent for ADX access
   - The popup will close automatically

4. **Verify Success**
   - You should see: `✅ ADX consent granted and token acquired`
   - Check token status: `window.authService.hasValidADXToken()`

### Method 2: Check Consent Status

To check if ADX consent is already granted:
```javascript
window.authService.hasValidADXToken()
```

### Method 3: Refresh ADX Token

If you have issues with an existing token:
```javascript
window.authService.refreshADXToken()
```

## 🔍 Troubleshooting

### If consent fails:
1. Check if popups are blocked in your browser
2. Disable popup blockers for your domain
3. Try using a different browser
4. Clear browser cache and cookies for Microsoft login

### If you see "interaction_in_progress" errors:
1. Wait for any ongoing authentication to complete
2. Refresh the page
3. Try the consent command again

### Common Error Messages:
- **"popup_window_error"**: Enable popups for this site
- **"interaction_in_progress"**: Wait and try again
- **"invalid_grant"**: Consent is required (normal, follow steps above)

## ✅ After Successful Consent

Once consent is granted:
- ADX queries will use your user credentials
- You'll only see data you have permission to access
- No more consent prompts (until token expires)
- The app will automatically use your ADX token for queries

## 🛡️ Security Notes

- This process only grants permission to query ADX data you already have access to
- It does NOT give the app any additional permissions beyond what you have
- Consent can be revoked at any time through Azure portal
- Tokens automatically expire and will require re-consent periodically
