# Build stage
FROM node:20-alpine AS build

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build argument for backend URL (for A2A endpoints that need direct backend access)
ARG BACKEND_URL=

# Inject backend URL into environment.prod.ts if provided
# Sets apiUrl to BACKEND_URL/api (for API calls) and backendUrl (for A2A)
RUN if [ -n "$BACKEND_URL" ]; then \
      sed -i "s|apiUrl: ''|apiUrl: '${BACKEND_URL}/api'|g" src/environments/environment.prod.ts && \
      sed -i "s|backendUrl: ''|backendUrl: '$BACKEND_URL'|g" src/environments/environment.prod.ts; \
    else \
      sed -i "s|apiUrl: ''|apiUrl: '/api'|g" src/environments/environment.prod.ts; \
    fi

# Build the application
RUN npm run build -- --configuration=production

# Production stage - using nginx
FROM nginx:alpine

# Copy custom nginx config
COPY nginx.conf /etc/nginx/nginx.conf

# Copy built assets from build stage
COPY --from=build /app/dist/agent-chat/browser /usr/share/nginx/html

# Expose port 80
EXPOSE 80

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
