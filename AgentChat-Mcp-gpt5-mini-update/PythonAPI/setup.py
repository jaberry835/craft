"""Setup script for the Python API with MCP Server."""

import os
import subprocess
import sys
from pathlib import Path


def run_command(command, description):
    """Run a command and handle errors."""
    print(f"\n{description}...")
    print(f"Running: {command}")
    
    result = subprocess.run(command, shell=True, capture_output=True, text=True)
    
    if result.returncode == 0:
        print(f"✅ {description} completed successfully")
        if result.stdout:
            print(result.stdout)
    else:
        print(f"❌ {description} failed")
        if result.stderr:
            print(f"Error: {result.stderr}")
        return False
    
    return True


def main():
    """Main setup script."""
    print("="*60)
    print("Python API with MCP Server - Setup Script")
    print("="*60)
    
    # Check Python version
    if sys.version_info < (3, 8):
        print("❌ Python 3.8 or higher is required")
        sys.exit(1)
    
    print(f"✅ Python {sys.version} detected")
    
    # Create virtual environment
    if not Path("venv").exists():
        if not run_command("python -m venv venv", "Creating virtual environment"):
            sys.exit(1)
    else:
        print("✅ Virtual environment already exists")
    
    # Determine activation script based on OS
    if os.name == 'nt':  # Windows
        activate_script = "venv\\Scripts\\activate"
        pip_command = "venv\\Scripts\\pip"
    else:  # Unix/Linux/Mac
        activate_script = "source venv/bin/activate"
        pip_command = "venv/bin/pip"
    
    print(f"\n📝 To activate virtual environment manually:")
    if os.name == 'nt':
        print(f"   .\\venv\\Scripts\\Activate.ps1  (PowerShell)")
        print(f"   venv\\Scripts\\activate.bat     (Command Prompt)")
    else:
        print(f"   {activate_script}")
    
    # Install requirements
    if not run_command(f"{pip_command} install --upgrade pip", "Upgrading pip"):
        sys.exit(1)
    
    if not run_command(f"{pip_command} install -r requirements.txt", "Installing requirements"):
        sys.exit(1)
    
    # Create .env file if it doesn't exist
    env_file = Path(".env")
    env_example = Path(".env.example")
    
    if not env_file.exists() and env_example.exists():
        env_file.write_text(env_example.read_text())
        print("✅ Created .env file from template")
        print("📝 Please edit .env file with your configuration")
    else:
        print("ℹ️  .env file already exists or .env.example not found")
    
    print("\n" + "="*60)
    print("Setup completed successfully! 🎉")
    print("="*60)
    
    print("\nNext steps:")
    print("1. Activate the virtual environment:")
    if os.name == 'nt':
        print("   .\\venv\\Scripts\\Activate.ps1")
    else:
        print("   source venv/bin/activate")
    
    print("2. Edit .env file with your settings")
    print("3. Run the application:")
    print("   python main.py")
    print("\nOr run just the MCP server:")
    print("   python mcp_server_standalone.py")
    
    print("\nFor development with MCP Inspector:")
    print("   mcp dev mcp_server_standalone.py")
    
    print("\nAPI will be available at:")
    print("   - Flask API: http://localhost:5007")
    print("   - MCP Server: http://localhost:3001/mcp")
    print("   - Health Check: http://localhost:5007/health")


if __name__ == "__main__":
    main()
