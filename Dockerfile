# ── Stage 1: Build frontend ───────────────────────────────────────────
FROM node:22-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --ignore-scripts 2>/dev/null || npm install
COPY frontend/ .
RUN npx vite build

# ── Stage 2: Build Rust backend ──────────────────────────────────────
FROM rust:1.95-alpine AS backend-build
RUN apk add --no-cache musl-dev
WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
COPY src/ src/
RUN cargo build --release

# ── Stage 3: Runtime ─────────────────────────────────────────────────
FROM alpine:3.21
RUN apk add --no-cache ca-certificates
WORKDIR /app

COPY --from=backend-build /app/target/release/retroweb /app/retroweb
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist

ENV ROM_DIR=/roms
ENV PORT=3000
EXPOSE 3000

CMD ["/app/retroweb"]
