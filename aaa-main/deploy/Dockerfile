ARG BASE_IMAGE=node:24-alpine
FROM ${BASE_IMAGE}

ENV NODE_ENV=production \
    PORT=8080 \
    AAA_HOST=0.0.0.0 \
    AAA_BROWSER_MODE=disabled \
    AAA_PROJECT_TEMPLATE=/app/template

WORKDIR /app
COPY --chown=node:node dist/ ./dist/
COPY --chown=node:node dist/config/ ./config/
COPY --chown=node:node dist/template/ ./template/
RUN mkdir -p logs data && chown node:node logs data

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '8080') + '/api/auth/config').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"]

CMD ["node", "dist/index.js"]