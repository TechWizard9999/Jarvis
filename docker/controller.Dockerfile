FROM docker:29-cli AS client
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tar && rm -rf /var/lib/apt/lists/*
COPY --from=client /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY profiles ./profiles
COPY tests ./tests
ENV BUGFIX_BIND=0.0.0.0 BUGFIX_PORT=3210
EXPOSE 3210
CMD ["node", "src/cli.ts", "serve"]
