# Dashboard build stage
FROM node:24-alpine AS dashboard
WORKDIR /dashboard
ARG NPM_TOKEN
ARG DASHBOARD_REPO=https://github.com/BloomerAB/claude-dashboard.git
ARG DASHBOARD_REF=main
RUN apk add --no-cache git \
    && REPO_HOST=$(echo "${DASHBOARD_REPO}" | sed 's|https://||') \
    && git clone --depth 1 --branch ${DASHBOARD_REF} \
       "https://x-access-token:${NPM_TOKEN}@${REPO_HOST}" .
COPY .npmrc .npmrc
RUN npm ci && npm run build

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
COPY --from=dashboard /dashboard/dist ./public
COPY package.json ./

USER appuser

EXPOSE 3000

CMD ["node", "dist/index.js"]
