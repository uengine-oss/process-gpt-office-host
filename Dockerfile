# syntax=docker/dockerfile:1.7
# office-host image: the eight IeumOffice editors as web pages + their main-process
# code + the Rust xlsx sidecar, in one service (the sidecar is a child process, not
# a separate service).
#
# Build from this repository's root, with the fork submodule checked out:
#   git submodule update --init
#   docker build -t process-gpt-office-host .
# Run (in-house LLM + Supabase Storage):
#   docker run -p 5390:5390 -v process-gpt-office-data:/data \
#     -e CUSTOM_LLM_BASE_URL=http://<llm-server>/v1 -e CUSTOM_LLM_API_KEY=… \
#     -e SUPABASE_URL=http://kong:8000 -e SUPABASE_SERVICE_ROLE_KEY=… -e SUPABASE_JWT_SECRET=… \
#     -e IEUM_ALLOWED_SOURCES=https://<public supabase origin> process-gpt-office-host

FROM rust:1-bookworm AS sidecar
WORKDIR /src
COPY ieumoffice/apps/sheets/native/xlsx-engine ./xlsx-engine
RUN cargo build --release --manifest-path xlsx-engine/Cargo.toml --config xlsx-engine/.cargo/config.toml

FROM node:22-bookworm AS build
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
WORKDIR /app
COPY ieumoffice ./ieumoffice
# the HWP editor (rhwp-studio) is built from its pinned upstream tag
RUN cd ieumoffice && npm ci --no-audit --no-fund && npm run studio -w @genoffice/hwp
COPY host ./host
COPY NOTICE.md ./
# the build scripts (esbuild, vite) come from the fork's dependencies
RUN ln -sfn ieumoffice/node_modules node_modules \
 && cd host && node build.mjs && node build-web.mjs && node build-licenses.mjs

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app/ieumoffice/node_modules ./ieumoffice/node_modules
COPY --from=build /app/ieumoffice/packages/ui/template-fonts ./ieumoffice/packages/ui/template-fonts
# office-worker: the HWP engine (node_modules/@rhwp/core links here) and the root package.json
COPY --from=build /app/ieumoffice/vendor/rhwp-core ./ieumoffice/vendor/rhwp-core
COPY --from=build /app/ieumoffice/package.json ./ieumoffice/package.json
COPY --from=build /app/host/dist ./host/dist
COPY --from=build /app/dist ./dist
# Apache-2.0 §4: the notices travel with the editors (also served at /office/licenses/)
COPY --from=build /app/dist/licenses /app/licenses
COPY --from=sidecar /src/xlsx-engine/target/release/xlsx-sidecar /usr/local/bin/xlsx-sidecar
# npm packages the host bundle leaves external resolve from here
RUN ln -s ieumoffice/node_modules node_modules
ENV NODE_ENV=production \
    IEUM_HOST_PORT=5390 \
    IEUM_HOST_DATA=/data \
    XLSX_SIDECAR_PATH=/usr/local/bin/xlsx-sidecar \
    CUSTOM_LLM_MODEL=frentis-ai-model
VOLUME /data
EXPOSE 5390
WORKDIR /app/host
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:5390/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/office-host.mjs"]
