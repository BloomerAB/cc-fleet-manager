# NPM stage (all deps for build)
FROM node:24-alpine AS npm
WORKDIR /app
COPY package.json package-lock.json ./
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
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# UI build stage — pull pre-built UI from its image
ARG UI_IMAGE=ghcr.io/bloomerab/cc-fleet-ui:latest
FROM ${UI_IMAGE} AS ui-source

# Runner stage (production)
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

# Install tools Claude Code needs for effective operation
RUN apk add --no-cache \
    git bash curl jq \
    grep sed findutils coreutils \
    openssh-client \
    github-cli \
    ripgrep \
    python3 \
    helm \
    kubectl \
    && addgroup -g 1001 -S nodejs \
    && adduser -S appuser -u 1001 -h /home/appuser \
    && npm install -g @anthropic-ai/claude-code

COPY --from=deps-prod /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# Copy built UI static files
COPY --from=ui-source /usr/share/nginx/html ./public

# Ensure appuser home exists for claude credentials
RUN mkdir -p /home/appuser/.claude && chown -R appuser:nodejs /home/appuser

USER appuser

EXPOSE 3000

CMD ["node", "dist/index.js"]
