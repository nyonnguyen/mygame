# syntax=docker/dockerfile:1.7

# ── Stage 1: Build frontend ───────────────────────────────────────────
FROM node:22-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY frontend/ .
RUN npm run build

# ── Stage 2: Build Rust backend ──────────────────────────────────────
FROM rust:1-bookworm AS backend-build
WORKDIR /app

# reqwest (native-tls) needs OpenSSL headers at build time
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./
COPY src/ src/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    cargo build --release && \
    cp target/release/retroweb /usr/local/bin/retroweb

# ── Stage 3: Runtime ─────────────────────────────────────────────────
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libssl3 curl tini && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=backend-build /usr/local/bin/retroweb /app/retroweb
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist

ENV ROM_DIR=/roms \
    DATA_DIR=/data \
    FRONTEND_DIR=/app/frontend/dist \
    PORT=3000 \
    RUST_LOG=info \
    HOME=/data

VOLUME ["/roms", "/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://localhost:3000/api/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/retroweb"]
