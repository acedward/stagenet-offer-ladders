# Offer ladder service (project 00053). Runtime only: no secrets are baked in.
# Build:  docker compose build     (or: docker build -t stagenet-offer-ladders:local .)
FROM oven/bun:1.3.11

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src
COPY ladders ./ladders
COPY deployments ./deployments
COPY tokens ./tokens
COPY contracts/managed ./contracts/managed

ENV STATUS_PORT=8080 \
    STATE_DIR=/data
EXPOSE 8080

# /health carries no data: 200 "ok" while the scheduler makes progress.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15m --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(process.env.STATUS_PORT||'8080')+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["bun", "src/cli.ts"]
CMD ["ladder:run"]
