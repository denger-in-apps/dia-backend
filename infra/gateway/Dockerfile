FROM nginx:alpine

COPY nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh /usr/local/bin/gateway-entrypoint.sh
RUN chmod 0755 /usr/local/bin/gateway-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/gateway-entrypoint.sh"]
