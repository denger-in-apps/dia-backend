#!/bin/sh
set -eu

cert=/etc/nginx/certs/tls.crt
key=/etc/nginx/certs/tls.key

if [ "${TLS_MODE:-production}" = "development" ]; then
  mkdir -p /etc/nginx/certs
  if [ ! -s "$cert" ] || [ ! -s "$key" ]; then
    echo "Creating a local self-signed TLS certificate for localhost"
    openssl req -x509 -nodes -days 3650 -newkey rsa:3072 \
      -keyout "$key" -out "$cert" \
      -subj "/CN=localhost" \
      -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1"
    chmod 0600 "$key"
  fi
elif [ "${TLS_MODE}" = "production" ]; then
  if [ ! -s "$cert" ] || [ ! -s "$key" ]; then
    echo "TLS_MODE=production requires /etc/nginx/certs/tls.crt and tls.key" >&2
    exit 1
  fi
else
  echo "TLS_MODE must be development or production" >&2
  exit 1
fi

exec nginx -g 'daemon off;'
