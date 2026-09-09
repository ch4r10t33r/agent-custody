# Running the log: the runbook

Day-two procedures for the deployment in this directory, written against the live one at log.agent-custody.dev. Every command runs on the log's host in `deploy/` unless it says otherwise. Nothing here prints a token; tokens live in `.env` and in `/root/agent-custody-tenants/<tenant>.token`, and are handed over once by a channel you trust.

What the pieces hold, so the blast radius of each procedure is clear:

| piece | holds | if lost | if leaked |
| --- | --- | --- | --- |
| `signer` (volume `/data/keys/log.key`) | the private key that signs every tree head and checkpoint | new heads are signed by a new key; old heads keep verifying if the old public key stays published | an attacker can sign a false head; rotate, publish the old key as retired, tell tenants the date |
| `postgres` | leaf hashes per tenant, tenants, token **hashes**, checkpoints | restore from backup; leaves appended since the backup are gone and their receipts no longer verify inclusion | hashes only; nothing to replay, no receipt content |
| `.env` | `ADMIN_TOKEN`, `SIGNER_TOKEN`, `POSTGRES_PASSWORD`, `AGENT_CUSTODY_LOG_TOKEN` | regenerate | rotate the leaked one, below |
| `/checkpoints` volume | signed checkpoints the second host serves | regenerated from Postgres on the next publish | public data |
| a tenant's token (their side) | the right to append to their log | mint another | revoke, mint another; appends made with it in between are in their log and visible in usage |

## Routine

**Upgrade.** Bump `AGENT_CUSTODY_VERSION` in `.env`, then:

```bash
docker compose --profile public pull && docker compose --profile public up -d
docker compose --profile public ps
```

Both `log` and `signer` restart on the new image; Postgres and Caddy do not. Roll back by setting the previous version and running the same two commands. Then confirm from outside: `agent-custody log-check --log-url https://log.example.com/ --checkpoints-url https://checkpoints.example.com/ --tenant default`.

**Backups.** `/etc/cron.daily/agent-custody-log-backup` runs nightly:

```bash
cd /opt/agent-custody/deploy
docker run --rm -v agent-custody_logdata:/data:ro -v /var/backups/agent-custody:/backup alpine tar czf "/backup/log-$(date +%F).tgz" -C / data
docker compose exec -T postgres pg_dump -U custody custody_log | gzip > "/var/backups/agent-custody/db-$(date +%F).sql.gz"
find /var/backups/agent-custody -name 'log-*.tgz' -mtime +30 -delete
find /var/backups/agent-custody -name 'db-*.sql.gz' -mtime +30 -delete
```

The tarball is the key; the dump is everything else. Both land on the same disk as the data, so `backup-offsite.sh` copies the directory off the machine with rclone every night, an hour after the dump; `BACKUP_REMOTE` in `.env` names the destination (`hetzner:agent-custody-backups`, `s3:bucket/prefix`, or an sftp storage box) and the script refuses to run without it, so a missing destination is loud. Install: `cp backup-offsite.sh /etc/cron.daily/agent-custody-backup-offsite` after `rclone config` on the host. Check the directory has yesterday's two files whenever you log in, and that the remote listing matches.

**Restore drill, quarterly.** `./restore-drill.sh [YYYY-MM-DD]` on the log's host restores that night's dump and key tarball into a second compose project on its own volumes, with no ports and no Caddy, starts postgres, signer, and log there, checks the restored log's head against its own key document, requires the restored key id to equal the live log's, prints the leaf and tenant counts, and tears the project down. It touches nothing in the live project. Exit 0 is a pass; record the date and result below. To rebuild on a fresh VM for real, the same steps by hand: clone, `.env` with the same secrets, `up -d postgres`, pipe the dump into `psql`, untar the key into the `logdata` volume, `up -d`.

Drills: 2026-09-09, backups of 2026-09-08, PASS (first drill).

**Disk and certificates.** Caddy renews certificates itself; `docker compose logs caddy | grep -i error` if a host stops answering on 443. Postgres grows by roughly a hundred bytes per leaf; `df -h /` is the check, and the nightly dumps are the first thing to prune if it fills.

## Tenants and tokens

**Onboard.** `./onboard-tenant.sh <id> --log-id <id> --label "<team>"` creates the tenant and its first token, keeps the token in `/root/agent-custody-tenants/<id>.token`, and prints the welcome sheet to hand over. Or the admin page at `/admin`.

**Rotate a tenant's token.** Mint the new one first, hand it over, let them switch, then revoke the old:

```bash
docker compose exec log agent-custody log-admin --db-env DATABASE_URL token add <id> --label "<team> 2026-10"
docker compose exec log agent-custody log-admin --db-env DATABASE_URL token revoke <id> <old hash prefix>
```

