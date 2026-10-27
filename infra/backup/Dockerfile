FROM postgres:16-alpine

RUN apk add --no-cache age
COPY backup-loop.sh /usr/local/bin/backup-loop.sh
RUN chmod 0755 /usr/local/bin/backup-loop.sh

ENTRYPOINT ["/usr/local/bin/backup-loop.sh"]
