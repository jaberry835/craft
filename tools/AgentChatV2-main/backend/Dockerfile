FROM python:3.12-slim

WORKDIR /app

# Build arguments for custom pip configuration
# Use these when building in environments with private package feeds or hosted wheels
ARG PIP_INDEX_URL=
ARG PIP_EXTRA_INDEX_URL=
ARG PIP_TRUSTED_HOST=

# Configure pip if custom index is provided
RUN if [ -n "$PIP_INDEX_URL" ]; then \
        pip config set global.index-url "$PIP_INDEX_URL"; \
    fi && \
    if [ -n "$PIP_EXTRA_INDEX_URL" ]; then \
        pip config set global.extra-index-url "$PIP_EXTRA_INDEX_URL"; \
    fi && \
    if [ -n "$PIP_TRUSTED_HOST" ]; then \
        pip config set global.trusted-host "$PIP_TRUSTED_HOST"; \
    fi

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

# Expose port
EXPOSE 5000

# Run the application
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "5000"]
