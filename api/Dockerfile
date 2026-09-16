FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY api/package.json api/package.json
COPY web/package.json web/package.json
RUN npm ci
COPY api/src api/src
COPY api/tsconfig.json api/tsconfig.json
COPY infra/seed.mjs infra/seed.mjs
RUN npm run build --workspace=@gitdb/api \
  && cp api/src/vcs/schema.sql api/dist/vcs/schema.sql \
  && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/api/package.json api/package.json
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/api/dist api/dist
COPY --from=build /app/infra/seed.mjs infra/seed.mjs
WORKDIR /app/api
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --retries=20 \
  CMD node -e "fetch('http://localhost:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
