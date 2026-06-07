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
COPY package*.json ./
COPY prisma ./prisma
# `npm ci` runs the postinstall `prisma generate`, which needs prisma/schema.prisma.
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Apply schema to the shared DB, then start. db push is idempotent.
CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/index.js"]
