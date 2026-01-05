#!/usr/bin/env python3
"""
Simple test script to verify kernel function calls work.
"""

import asyncio
import os
import sys
from semantic_kernel.contents import ChatHistory
from semantic_kernel.connectors.ai.open_ai import OpenAIChatPromptExecutionSettings

async def test_kernel_functions():
    """Test that kernel functions work properly."""
    print("🧪 Testing kernel function calls...")
    
    # Set up environment
    os.chdir('PythonAPI')
    sys.path.insert(0, os.getcwd())
    
    # Get Azure OpenAI credentials from environment
    azure_endpoint = os.getenv("AZURE_OPENAI_ENDPOINT")
    azure_api_key = os.getenv("AZURE_OPENAI_API_KEY")
    azure_deployment = os.getenv("AZURE_OPENAI_DEPLOYMENT", "gpt-4o-mini")
    
    if not azure_endpoint or not azure_api_key:
        print("❌ Azure OpenAI environment variables not set")
        return
    
    # Initialize the multi-agent system
    from src.agents.multi_agent_system import MultiAgentSystem
    
    system = MultiAgentSystem(
        azure_openai_api_key=azure_api_key,
        azure_openai_endpoint=azure_endpoint,
        azure_openai_deployment=azure_deployment
    )
    
    # Initialize the system
    await system.initialize()
    
    # Test the coordinator agent directly with kernel functions
    print("\n📋 Testing coordinator agent function calls...")
    
    # Test the get_available_agents function
    coordinator = system.coordinator_agent
    print(f"✅ Coordinator agent loaded: {coordinator.name}")
    
    # List available functions
    functions = coordinator.kernel.functions
    print(f"🔧 Available functions: {list(functions.keys())}")
    
    # Test direct function call
    print("\n🧪 Testing direct function call...")
    try:
        # Create a simple chat history
        chat_history = ChatHistory()
        chat_history.add_user_message("What agents are available?")
        
        # Create settings that encourage function calling
        settings = OpenAIChatPromptExecutionSettings(
            temperature=0.1,
            max_completion_tokens=1000,
            function_choice_behavior=coordinator.function_choice_behavior
        )
        
        # Use the coordinator agent's invoke method
        response = await coordinator.invoke(chat_history, settings)
        
        print(f"✅ Response: {response.content}")
        
        # Check if response contains dynamic agent info
        if "MathAgent" in str(response.content) and "ADXAgent" in str(response.content):
            print("✅ SUCCESS: Response contains dynamic agent information!")
        else:
            print("❌ FAILURE: Response does not contain expected agent information")
            
    except Exception as e:
        print(f"❌ ERROR: {str(e)}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(test_kernel_functions())
