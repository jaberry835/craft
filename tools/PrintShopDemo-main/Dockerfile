# ── Build stage ──────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

# Copy only frontend sources (backend excluded via .dockerignore)
COPY src/         src/
COPY public/      public/
COPY policies/    policies/
COPY index.html tsconfig*.json vite.config.ts ./

# When served via nginx proxy, the API is on the same origin
ENV VITE_API_URL=
RUN npm run build

# ── Production stage ─────────────────────────────
FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html
ENV BACKEND_UPSTREAM=http://backend:8000
COPY nginx.conf /etc/nginx/templates/default.conf.template

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
