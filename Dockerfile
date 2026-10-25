FROM node:24-alpine AS build
WORKDIR /app
ENV NODE_OPTIONS=--max-old-space-size=512
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY server ./server
COPY web ./web
# The build time is written into the image: /healthz answers with it, so a deploy can be told apart without the login.
RUN npm run build && npm prune --omit=dev && date -u +%Y-%m-%dT%H:%M:%SZ > /app/build-time

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=80 DB_PATH=/data/deposim.sqlite
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/build-time ./build-time
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 80
# Answers only while the process serves; /healthz is the one URL without the login.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:${PORT}/healthz >/dev/null || exit 1
CMD ["node", "server/dist/main.js"]
