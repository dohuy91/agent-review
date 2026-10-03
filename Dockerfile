# Exact Node version is required for built-in SQLite. Update deliberately.
FROM node:22.22.0-trixie-slim@sha256:465a8c8f0f4103861bcbcf3e512608394b7155eccb1955425f4ea3f672ddc53e AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.31.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps ./apps
COPY bin ./bin
COPY tsconfig.json ./
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:22.22.0-trixie-slim@sha256:465a8c8f0f4103861bcbcf3e512608394b7155eccb1955425f4ea3f672ddc53e AS runtime
ARG REVIEW_UID=10001
ARG REVIEW_GID=10001
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
 && test "$REVIEW_UID" -gt 0 && test "$REVIEW_GID" -gt 0 \
 && userdel node && groupdel node \
 && groupadd --non-unique --gid "$REVIEW_GID" reviewer && useradd --non-unique --uid "$REVIEW_UID" --gid "$REVIEW_GID" --create-home reviewer \
 && mkdir /state && chown reviewer:reviewer /state && chmod 700 /state
WORKDIR /app
COPY --from=build /app /app
COPY scripts/docker-entrypoint.mjs /app/scripts/docker-entrypoint.mjs
ENV REVIEW_DATA_DIR=/state
USER reviewer
EXPOSE 7373
ENTRYPOINT ["node", "/app/scripts/docker-entrypoint.mjs"]
