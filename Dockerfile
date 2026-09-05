FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      gnupg \
      iproute2 \
      iputils-ping \
      procps \
      python3 \
      tmux \
      unzip \
      zip \
    && curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
      -o /etc/apt/trusted.gpg.d/ngrok.asc \
    && echo "deb https://ngrok-agent.s3.amazonaws.com bookworm main" \
      > /etc/apt/sources.list.d/ngrok.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends ngrok \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/.runtime /workspace \
    && chmod -R a+rX /app \
    && chown -R node:node /app/.runtime /workspace

USER node

CMD ["node", "mcp-supervisor.js"]
