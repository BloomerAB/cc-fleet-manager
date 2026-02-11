FROM node:24-alpine AS npm
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=npm /app/node_modules ./node_modules/
COPY tsconfig.json package.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -S appuser -u 1001

COPY --chown=appuser:nodejs package*.json ./
RUN npm ci --omit=dev
COPY --chown=appuser:nodejs --from=builder /app/dist ./dist

USER appuser
EXPOSE 3000
CMD ["node", "dist/index.js"]
