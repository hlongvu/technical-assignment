FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/seat-reservation/package.json ./apps/seat-reservation/
COPY packages/be-core/package.json ./packages/be-core/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/tsconfig-base/package.json ./packages/tsconfig-base/
RUN npm install --workspace=apps/seat-reservation --workspace=packages/be-core --workspace=packages/contracts --workspace=packages/tsconfig-base --include-workspace-root=false
COPY tsconfig.base.json ./tsconfig.base.json
COPY packages/tsconfig-base ./packages/tsconfig-base
COPY packages/be-core ./packages/be-core
COPY packages/contracts ./packages/contracts
COPY apps/seat-reservation ./apps/seat-reservation
RUN npm run build -w packages/be-core
RUN npm run build -w packages/contracts
RUN npm run build -w apps/seat-reservation

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S node && adduser -S node -G node
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/seat-reservation/node_modules ./apps/seat-reservation/node_modules
COPY --from=builder /app/packages/be-core/dist ./packages/be-core/dist
COPY --from=builder /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=builder /app/apps/seat-reservation/dist ./apps/seat-reservation/dist
COPY --from=builder /app/apps/seat-reservation/package.json ./apps/seat-reservation/package.json
COPY --from=builder /app/packages/be-core/package.json ./packages/be-core/package.json
COPY --from=builder /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=builder /app/package.json ./package.json
USER node
EXPOSE 4002
HEALTHCHECK --interval=10s --timeout=5s --retries=10 \
  CMD wget -qO- http://localhost:4002/health/live || exit 1
CMD ["node", "apps/seat-reservation/dist/main.js"]
