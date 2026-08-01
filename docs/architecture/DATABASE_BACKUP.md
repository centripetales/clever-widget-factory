# Database backup guide

**Status:** current-state reference — keep this accurate.
**Last verified:** 2026-08-01 — confirmed no `.github/workflows/rds-backup.yml`
exists; the only automated-sounding claim in the previous version of this doc
was wrong. The actual current mechanism is a manual/cron script, below.

## Current setup: manual snapshot script

```bash
./scripts/cron/backup-rds-daily.sh
```

This creates an RDS snapshot named `cwf-manual-{DATE}` and prunes old ones
down to the 3 most recent (roughly 6 days of coverage, depending on how
often it's actually run). It is **not** wired into GitHub Actions or any
other scheduler as of this writing — it only runs when someone runs it. If
you want it automated, that's still open work, not a currently-running
system.

**Check backup status:**
```bash
aws rds describe-db-snapshots \
  --db-instance-identifier cwf-dev-postgres \
  --snapshot-type manual \
  --region us-west-2 \
  --query "DBSnapshots[?starts_with(DBSnapshotIdentifier, 'cwf-manual-')].{ID:DBSnapshotIdentifier,Time:SnapshotCreateTime,Status:Status}" \
  --output table
```

## Other backup options (not currently in use, for reference)

### 1. AWS RDS automated backups
Point-in-time recovery, no manual intervention. Costs ~$0.095/GB-month for
backup storage.
```bash
aws rds modify-db-instance \
  --db-instance-identifier cwf-dev-postgres \
  --backup-retention-period 7 \
  --preferred-backup-window "03:00-04:00" \
  --region us-west-2
```

### 2. `pg_dump` to S3 (logical backups)
Portable across PostgreSQL versions, smaller/compressed, but slower for
large databases and needs more setup.
```bash
DATE=$(date +%Y%m%d)
PGPASSWORD=$DB_PASSWORD pg_dump \
  -h your-rds-endpoint.rds.amazonaws.com \
  -U postgres -d cwf_db -F c \
  -f /tmp/backup-${DATE}.dump
aws s3 cp /tmp/backup-${DATE}.dump s3://cwf-backups/db/backup-${DATE}.dump
```

### 3. AWS Backup service
Centralized management, cross-region copies, compliance reporting,
lifecycle policies. ~$0.05/GB-month + restore costs. Configure via the AWS
Backup console or CloudFormation.

## Restore from a snapshot

```bash
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier cwf-restored \
  --db-snapshot-identifier cwf-manual-<date> \
  --region us-west-2
```

## Testing a restore

Worth doing periodically rather than assuming backups work:
```bash
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier cwf-test-restore \
  --db-snapshot-identifier cwf-manual-<date> \
  --db-instance-class db.t3.micro \
  --region us-west-2

# ... verify data integrity and app connectivity, then clean up ...

aws rds delete-db-instance \
  --db-instance-identifier cwf-test-restore \
  --skip-final-snapshot \
  --region us-west-2
```
