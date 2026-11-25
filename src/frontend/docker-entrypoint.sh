#!/bin/sh
set -e

# WORKAROUND: without a variable list envsubst also replaces nginx's own `$` variables.
envsubst '${SENTRY_CONNECT_SRC}' \
  < /etc/nginx/templates/default.conf.template \
  > /etc/nginx/conf.d/default.conf

exec "$@"
