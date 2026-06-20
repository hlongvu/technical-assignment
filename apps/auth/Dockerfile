# Multi-stage build, non-root user (Checklist §4.2.3)
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/auth/package.json ./apps/auth/
COPY packages/be-core/package.json ./packages/be-core/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/tsconfig-base/package.json ./packages/tsconfig-base/
RUN npm install --workspace=apps/auth --workspace=packages/be-core --workspace=packages/contracts --workspace=packages/tsconfig-base --include-workspace-root=false
COPY tsconfig.base.json ./tsconfig.base.json
COPY packages/tsconfig-base ./packages/tsconfig-base
COPY packages/be-core ./packages/be-core
COPY packages/contracts ./packages/contracts
COPY apps/auth ./apps/auth
RUN npm run build -w packages/tsconfig-base || true
RUN npm run build -w packages/be-core
RUN npm run build -w packages/contracts
RUN npm run build -w apps/auth

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S node && adduser -S node -G node
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/auth/node_modules ./apps/auth/node_modules
COPY --from=builder /app/packages/be-core/dist ./packages/be-core/dist
COPY --from=builder /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=builder /app/apps/auth/dist ./apps/auth/dist
COPY --from=builder /app/apps/auth/package.json ./apps/auth/package.json
COPY --from=builder /app/packages/be-core/package.json ./packages/be-core/package.json
COPY --from=builder /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=builder /app/package.json ./package.json
USER node
EXPOSE 4001
HEALTHCHECK --interval=10s --timeout=5s --retries=10 \
  CMD wget -qO- http://localhost:4001/health/live || exit 1
CMD ["node", "apps/auth/dist/main.js"]
