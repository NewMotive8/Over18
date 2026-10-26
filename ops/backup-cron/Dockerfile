# Scheduled Production database backup -> Cloudflare R2.
#
# WHY A SERVICE IN THE PRODUCTION ENVIRONMENT, and not CI: the Production
# database has no public proxy (PGHOST is postgres.railway.internal), so
# nothing outside the Railway environment can reach it. A service here talks
# to it over PRIVATE networking, which means no public database exposure and
# no SSH key with account-wide privileges sitting in a CI secret.
#
# postgres:18-alpine so pg_dump matches the 18.6 server exactly -- a dump
# taken by an older client against a newer server is a avoidable risk.
#
# rclone rather than the AWS CLI: one small static binary, native
# S3-compatible support for R2, and `rclone delete --min-age` gives retention
# without any extra tooling.
FROM postgres:18-alpine

RUN apk add --no-cache rclone ca-certificates

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

# Railway runs this on the service's cron schedule. It must EXIT when done --
# a cron service that keeps running is billed as if it never finished.
CMD ["/usr/local/bin/backup.sh"]
