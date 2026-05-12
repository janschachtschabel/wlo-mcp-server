FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Repository defaults to WLO production. Override at run time, e.g.:
#   docker run -e WLO_REPOSITORY_URL=https://repository.staging.openeduhub.net/edu-sharing wlomcp
ENV WLO_REPOSITORY_URL=https://redaktion.openeduhub.net/edu-sharing
ENV PORT=3000
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

EXPOSE 3000

# Default: HTTP server (use CMD override for stdio)
CMD ["node", "dist/http.js"]
