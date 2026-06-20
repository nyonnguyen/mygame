# RetroWeb

Trình giả lập game retro chạy trên trình duyệt — backend Rust (Axum) phục vụ thư viện ROM và frontend chơi game ngay trong browser. Hỗ trợ thư viện game, thời gian chơi, bộ sưu tập (collections), chỉnh sửa ảnh bìa, và cài đặt như một PWA (chơi được trên cả mobile/iOS).

## Yêu cầu

- [Docker](https://docs.docker.com/get-docker/) (và Docker Compose, đi kèm Docker Desktop)
- Một thư mục chứa ROM trên máy host để mount vào container

## Chạy nhanh với Docker Compose (khuyến nghị)

Image đã được build sẵn và đẩy lên GHCR, nên bạn không cần build lại.

1. Trỏ tới thư mục ROM của bạn rồi khởi chạy:

   ```bash
   ROM_DIR=/duong/dan/toi/roms docker compose up -d
   ```

   Nếu không đặt `ROM_DIR`, Compose mặc định dùng thư mục `./roms` trong repo này.

2. Mở trình duyệt tại **http://localhost:3000**

3. Xem log / dừng:

   ```bash
   docker compose logs -f      # xem log
   docker compose down         # dừng và xoá container
   ```

### Biến môi trường (Compose)

| Biến             | Mặc định                              | Mô tả                                          |
| ---------------- | ------------------------------------- | ---------------------------------------------- |
| `ROM_DIR`        | `./roms`                              | Thư mục ROM trên host được mount vào `/roms`   |
| `HOST_PORT`      | `3000`                                | Cổng trên host                                 |
| `RETROWEB_IMAGE` | `ghcr.io/nyonnguyen/mygame:latest`    | Image dùng để chạy                             |
| `RUST_LOG`       | `info`                                | Mức log (`info`, `debug`, `warn`...)           |

Ví dụ đổi cổng và bật log debug:

```bash
ROM_DIR=~/Documents/roms HOST_PORT=8080 RUST_LOG=debug docker compose up -d
```

> Thư mục ROM được mount ở chế độ **chỉ đọc** (`:ro`) nên RetroWeb không thể sửa/xoá file ROM của bạn. Mọi dữ liệu khác (cài đặt, metadata, thời gian chơi, bộ sưu tập) được lưu trong Docker volume `retroweb-data`.

## Chạy bằng `docker run` (không dùng Compose)

```bash
docker run -d \
  --name retroweb \
  -p 3000:3000 \
  -v /duong/dan/toi/roms:/roms:ro \
  -v retroweb-data:/data \
  ghcr.io/nyonnguyen/mygame:latest
```

- `-v /duong/dan/toi/roms:/roms:ro` — mount thư mục ROM của bạn vào `/roms` (chỉ đọc).
- `-v retroweb-data:/data` — volume lưu cài đặt/metadata để giữ lại sau khi container restart.
- Truy cập tại **http://localhost:3000**.

## Tự build image (tuỳ chọn)

Nếu muốn build từ source thay vì kéo image từ GHCR:

```bash
docker compose build          # hoặc: docker build -t retroweb .
docker compose up -d
```

## Cấu trúc thư mục ROM

RetroWeb quét **các thư mục con** bên trong thư mục ROM — mỗi thư mục con là một hệ máy (system). Tên thư mục nên khớp với mã hệ máy để được nhận diện đúng (tên đẹp + core emulator phù hợp):

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

Một số mã hệ máy được hỗ trợ: `nes`, `snes`, `gb`, `gbc`, `gba`, `n64`, `nds`, `genesis`, `megadrive`, `sms`, `gg`, `psx`, `psp`, `dreamcast`, `atari2600`, `arcade`, `mame`, `fbneo`.

Các thư mục như `bios`, `themes`, `images`, `tools`, `backup`, `ports`, `videos`, `music`... sẽ tự động bị bỏ qua khi quét.

## Các biến môi trường của ứng dụng

Image đặt sẵn các giá trị mặc định sau (thường không cần đổi khi chạy bằng Docker):

| Biến           | Mặc định (trong container) | Mô tả                                     |
| -------------- | -------------------------- | ----------------------------------------- |
| `ROM_DIR`      | `/roms`                    | Thư mục ROM bên trong container           |
| `DATA_DIR`     | `/data`                    | Nơi lưu cài đặt, metadata, thời gian chơi |
| `PORT`         | `3000`                     | Cổng HTTP của server                      |
| `FRONTEND_DIR` | `/app/frontend/dist`       | Thư mục frontend đã build                 |
| `RUST_LOG`     | `info`                     | Mức log                                   |

## Health check

Container có sẵn healthcheck gọi `GET /api/health`. Kiểm tra trạng thái:

```bash
docker ps          # cột STATUS sẽ hiển thị (healthy)
curl http://localhost:3000/api/health
```
