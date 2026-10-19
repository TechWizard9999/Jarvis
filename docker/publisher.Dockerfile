FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git gh ca-certificates && rm -rf /var/lib/apt/lists/* && mkdir -p /empty-hooks /publish
COPY docker/publish.mjs /opt/bugfix/publish.mjs
WORKDIR /publish
ENTRYPOINT ["node", "/opt/bugfix/publish.mjs"]
