# syntax=docker/dockerfile:1
FROM node:24-slim AS build
WORKDIR /app
# OpenSSL is required by Prisma's query engine.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV BOOKIE_TRANSPORT=http
# Pinned so Railway's public-domain target port always matches what the
# server actually binds — without an EXPOSE, Railway's one-click template
# defaults the domain's target port to 3000 regardless of what PORT the
# container is given, which 502s every request even though the container
# is healthy (confirmed by a live deploy: fixed by setting the domain's
# target port to match this value).
ENV PORT=8080
EXPOSE 8080
COPY package*.json ./
COPY prisma ./prisma
# `npm ci` runs the postinstall `prisma generate`, which needs prisma/schema.prisma.
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Apply schema to the shared DB, then start. db push is idempotent.
CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/index.js"]
