# The API (and the built web app, served by Caddy from the web image).
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY packages packages
COPY apps apps
RUN npm run build -w @neuracraft/shared && npm run build -w @neuracraft/api && npm run build -w @neuracraft/web

FROM node:22-alpine AS api
WORKDIR /app
ENV NODE_ENV=production MIGRATIONS_DIR=/app/db/migrations
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --no-audit --no-fund -w @neuracraft/api -w @neuracraft/shared
COPY --from=build /src/packages/shared/dist packages/shared/dist
COPY --from=build /src/apps/api/dist apps/api/dist
COPY db db
USER node
EXPOSE 8080
CMD ["node", "apps/api/dist/src/main.js"]

FROM caddy:2-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/apps/web/dist /srv
