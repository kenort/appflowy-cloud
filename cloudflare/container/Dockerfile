# syntax=docker/dockerfile:1
# Imagen única para Cloudflare Containers: redis + gotrue + appflowy_cloud.
# Contexto de build: raíz del repo (docker build -f cloudflare/container/Dockerfile .)

# ---------- appflowy_cloud (Rust, este repo) ----------
FROM lukemathwalker/cargo-chef:latest-rust-1.86 AS chef
WORKDIR /app
RUN apt-get update && apt-get install -y protobuf-compiler lld clang

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
# Perfil "ci" (Cargo.toml): sin LTO, compila más rápido y con menos RAM.
ARG PROFILE=ci
ENV CARGO_BUILD_JOBS=2
ENV CARGO_NET_GIT_FETCH_WITH_CLI=true
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --profile ${PROFILE} --recipe-path recipe.json
COPY . .
ENV SQLX_OFFLINE=true
RUN cargo build --profile ${PROFILE} --bin appflowy_cloud \
  && cp target/${PROFILE}/appflowy_cloud /appflowy_cloud

# ---------- gotrue (fork de AppFlowy de supabase/auth, MIT) ----------
FROM golang:1.23 AS gotrue
WORKDIR /src
RUN git clone https://github.com/AppFlowy-IO/auth.git --depth 1 --branch 0.8.0 .
RUN CGO_ENABLED=0 go build -o /auth .

# ---------- runtime ----------
FROM debian:bookworm-slim
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends ca-certificates curl openssl redis-server python3 postgresql-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /appflowy_cloud /usr/local/bin/appflowy_cloud
COPY --from=gotrue /auth /app/gotrue/auth
COPY --from=gotrue /src/migrations /app/gotrue/migrations
COPY cloudflare/container/start.sh /app/start.sh
COPY cloudflare/container/debug_server.py /app/debug_server.py
COPY cloudflare/container/prepare_db.sql /app/prepare_db.sql
RUN chmod +x /app/start.sh

ENV APP_ENVIRONMENT=production
ENV APPFLOWY_APPLICATION_PORT=8000
ENV RUST_BACKTRACE=1
EXPOSE 8000 9999

CMD ["/app/start.sh"]
