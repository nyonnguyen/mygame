# RetroWeb

A browser-based retro game emulator — a Rust (Axum) backend serves your ROM library and a frontend lets you play games right in the browser. Includes a game library, playtime tracking, collections, cover-art editing, and PWA installation (works on mobile/iOS too).

## Requirements

- [Docker](https://docs.docker.com/get-docker/) (and Docker Compose, bundled with Docker Desktop)
- A directory of ROMs on the host machine to mount into the container

## Quick start with Docker Compose (recommended)

The image is pre-built and published to GHCR, so you don't need to build it yourself.

1. Point it at your ROM directory and start it:

   ```bash
   ROM_DIR=/path/to/roms docker compose up -d
   ```

   If you don't set `ROM_DIR`, Compose defaults to the `./roms` folder in this repo.

2. Open your browser at **http://localhost:3000**

3. View logs / stop:

   ```bash
   docker compose logs -f      # tail logs
   docker compose down         # stop and remove the container
   ```

### Environment variables (Compose)

| Variable         | Default                               | Description                                      |
| ---------------- | ------------------------------------- | ------------------------------------------------ |
| `ROM_DIR`        | `./roms`                              | Host ROM directory mounted into `/roms`          |
| `HOST_PORT`      | `3000`                                | Port on the host                                 |
| `RETROWEB_IMAGE` | `ghcr.io/nyonnguyen/mygame:latest`    | Image to run                                     |
| `RUST_LOG`       | `info`                                | Log level (`info`, `debug`, `warn`, ...)         |

Example — change the port and enable debug logging:

```bash
ROM_DIR=~/Documents/roms HOST_PORT=8080 RUST_LOG=debug docker compose up -d
```

> The ROM directory is mounted **read-only** (`:ro`), so RetroWeb can't modify or delete your ROM files. All other data (settings, metadata, playtime, collections) is stored in the `retroweb-data` Docker volume.

## Running with `docker run` (without Compose)

```bash
docker run -d \
  --name retroweb \
  -p 3000:3000 \
  -v /path/to/roms:/roms:ro \
  -v retroweb-data:/data \
  ghcr.io/nyonnguyen/mygame:latest
```

- `-v /path/to/roms:/roms:ro` — mounts your ROM directory into `/roms` (read-only).
- `-v retroweb-data:/data` — volume that stores settings/metadata so they persist across container restarts.
- Access it at **http://localhost:3000**.

## Building the image yourself (optional)

If you'd rather build from source instead of pulling the image from GHCR:

```bash
docker compose build          # or: docker build -t retroweb .
docker compose up -d
```

## ROM directory layout

RetroWeb scans the **subdirectories** inside the ROM directory — each subdirectory is one system. Folder names should match the system code so they're recognized correctly (proper display name + matching emulator core):

```
roms/
├── nes/          # Nintendo Entertainment System
│   ├── game1.zip
│   └── game2.nes
├── snes/         # Super Nintendo
│   └── game.sfc
├── gba/          # Game Boy Advance
│   └── game.gba
├── genesis/      # Sega Genesis / Mega Drive
└── psx/          # PlayStation
```

Some supported system codes: `nes`, `snes`, `gb`, `gbc`, `gba`, `n64`, `nds`, `genesis`, `megadrive`, `sms`, `gg`, `psx`, `psp`, `dreamcast`, `atari2600`, `arcade`, `mame`, `fbneo`.

Folders such as `bios`, `themes`, `images`, `tools`, `backup`, `ports`, `videos`, `music`, etc. are automatically skipped during scanning.

## Application environment variables

The image ships with the following defaults (you usually don't need to change them when running via Docker):

| Variable       | Default (in container) | Description                                  |
| -------------- | ---------------------- | -------------------------------------------- |
| `ROM_DIR`      | `/roms`                | ROM directory inside the container           |
| `DATA_DIR`     | `/data`                | Where settings, metadata, and playtime live  |
| `PORT`         | `3000`                 | HTTP port of the server                      |
| `FRONTEND_DIR` | `/app/frontend/dist`   | The built frontend directory                 |
| `RUST_LOG`     | `info`                 | Log level                                    |

## Health check

The container ships with a healthcheck that calls `GET /api/health`. Check its status:

```bash
docker ps          # the STATUS column shows (healthy)
curl http://localhost:3000/api/health
```
