FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    LAIG_DOCKER=1 \
    LAIG_SERVER_ONLY=1 \
    LOCAL_API_IMAGE_GENERATOR_DATA_DIR=/data/runtime \
    LAIG_OUTPUT_DIR=/data/output \
    LAIG_DOWNLOAD_DIR=/data/downloads \
    PORT=7868

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY src ./src
COPY assets ./assets

RUN mkdir -p /data/runtime /data/output /data/downloads

EXPOSE 7868
VOLUME ["/data/runtime", "/data/output", "/data/downloads"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD curl -fsS "http://127.0.0.1:${PORT:-7868}/api/health" || exit 1

CMD ["node", "src/docker-server.js"]
