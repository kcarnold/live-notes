# https://docs.docker.com/guides/nodejs/containerize/
FROM node:24-slim
EXPOSE 5008
ENV PORT=5008
WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the source files into the image.
COPY . .

# Accept Posthog environment variables as build args (non-sensitive only)
ARG VITE_PUBLIC_POSTHOG_KEY
ARG VITE_PUBLIC_POSTHOG_HOST
ARG POSTHOG_CLI_ENV_ID
ARG POSTHOG_CLI_HOST

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
        posthog-cli $POSTHOG_ARGS sourcemap inject --directory ./dist --project live-outline && \
        posthog-cli sourcemap upload --directory ./dist ; \
      fi; \
    fi

# Create the audio cache directory and set permissions.
RUN mkdir -p audio-cache && chown -R node:node audio-cache

# Run the application as a non-root user.
USER node

CMD ["node", "server.ts"]
