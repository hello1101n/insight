FROM --platform=$BUILDPLATFORM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS builder

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# WORKAROUND: node images past 24 ship no corepack, and its package collides with the image's yarn bins.
RUN npm install -g "pnpm@$(node -p 'require("/app/package.json").packageManager.split("@")[1]')"

RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .

ARG VITE_APP_RELEASE

RUN pnpm run build

FROM nginxinc/nginx-unprivileged:1.31-alpine@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e

# WORKAROUND: the base image runs unprivileged, and the steps below write under /etc/nginx.
USER root

RUN apk upgrade --no-cache

COPY --from=builder /app/dist /usr/share/nginx/html
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

RUN mkdir -p /etc/nginx/snippets
COPY nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template

USER nginx

EXPOSE 8080

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
