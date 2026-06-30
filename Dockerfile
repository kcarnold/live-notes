# https://docs.docker.com/guides/nodejs/containerize/
FROM node:24-slim
EXPOSE 5008
ENV PORT=5008
WORKDIR /usr/src/app

# Fly.io machines have no public outbound IPv6 route, but the native
# @livekit/rtc-node client (reqwest -> glibc getaddrinfo) otherwise prefers IPv6
# and fails LiveKit region discovery ("failed to retrieve region info"). Raise
# the precedence of IPv4-mapped addresses so getaddrinfo returns IPv4 first.
# (Node's own fetch hides this via Happy Eyeballs fallback; the Rust client does not.)
RUN echo 'precedence ::ffff:0:0/96  100' >> /etc/gai.conf

# The native @livekit/rtc-node Rust client (reqwest) validates TLS against the
# system CA store, not Node's bundled one. node:slim can be missing the CA
# bundle (or the client's vendored OpenSSL looks at a baked-in path absent from
# the slim image), which makes LiveKit region discovery fail with the generic
# "error sending request for url" — even though Node's own fetch succeeds.
# Install the CA bundle and point OpenSSL at it explicitly.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_DIR=/etc/ssl/certs

COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the source files into the image.
COPY . .

# Accept Posthog environment variables as build args (non-sensitive only)
ARG VITE_PUBLIC_POSTHOG_KEY
ARG VITE_PUBLIC_POSTHOG_HOST
ARG POSTHOG_CLI_ENV_ID
ARG POSTHOG_CLI_HOST
ARG GIT_SHA=unknown

ENV NODE_ENV=production
ENV VITE_PUBLIC_POSTHOG_KEY=${VITE_PUBLIC_POSTHOG_KEY}
ENV VITE_PUBLIC_POSTHOG_HOST=${VITE_PUBLIC_POSTHOG_HOST}

RUN npm run build

# Install PostHog CLI and upload source maps (if credentials provided)
# Uses Docker secrets to keep token out of image layers
RUN --mount=type=secret,id=posthog_cli_token \
  if [ -f /run/secrets/posthog_cli_token ]; then \
      POSTHOG_CLI_TOKEN=$(cat /run/secrets/posthog_cli_token) && \
      POSTHOG_CLI_ENV_ID=${POSTHOG_CLI_ENV_ID} && \
      POSTHOG_CLI_HOST=${POSTHOG_CLI_HOST} && \
      if [ -n "$POSTHOG_CLI_TOKEN" ] && [ -n "$POSTHOG_CLI_ENV_ID" ]; then \
        npm install -g @posthog/cli && \
        POSTHOG_ARGS="" && \
        if [ -n "$POSTHOG_CLI_HOST" ]; then \
          POSTHOG_ARGS="--host $POSTHOG_CLI_HOST $POSTHOG_ARGS"; \
        fi && \
        export POSTHOG_CLI_TOKEN && \
        posthog-cli $POSTHOG_ARGS sourcemap inject --directory ./dist --release-name live-outline --release-version ${GIT_SHA} && \
        posthog-cli $POSTHOG_ARGS sourcemap upload --directory ./dist --release-name live-outline --release-version ${GIT_SHA} ; \
      fi; \
    fi

# Create the audio cache directory and set permissions.
RUN mkdir -p audio-cache && chown -R node:node audio-cache

# Run the application as a non-root user.
USER node

CMD ["node", "server.ts"]
