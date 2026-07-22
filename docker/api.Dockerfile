FROM node:22-bookworm-slim

ENV NODE_ENV=production

RUN groupadd --gid 10001 cadir-api \
    && useradd --uid 10001 --gid cadir-api --create-home --shell /usr/sbin/nologin cadir-api \
    && mkdir -p /app/apps/api /app/packages/contracts /data /workspace/jobs /workspace/rag-library \
    && chown -R cadir-api:cadir-api /app /data /workspace

WORKDIR /app/apps/api
COPY --chown=cadir-api:cadir-api apps/api/package.json apps/api/package-lock.json ./
RUN npm ci --include=dev
COPY --chown=cadir-api:cadir-api apps/api/tsconfig.json ./tsconfig.json
COPY --chown=cadir-api:cadir-api apps/api/src ./src
COPY --chown=cadir-api:cadir-api packages/contracts /app/packages/contracts

USER cadir-api
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]
