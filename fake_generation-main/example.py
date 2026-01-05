#!/usr/bin/env python3
"""
Simple example script to demonstrate the document generator functionality.
Run this script after setting up your Azure OpenAI endpoint.
"""

import asyncio
import os
import logging
from dotenv import load_dotenv
from document_generator import DocumentGenerator

# Load environment variables
load_dotenv()

# Configure basic logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

async def simple_example():
    """Generate a single company's documents in Spanish"""
    
    # Check for required environment variables
    azure_endpoint = os.getenv("AZURE_OPENAI_ENDPOINT")
    api_key = os.getenv("AZURE_OPENAI_API_KEY")
    
    if not azure_endpoint:
        print("Error: Please set the AZURE_OPENAI_ENDPOINT environment variable")
        print("Example: https://your-resource-name.openai.azure.com/")
        return
        
    if not api_key:
        print("Error: Please set the AZURE_OPENAI_API_KEY environment variable")
        print("You can find this in your Azure OpenAI resource under 'Keys and Endpoint'")
        return
    
    try:
        # Initialize the document generator
        generator = DocumentGenerator(azure_endpoint, api_key)
        
        # Generate documents for a Spanish technology company
        print("Generating documents for a fictional Spanish technology company...")
        documents = await generator.generate_company_documents(
            language="spanish", 
            company_type="technology"
        )
        
        print("\nGenerated documents:")
        for doc_type, filepath in documents.items():
            print(f"  {doc_type.title()} Report: {filepath}")
        
        print("\nDocuments have been saved to the 'output' directory.")
        
    except Exception as e:
        logger.error(f"Failed to generate documents: {e}")
        print(f"Error: {e}")

if __name__ == "__main__":
    asyncio.run(simple_example())
