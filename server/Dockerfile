FROM node:24.22.0-alpine AS web-build

WORKDIR /web

COPY wasm-page/package.json wasm-page/pnpm-lock.yaml wasm-page/pnpm-workspace.yaml ./
RUN npm install --global "$(node -p 'require("./package.json").packageManager')" \
	&& pnpm install --frozen-lockfile

COPY wasm-page ./
RUN pnpm run build:pages
COPY LICENSE GPL-3.0.txt LICENSE-ADDITIONAL_TERMS-zh-CN.md LICENSE-ADDITIONAL_TERMS-en.md /notices/
COPY LICENSE.TXT /notices/UPSTREAM-LICENSE.txt
RUN for notice in /notices/*; do test -s "$notice" || exit 1; done \
    && cp /notices/* dist/ppsspp-web/

FROM python:3.13-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends openssl \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server/serve.py server/relay.py server/relay_auth.py server/relay_admin.py ./server/
COPY --from=web-build /web/dist/ppsspp-web ./wasm-page/dist/ppsspp-web

WORKDIR /app/server

RUN mkdir -p /certs /data && chown -R 10001:10001 /certs /data
USER 10001:10001

EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD python3 -c "import ssl,urllib.request; urllib.request.urlopen('https://127.0.0.1:8081/healthz',context=ssl._create_unverified_context(),timeout=2).read()"

CMD ["python3", "serve.py", "--https", "--cert", "/certs/cert.pem", "--key", "/certs/key.pem", "--bind", "0.0.0.0", "--port", "8081", "--wasm-root", "/wasm", "--adhoc-ws"]
