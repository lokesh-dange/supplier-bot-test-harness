FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY ui ./ui
COPY scenarios ./scenarios
COPY fixtures ./fixtures
COPY contracts ./contracts

EXPOSE 8799

ENV NODE_ENV=production

# Managed hosts (e.g. Render) set PORT. The harness reads SOURCY_HARNESS_PORT.
# Bind all interfaces in containers unless operator overrides (local dev default remains 127.0.0.1).
CMD ["sh", "-c", "if [ -n \"$PORT\" ]; then export SOURCY_HARNESS_PORT=\"$PORT\"; fi; if [ -z \"$SOURCY_HARNESS_HOST\" ]; then export SOURCY_HARNESS_HOST=0.0.0.0; fi; exec node server/harness-server.mjs"]
