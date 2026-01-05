"""WSGI entry point for Azure App Service."""

import os
import sys
from pathlib import Path

# Add src to Python path
src_path = Path(__file__).parent / "src"
sys.path.insert(0, str(src_path))

from api.app import create_app

# Create the Flask app instance
app = create_app()

# For Azure App Service, we need to expose the app instance
# The startup command will be: gunicorn --bind 0.0.0.0:8000 wsgi:app
if __name__ == "__main__":
    # For local development, run with standard Flask
    port = int(os.environ.get('PORT', 5007))
    app.run(host='0.0.0.0', port=port, debug=False)
