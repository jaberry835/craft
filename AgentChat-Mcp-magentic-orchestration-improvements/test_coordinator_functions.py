#!/usr/bin/env python3
"""
Test script to verify that the coordinator agent can properly call kernel functions.
"""

import asyncio
import sys
import os

# Add the PythonAPI directory to the path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'PythonAPI'))

# Now import from the PythonAPI directory
from src.agents.multi_agent_system import MultiAgentSystem
from src.config.azure_config import AzureConfig

async def test_coordinator_functions():
    """Test that the coordinator agent can properly call kernel functions."""
    print("🧪 Testing Coordinator Agent kernel functions...")
    
    # Load configuration
    config = AzureConfig()
    
    # Initialize the multi-agent system
    system = MultiAgentSystem(
        azure_openai_api_key=config.azure_openai_api_key,
        azure_openai_endpoint=config.azure_openai_endpoint,
        azure_openai_deployment=config.azure_openai_deployment
    )
    
    # Initialize the system
    await system.initialize()
    
    # Test the coordinator agent directly
    print("\n📋 Testing direct coordinator agent function calls...")
    
    # Test the get_available_agents function
    coordinator = system.coordinator_agent
    print(f"✅ Coordinator agent loaded: {coordinator.name}")
    print(f"🔧 Coordinator kernel functions: {list(coordinator.kernel.functions.keys())}")
    
    # Test via process_question to trigger the fast path
    print("\n🚀 Testing via process_question (should use fast path)...")
    try:
        response = await system.process_question("What agents are available?")
        print(f"✅ Response received: {response[:200]}...")
        print(f"\n📋 Full response:\n{response}")
        
        # Check if the response contains dynamic agent information
        if "MathAgent" in response and "ADXAgent" in response:
            print("\n✅ SUCCESS: Response contains dynamic agent information!")
            print("✅ The coordinator agent is now properly calling kernel functions!")
        else:
            print("\n❌ FAILURE: Response does not contain expected agent information")
            
    except Exception as e:
        print(f"❌ ERROR: {str(e)}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(test_coordinator_functions())
