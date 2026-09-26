# docs.agent-custody.dev: the site built from this checkout and served as static files. Build context is the
# repository root (the compose file sets it); the image carries only the built pages and a Caddy serving them.
FROM oven/bun:1 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts && bun run site:build

FROM caddy:2-alpine
COPY --from=build /src/site/.vitepress/dist /srv
COPY deploy/docs.Caddyfile /etc/caddy/Caddyfile
