# syntax=docker/dockerfile:1
# -------------------------------------------------------------------------
# Multi-stage Dockerfile for the Python MCP Server
#
# Stage 1 (builder) – install uv and resolve dependencies into a venv.
# Stage 2 (runtime) – copy only the venv and application code.
#
# This keeps the final image small (~150 MB) and free of build tools.
# -------------------------------------------------------------------------

# ── Stage 1: dependency resolution ────────────────────────────────────────
FROM python:3.12-slim AS builder

WORKDIR /app

# Copy uv from the official image (avoids installing via pip)
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Copy only the manifests first so Docker caches this layer between code changes.
COPY pyproject.toml ./
# uv.lock is optional but recommended for reproducible builds.
# Generate it locally with:  uv lock
COPY uv.lock* ./

# Install production dependencies into a venv inside /app/.venv
# --frozen:   use exact versions from uv.lock (if present)
# --no-dev:   skip dev-only dependencies
RUN uv sync --frozen --no-dev 2>/dev/null || uv sync --no-dev

# ── Stage 2: runtime image ────────────────────────────────────────────────
FROM python:3.12-slim AS runtime

# Create a non-root user for security.
# Running as root inside a container is a security misconfiguration (OWASP A05).
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser

WORKDIR /app

# Copy the pre-built virtual environment from the builder stage.
COPY --from=builder /app/.venv /app/.venv

# Copy application source.
COPY server.py config.py ./
COPY tools/ ./tools/
COPY auth/  ./auth/

# Make the venv's Python the default for this container.
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Switch to the non-root user.
USER appuser

# Port that Azure Container Apps / App Service will route traffic to.
EXPOSE 8000

# Health check – Azure will use this to determine if the container is healthy.
# Adjust the interval/timeout to match your application's startup time.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

# Production server command.
# For higher concurrency, use multiple workers:
#   CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "4"]
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
