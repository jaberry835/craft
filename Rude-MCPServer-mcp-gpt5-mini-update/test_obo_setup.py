#!/usr/bin/env python3
"""
Test script to verify On-Behalf-Of setup for ADX tools
"""

import os
import sys
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

def check_obo_configuration():
    """Check if all required environment variables for OBO flow are configured"""
    print("🔍 Checking On-Behalf-Of (OBO) Configuration...")
    print("=" * 50)
    
    required_vars = {
        "KUSTO_CLUSTER_URL": "Azure Data Explorer cluster URL",
        "AZURE_TENANT_ID": "Azure Active Directory tenant ID",
        "AZURE_CLIENT_ID": "Azure application (client) ID", 
        "AZURE_CLIENT_SECRET": "Azure application client secret"
    }
    
    optional_vars = {
        "KUSTO_DEFAULT_DATABASE": "Default database for ADX queries"
    }
    
    all_configured = True
    
    print("Required Environment Variables:")
    for var, description in required_vars.items():
        value = os.getenv(var)
        status = "✅ SET" if value else "❌ MISSING"
        preview = f"({value[:20]}...)" if value and len(value) > 20 else f"({value})" if value else ""
        print(f"  {var}: {status} {preview}")
        print(f"    Description: {description}")
        if not value:
            all_configured = False
        print()
    
    print("Optional Environment Variables:")
    for var, description in optional_vars.items():
        value = os.getenv(var)
        status = "✅ SET" if value else "⚠️ NOT SET"
        preview = f"({value})" if value else ""
        print(f"  {var}: {status} {preview}")
        print(f"    Description: {description}")
        print()
    
    print("=" * 50)
    if all_configured:
        print("🎉 All required environment variables are configured!")
        print("✅ Your MCP server is ready for On-Behalf-Of authentication")
    else:
        print("❌ Some required environment variables are missing")
        print("Please configure the missing variables before deploying")
    
    return all_configured

def check_dependencies():
    """Check if all required dependencies are installed"""
    print("\n🔍 Checking Dependencies...")
    print("=" * 30)
    
    required_packages = [
        "msal",
        "azure.kusto.data", 
        "azure.identity",
        "fastmcp"
    ]
    
    all_installed = True
    
    for package in required_packages:
        try:
            __import__(package.replace("-", "_"))
            print(f"✅ {package}")
        except ImportError:
            print(f"❌ {package} - NOT INSTALLED")
            all_installed = False
    
    print("=" * 30)
    if all_installed:
        print("🎉 All required dependencies are installed!")
    else:
        print("❌ Some dependencies are missing")
        print("Run: pip install -r requirements.txt")
    
    return all_installed

def test_context_import():
    """Test if context variables can be imported"""
    print("\n🔍 Testing Context Import...")
    print("=" * 25)
    
    try:
        from context import current_user_token, current_user_id, current_session_id
        print("✅ Context variables imported successfully")
        print(f"  - current_user_token: {type(current_user_token)}")
        print(f"  - current_user_id: {type(current_user_id)}")
        print(f"  - current_session_id: {type(current_session_id)}")
        return True
    except ImportError as e:
        print(f"❌ Failed to import context variables: {e}")
        return False

def main():
    """Main test function"""
    print("🧪 Rude MCP Server - On-Behalf-Of Setup Test")
    print("=" * 60)
    
    config_ok = check_obo_configuration()
    deps_ok = check_dependencies()
    context_ok = test_context_import()
    
    print("\n" + "=" * 60)
    print("📋 SUMMARY")
    print("=" * 60)
    
    if config_ok and deps_ok and context_ok:
        print("🎉 ALL CHECKS PASSED!")
        print("✅ Your MCP server is ready for On-Behalf-Of authentication")
        print("\nNext steps:")
        print("1. Deploy your MCP server to Azure App Service")
        print("2. Configure your calling application to send bearer tokens")
        print("3. Test ADX queries with user impersonation")
    else:
        print("❌ SOME CHECKS FAILED")
        print("Please fix the issues above before proceeding")
        
        if not deps_ok:
            print("\n🔧 To fix dependencies:")
            print("   pip install -r requirements.txt")
            
        if not config_ok:
            print("\n🔧 To fix configuration:")
            print("   Set the required environment variables in your .env file or Azure App Service configuration")

if __name__ == "__main__":
    main()
