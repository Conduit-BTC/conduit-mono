FROM oven/bun:1.3.5 AS bun
FROM mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx
