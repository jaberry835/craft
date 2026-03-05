FROM python:3.12-slim

WORKDIR /app/backend

# Install dependencies first (layer caching)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend code
COPY . .

# policies/ is mounted at /app/policies via docker-compose volume
# (agent_config.py reads ../policies relative to __file__)

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
