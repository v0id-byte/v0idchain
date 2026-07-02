# v0idChain node — joins the live network and syncs the chain.
# Build:  docker build -t v0idchain .
# Run:    docker run --rm v0idchain                 # sync only
#         docker run --rm v0idchain <cmd...> --mine # append --mine to mine
#
# Note: the local HTTP API binds 127.0.0.1 *inside* the container by design,
# so it is not exposed via -p. Use `docker exec <id> \
#   pnpm exec tsx packages/cli/src/index.ts ...` or curl localhost:7001/health
# from inside the container. P2P (6001) is outbound to the seed — no inbound
# port is required for a basic syncing/mining node.
FROM node:22-slim

# ca-certificates for outbound wss/https to the seed
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

# Bring in the source and install (pnpm version comes from packageManager)
COPY . .
RUN pnpm install --frozen-lockfile

# P2P port, and the local HTTP API port (bound to 127.0.0.1 inside the container)
EXPOSE 6001 7001

# Persist keys + chain data across restarts
VOLUME ["/app/.data"]

# Default: join the live network and sync. Add --mine to mine.
CMD ["pnpm", "exec", "tsx", "packages/cli/src/index.ts", "start", \
     "--name", "docker", \
     "--p2p-port", "6001", \
     "--api-port", "7001", \
     "--peers", "ws://mc.void1211.com:6001"]
