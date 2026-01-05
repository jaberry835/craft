#!/usr/bin/env python3
"""
Quick Start Script for Government Contract Data Generation

This script provides a simple way to generate all project data with minimal setup.
"""

import os
import sys
import subprocess

def check_dependencies():
    """Check if required packages are installed"""
    required_packages = ['openai', 'python-dotenv']
    missing_packages = []
    
    for package in required_packages:
        try:
            __import__(package.replace('-', '_'))
        except ImportError:
            missing_packages.append(package)
    
    if missing_packages:
        print("Missing required packages:")
        for package in missing_packages:
            print(f"  - {package}")
        print("\nInstall them with: pip install -r requirements.txt")
        return False
    
    return True

def check_env_file():
    """Check if .env file exists"""
    if not os.path.exists('.env'):
        print("Error: .env file not found!")
        print("Please copy .env.sample to .env and configure your Azure OpenAI credentials.")
        return False
    return True

def main():
    print("=== Government Contract Data Generator ===")
    print("Quick Start Setup\n")
    
    # Check dependencies
    print("1. Checking dependencies...")
    if not check_dependencies():
        sys.exit(1)
    print("   ✓ Dependencies OK")
    
    # Check environment file
    print("2. Checking environment configuration...")
    if not check_env_file():
        sys.exit(1)
    print("   ✓ Environment file OK")
    
    # Generate data
    print("3. Starting data generation...")
    try:
        from generate_project_data import generate_all_project_data
        generate_all_project_data()
        print("\n✓ Data generation completed successfully!")
        print("\nNext steps:")
        print("1. Review generated data in 'generated_project_data/' folder")
        print("2. Run 'python format_for_rag.py' to create RAG documents")
        print("3. Import the data to your Azure Cognitive Search index")
    except Exception as e:
        print(f"\n✗ Error during data generation: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
