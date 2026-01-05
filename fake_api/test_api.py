"""
Simple test script to verify the Fictional Information API
"""
import httpx
import asyncio
import json
from datetime import datetime

API_BASE_URL = "http://localhost:8000"

async def test_health_check():
    """Test the health check endpoint"""
    print("🔍 Testing health check endpoint...")
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(f"{API_BASE_URL}/health")
            if response.status_code == 200:
                print("✅ Health check passed")
                return True
            else:
                print(f"❌ Health check failed: {response.status_code}")
                return False
        except Exception as e:
            print(f"❌ Health check error: {e}")
            return False

async def test_ip_company_endpoint():
    """Test the IP to company endpoint"""
    print("\n🔍 Testing IP to company endpoint...")
    test_ip = "192.168.1.100"
    
    async with httpx.AsyncClient() as client:
        try:
            # Test GET endpoint
            response = await client.get(f"{API_BASE_URL}/api/v1/ip-company/{test_ip}")
            if response.status_code == 200:
                data = response.json()
                print(f"✅ GET IP company endpoint passed")
                print(f"📊 Company: {data.get('company', {}).get('name', 'Unknown')}")
                print(f"📍 Location: {data.get('location', {}).get('city', 'Unknown')}, {data.get('location', {}).get('country', 'Unknown')}")
                
                # Test POST endpoint
                post_data = {"ip_address": test_ip}
                response = await client.post(f"{API_BASE_URL}/api/v1/ip-company", json=post_data)
                if response.status_code == 200:
                    print("✅ POST IP company endpoint passed")
                    return True
                else:
                    print(f"❌ POST IP company endpoint failed: {response.status_code}")
                    return False
            else:
                print(f"❌ GET IP company endpoint failed: {response.status_code}")
                return False
        except Exception as e:
            print(f"❌ IP company endpoint error: {e}")
            return False

async def test_company_devices_endpoint():
    """Test the company devices endpoint"""
    print("\n🔍 Testing company devices endpoint...")
    test_company = "TechCorp Solutions"
    
    async with httpx.AsyncClient() as client:
        try:
            # Test POST endpoint
            post_data = {"company_name": test_company}
            response = await client.post(f"{API_BASE_URL}/api/v1/company-devices", json=post_data)
            if response.status_code == 200:
                data = response.json()
                print(f"✅ POST Company devices endpoint passed")
                print(f"📊 Total devices: {data.get('total_devices', 0)}")
                print(f"🖥️  Sample device: {data.get('devices', [{}])[0].get('hostname', 'Unknown') if data.get('devices') else 'None'}")
                return True
            else:
                print(f"❌ POST Company devices endpoint failed: {response.status_code}")
                return False
        except Exception as e:
            print(f"❌ Company devices endpoint error: {e}")
            return False

async def test_company_summary_endpoint():
    """Test the company summary endpoint"""
    print("\n🔍 Testing company summary endpoint...")
    test_company = "Global Tech Industries"
    
    async with httpx.AsyncClient() as client:
        try:
            # Test GET endpoint
            response = await client.get(f"{API_BASE_URL}/api/v1/company-summary/{test_company}")
            if response.status_code == 200:
                data = response.json()
                print(f"✅ GET Company summary endpoint passed")
                print(f"📊 Company: {data.get('company', {}).get('name', 'Unknown')}")
                print(f"🏢 Industry: {data.get('company', {}).get('industry', 'Unknown')}")
                print(f"📍 Location: {data.get('location', {}).get('city', 'Unknown')}, {data.get('location', {}).get('country', 'Unknown')}")
                return True
            else:
                print(f"❌ GET Company summary endpoint failed: {response.status_code}")
                return False
        except Exception as e:
            print(f"❌ Company summary endpoint error: {e}")
            return False

async def main():
    """Run all tests"""
    print("🚀 Starting Fictional Information API Tests")
    print("=" * 60)
    
    tests = [
        test_health_check,
        test_ip_company_endpoint,
        test_company_devices_endpoint,
        test_company_summary_endpoint
    ]
    
    passed = 0
    total = len(tests)
    
    for test in tests:
        if await test():
            passed += 1
    
    print("\n" + "=" * 60)
    print(f"📊 Test Results: {passed}/{total} tests passed")
    
    if passed == total:
        print("🎉 All tests passed!")
    else:
        print(f"⚠️  {total - passed} tests failed")
    
    print("\n📝 API Documentation: http://localhost:8000/docs")
    print("❤️  Health Check: http://localhost:8000/health")

if __name__ == "__main__":
    asyncio.run(main())
