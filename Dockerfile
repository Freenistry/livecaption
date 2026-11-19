# Two images from one file (docker-compose.yml picks the target):
#   node    Node server (server.js): the app page, /live, and the first version's routes
#   elixir  Elixir server (server_ex/) + engine.js (the same /live models in a Node child)
# Models are not baked in: they live in the "models" volume, filled once by the compose "models" step (setup.sh).

# --- Node deps, shared by both images (Debian trixie: same glibc as the Elixir image) -----------------------------------
FROM node:22.23.4-trixie-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# --- models step: downloads + sha256-checks every model into /app/models -------------------------------------------------
FROM deps AS models
RUN apt-get update && apt-get install -y --no-install-recommends curl bzip2 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY setup.sh get-models.js mt-fast.js ./
ENV MODELS_ONLY=1
ENTRYPOINT ["./setup.sh"]

# --- Node server ------------------------------------------------------------------------------------------------------
FROM node:22.23.4-trixie-slim AS node
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json server.js live.js asr-multi.js mt-fast.js ./
COPY public public
ENV HOST=0.0.0.0 PORT=3000 NODE_ENV=production
EXPOSE 3000
USER node
HEALTHCHECK --interval=10s --start-period=120s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.js"]

# --- Elixir release build ---------------------------------------------------------------------------------------------
FROM elixir:1.19.7-otp-28-slim AS ex-build
ENV MIX_ENV=prod
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/* # slim: no CA certs for hex.pm
RUN mix local.hex --force && mix local.rebar --force
COPY server_ex/mix.exs ./
RUN mix deps.get --only prod && mix deps.compile
COPY server_ex/lib lib
RUN mix release

# --- Elixir server: the release (bundles the Erlang runtime) + Node for engine.js ---------------------------------------
FROM debian:trixie-slim AS elixir
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 libncurses6 locales ca-certificates && rm -rf /var/lib/apt/lists/*  && sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen
COPY --from=node:22.23.4-trixie-slim /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json engine.js live.js asr-multi.js mt-fast.js ./
COPY public public
COPY --from=ex-build /src/_build/prod/rel/livecaption /app/rel
RUN useradd -m app
ENV HOST=0.0.0.0 PORT=3000 APP_ROOT=/app LANG=en_US.UTF-8
EXPOSE 3000
USER app
HEALTHCHECK --interval=10s --start-period=120s CMD node -e "fetch('http://127.0.0.1:3000/api/languages').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["/app/rel/bin/livecaption", "start"]
