# The API, bundled into one file, and the web app as static files served by Caddy.
FROM node:20-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @pos/web exec vite build
RUN npx esbuild apps/api/src/server.ts --bundle --platform=node --target=node20 --format=esm \
      --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
      --outfile=/out/api/dist/server.mjs \
 && cp -r apps/api/migrations /out/api/migrations \
 && cp -r apps/web/dist /out/web

FROM node:20-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production TRUST_PROXY=1
COPY --from=build /out/api ./
USER node
EXPOSE 3000
CMD ["node", "dist/server.mjs"]

FROM caddy:2.8-alpine AS web
COPY --from=build /out/web /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
