FROM node:24.21.0-bookworm-slim AS node-runtime
RUN npm install --global npm@11.19.0

FROM emscripten/emsdk:6.0.12 AS toolchain
USER root
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates cmake ninja-build make python3 git pkg-config \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node-runtime /usr/local/ /opt/player-node/
ENV PATH="/opt/player-node/bin:${PATH}"
RUN test "$(node --version)" = "v24.21.0" \
    && test "$(npm --version)" = "11.19.0" \
    && emcc --version | head -n 1 | grep '6.0.12'
WORKDIR /workspace
