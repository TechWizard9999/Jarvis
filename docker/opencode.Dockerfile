FROM node:24-bookworm-slim
ARG OPENCODE_VERSION=1.19.3
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
RUN npm install --global opencode-ai@${OPENCODE_VERSION}
WORKDIR /agent
RUN npm init -y && npm install --save-exact @opencode-ai/plugin@${OPENCODE_VERSION}
COPY opencode/bugfix.ts /agent/.opencode/tools/bugfix.ts
COPY docker/opencode-entry.mjs /opt/bugfix/opencode-entry.mjs
EXPOSE 4096
ENTRYPOINT ["node", "/opt/bugfix/opencode-entry.mjs"]
