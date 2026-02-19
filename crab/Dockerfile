FROM rust:latest AS builder
WORKDIR /usr/src/crab
RUN apt-get update && apt-get install -y musl-dev libssl-dev && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/src/crab/target/release/hermit-crab /usr/local/bin/crab
CMD ["crab"]