Every one of these commands is recorded in the audit trail with your user and host. Hash prefixes are on the admin page and in `log-admin token list <id>` (the first eight characters of the stored hash; the plaintext is not recoverable). A revoked token gets 401 on its next append; the gateway behind it withholds pre-committed calls and errors on the rest, which is the tenant's signal that the switch missed a machine.

**Export, theirs to run.** A tenant takes their own log with `agent-custody log-export --log-url https://log.example.com/ --tenant <id> --token-env AGENT_CUSTODY_LOG_TOKEN --out <dir>`: every leaf hash as a log file the verifier reads, the signed head, the keys, the checkpoints, their usage, self-checked. Put it in the welcome sheet and in the offboarding email; a tenant who runs it monthly never depends on this machine for their evidence.

**Offboard.** `tenant disable <id>` refuses new appends and keeps the log readable, so receipts the tenant already holds keep verifying inclusion and their auditors can still fetch consistency proofs; this is the default and the honest one. The leaves themselves are hashes and stay: removing them would change every later root in that tenant's tree and break their own evidence. If a contract requires the tenant's log gone entirely, `DELETE FROM log_leaves WHERE tenant_id = '<id>'` and the rows in `log_heads`, `log_tokens`, and `log_tenants` for it, after telling them in writing that their receipts will no longer prove inclusion; take a dump first.

## Keys and secrets

**Rotating the signing key.** Heads signed by the old key must keep verifying, so the old public key stays published as retired. The entrypoint lists every `.pub` in `/data/keys/retired/` in the key document.

```bash
docker compose exec signer sh -c 'mkdir -p /data/keys/retired && cp /data/keys/log.pub /data/keys/retired/$(date +%F).pub && mv /data/keys/log.key /data/keys/retired/$(date +%F).key.retired && agent-custody keygen --dir /data/keys --name log'
docker compose --profile public restart signer log
curl -s https://log.example.com/.well-known/agent-custody-log.json      # the new keyid first, the old one after it
```

Then tell tenants the new key id and the date; verifiers that pin by `--log-url` pick it up on their next fetch, and verifiers holding a `--log-key` file need the new one. Keep the retired private key offline or destroy it; nothing needs it again. Rotate on a schedule you state in your terms (yearly is reasonable), and immediately on any suspicion of the host.

**A leaked admin token.** Set a new `ADMIN_TOKEN` in `.env`, `docker compose --profile public up -d log`. Then read the Activity list on the admin page, or `log-admin audit`: every tenant and token change carries who made it and from which address, so anything you did not do stands out; revoke it and disable the tenant. Appends made through a token the attacker minted are hashes in that tenant's log, worthless to them and harmless to others.

**A leaked signer token.** Same with `SIGNER_TOKEN`, restarting both `signer` and `log`. The signer is reachable only inside the compose network, so a leaked token alone signs nothing from outside; treat it as a sign the host may be compromised and rotate the key as well.

**A compromised host.** Assume the private key was read. Rotate the key as above with the old one retired, rotate every secret in `.env`, revoke every tenant token and mint new ones, rebuild the VM from a clean image, and restore Postgres from the last backup you trust. Tell tenants the window between the last checkpoint the witness countersigned and the rotation; heads signed inside it are the ones a verifier should treat as unwitnessed. This is the case the witness exists for: with one running, `audit --witness-url` proves any head from the window that the attacker did not manage to get countersigned.

## Incidents a monitor failure means

The `monitor` workflow, or your own cron running `log-check`, fails for one of these:

| check that failed | likely cause | do |
| --- | --- | --- |
| key document served | log down, Caddy down, certificate | `docker compose --profile public ps`, `logs log`, `logs caddy` |
| head verifies against the published keys | the signer restarted with a key not in the document | check `/data/keys`; a rotation done without copying the `.pub` into `retired/` looks like this |
| latest checkpoint verifies | the checkpoints volume was edited or served stale | `docker compose restart log` republishes; compare with Postgres `log_heads` |
| checkpoint keeps up with the head | the publisher stopped, or `--max-lag` is shorter than `AGENT_CUSTODY_CHECKPOINT_EVERY` | `logs log \| grep checkpoint` |
| head extends the checkpoint | **the log's history changed.** | stop the log, keep every file, page whoever is on call, and do not restart until the cause is known; a consistency failure is the one alarm that must never be cleared by a restart |
| witness countersigned / no alarm | the witness's view of the log disagrees with the log's | read the witness's `ALARM.json`; it names the two heads |

Write down, for each incident: when it was noticed, what failed, what was done, and when it cleared. Tenants whose logs were affected get that record.

## Contacts and cadence

- Security reports: see [SECURITY.md](../SECURITY.md).
- Weekly: `df -h`, yesterday's backup files present, the monitor badge green, Dependabot pull requests reviewed.
- Quarterly: restore drill; review the tenant list and revoke tokens with no appends in the quarter.
- Yearly: key rotation.
