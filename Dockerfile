# NPM stage (all deps for build)
FROM node:24-alpine AS npm
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
ARG NPM_TOKEN
RUN npm ci

# Builder stage
FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=npm /app/node_modules ./node_modules/
COPY ./src ./src
COPY tsconfig.json package.json ./
RUN ./node_modules/.bin/tsc && ./node_modules/.bin/tsc-alias

# Production deps only
FROM node:24-alpine AS deps-prod
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
ARG NPM_TOKEN
RUN npm ci --omit=dev

# Runner stage (production)
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -g 1001 -S nodejs && adduser -S appuser -u 1001

COPY --from=deps-prod /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

USER appuser

EXPOSE 3000

CMD ["node", "dist/index.js"]
