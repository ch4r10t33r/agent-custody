# Deploying the log

This directory runs the log server as a container: on one VM with docker compose, or on Kubernetes with the manifests in `k8s/`. Both use the same image and the same environment variables, so a deployment moves between them by changing where it runs, not what it is.

What it deploys today is the **reference log server** from `@agent-custody/receipts`: single tenant, file-backed, one signing key, bearer-token appends, the four endpoints the gateway and the verifier use. That is enough to run a log on a machine the agent's operator does not control, which is the property everything else is built on. The tenanted service with hash-only leaves, Postgres, published checkpoints, and a well-known key document is [issue #6](https://github.com/ch4r10t33r/agent-custody/issues/6); as its phases land, this directory picks them up without changing the contract below.

Operators who log here should set `"hashOnly": true` in their `log` config, so the server commits to receipts without ever holding them; the log file then contains hashes only. Without it, the server stores whole receipt envelopes, arguments and results included, which is fine for your own second machine and not for other people's receipts.

## The image

`ghcr.io/ch4r10t33r/agent-custody-log:<version>`, built for amd64 and arm64 by the `image` workflow from `deploy/Dockerfile` and the published npm package of that version. The compose file builds the same image locally if the registry has no such tag yet, so nothing waits on the registry. To publish a version by hand: `gh workflow run image.yml -f version=0.3.0`; a `v0.3.0` tag does the same. The first push creates the package as private; make it public once in the package settings on GitHub so `docker pull` needs no login.

## The contract

| variable | meaning | default |
| --- | --- | --- |
| `AGENT_CUSTODY_LOG_FILE` | the Merkle log, one leaf per line | `/data/log.jsonl` |
| `AGENT_CUSTODY_LOG_KEY` | the signing key; generated on first start if absent, public half printed to the container log | `/data/keys/log.key` |
| `AGENT_CUSTODY_LOG_PORT` | listen port inside the container | `8787` |
| `AGENT_CUSTODY_LOG_TOKEN` | bearer token required on append; without it the log accepts appends from anyone who can reach it | unset |
| `AGENT_CUSTODY_LOG_ID` | the id written into every tree head, checked by verifiers with `--log-id`; use the public host | unset |
| `AGENT_CUSTODY_LOG_TENANTS` | path to a tenants file inside the container, for several file logs at `/t/<tenant>/` | unset |
| `DATABASE_URL` | with it, leaves, tenants, tokens, and checkpoints live in Postgres and the file is not used; the compose file sets it | unset |
| `ROLE` | `signer` runs the signer instead of the log | `log` |
| `AGENT_CUSTODY_SIGNER_URL`, `SIGNER_TOKEN` | the log signs through this signer with this shared secret instead of holding a key; the compose file sets them | unset |
| `TRUST_PROXY` | `1` when a reverse proxy you run is the only way in, so per-address limits key on `X-Forwarded-For`; the compose file sets it for Caddy | unset |
| `ADMIN_TOKEN` | turns on the operator's page at `/admin` and its API, behind this token; `LOG_HOST` and `CHECKPOINTS_HOST` fill the welcome sheet | unset |
| `AGENT_CUSTODY_CHECKPOINT_DIR`, `AGENT_CUSTODY_CHECKPOINT_EVERY` | where and how often signed checkpoints are written; the compose file serves the directory from `CHECKPOINTS_HOST` | unset, 300 |

The volume at `/data` is the whole state: the log and the key. Back it up; a lost key means every tree head it signed is still verifiable, but new heads will be signed by a different key, which verifiers must be told about.

## One VM, docker compose

Any Linux VM with Docker works. A Hetzner CX22 (2 vCPU, 4 GB, about 4 EUR a month) is more than the first tenants need; the log does a hash and a signature per append.

```bash
# on the VM
git clone https://github.com/ch4r10t33r/agent-custody.git && cd agent-custody/deploy
cp .env.example .env
sed -i "s/^AGENT_CUSTODY_LOG_TOKEN=.*/AGENT_CUSTODY_LOG_TOKEN=$(openssl rand -hex 32)/" .env
sed -i "s/^SIGNER_TOKEN=.*/SIGNER_TOKEN=$(openssl rand -hex 32)/; s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env
sed -i "s/^LOG_HOST=.*/LOG_HOST=log.example.com/; s/^CHECKPOINTS_HOST=.*/CHECKPOINTS_HOST=checkpoints.example.com/" .env   # A records for both hosts must point at the VM
docker compose --profile public up -d
docker compose logs log | grep -A3 "public key"                # hand this to verifiers as --log-key
```

Caddy obtains the certificate and forwards to the log. Without `--profile public` the log listens on the VM's loopback only, for a VPN or your own reverse proxy.

The operator's side is one config line, with the token in their environment:

```json
"log": { "url": "https://log.example.com/", "tokenEnv": "AGENT_CUSTODY_LOG_TOKEN", "hashOnly": true }
```

Verifiers add `--log-url https://log.example.com/ --log-id log.example.com`, which fetches and pins the published keys, and, to prove history was not rewritten between two receipts, `agent-custody audit` against `GET /consistency`.

**Tenants.** `docker compose exec log agent-custody log-admin --db-env DATABASE_URL tenant add acme --log-id acme-eu`, then `token add acme --label support-fleet`; the token prints once. The tenant appends at `https://log.example.com/t/acme/` and verifies with `--log-id acme-eu`. A file log from before Postgres comes in with `log-admin --db-env DATABASE_URL import --file /data/log.jsonl`, which adds its hashes to the default tenant and is safe to run twice.

**Onboarding a tenant.** Open `https://log.example.com/admin`; the browser asks for a user name (anything) and a password, which is `ADMIN_TOKEN` from `.env`. Create the tenant, mint a token: the token is shown once beside the welcome sheet, ready to copy. Nothing under `/admin` answers without the token, wrong attempts are throttled, and tenants never see the page. The same from the server: `./onboard-tenant.sh acme --log-id acme-eu --label "support fleet"` creates the tenant and its first token, keeps the token in `/root/agent-custody-tenants/acme.token`, and prints the welcome sheet: their URL, log id, checkpoints URL, the one config line, and the two verifier commands. Hand the token over once by a channel you trust; the server keeps only its hash. Revoke with `log-admin token revoke acme <hash-prefix>`, disable with `log-admin tenant disable acme`.

**Backups.** The volume is small; a nightly `docker run --rm -v agent-custody_logdata:/data -v /backup:/backup alpine tar czf /backup/log-$(date +%F).tgz /data` in cron for the key, and `docker compose exec postgres pg_dump -U custody custody_log | gzip > /backup/db-$(date +%F).sql.gz` for the leaves, tenants, and tokens, plus the provider's volume snapshots, is enough. Keep at least one signed tree head somewhere the VM cannot touch; that is what an auditor compares against.

**Upgrades.** Bump `AGENT_CUSTODY_VERSION` in `.env`, then `docker compose build --pull && docker compose --profile public up -d`. The log format and the endpoints are stable within a major version.

## Kubernetes

```bash
kubectl create namespace agent-custody
kubectl -n agent-custody create secret generic agent-custody-log --from-literal=AGENT_CUSTODY_LOG_TOKEN="$(openssl rand -hex 32)"
# edit k8s/ingress.yaml: your host and cluster issuer
kubectl apply -k k8s
kubectl -n agent-custody logs deploy/agent-custody-log | grep -A3 "public key"
```

One replica, `Recreate` strategy, a `ReadWriteOnce` volume: the file log has one writer, and this keeps it that way. When the Postgres-backed store lands (#6, phase 2), the deployment gains a `DATABASE_URL` and the volume holds only the key.

## The witness, on someone else's machine

`deploy/witness/` is a separate compose stack: the same image with `ROLE=witness`, and a Caddy serving what it signs. It belongs on a machine and under an account that the log's operator does not control; run on the log's own machine it proves nothing. It needs the log's API URL, the checkpoints URL, and the tenants to watch, generates its own key on first start, and publishes that key at `/.well-known/agent-custody-witness.json` on its host. Every five minutes it fetches each watched log's latest checkpoint, proves it extends the last head it signed with the log's own consistency proof, and countersigns it; a checkpoint that does not extend, or a second history at the same size, gets an `ALARM.json` on the host instead of a signature. Verifiers add `--witness-url https://witness.example.org/` to `audit` and the newer head must then carry the witness's signature. `audit --older` and `--newer` accept checkpoint files from either host as well as receipt bundles.

## Hetzner now, AWS later

Yes, and it is the right order. Nothing here depends on a cloud provider: a container, a volume, a hostname, and a certificate. A Hetzner VM runs the compose file as written; Hetzner's S3-compatible Object Storage is where the checkpoint publisher (#6, phase 3) writes signed heads. Moving to AWS later, when a tenant's procurement asks for it or an integration needs it, is:

1. Run the same image on ECS or EKS (the `k8s/` manifests apply to EKS unchanged apart from the ingress class and the storage class).
2. Copy the volume: the log file and the key. `tar` out, `tar` in, start. The key moves with it, so verifiers notice nothing; if you prefer a fresh key in AWS's secret store, add it and keep the old public key published.
3. For the phase-2 store, `pg_dump` from Hetzner to RDS.
4. Point the DNS record at the new address. The gateway's config does not change.

Migration is a volume copy and a DNS change because the design keeps the state in one place and the trust in the key.

## Phases of issue #6 and what changes here

| phase | what lands in the packages | what changes in this directory |
| --- | --- | --- |
| 1 | hash-only appends, tenant-scoped paths, `log` id in tree heads | done: `AGENT_CUSTODY_LOG_ID` and `AGENT_CUSTODY_LOG_TENANTS` in the contract |
| 2 | Postgres store, tokens table, rate limits | done: Postgres is in the default profile; `DATABASE_URL` in the contract; `--profile file` keeps the old single-file server |
| 3 | signer process, well-known keys, checkpoint publisher | done: the `signer` service holds the key; the log publishes checkpoints to a volume Caddy serves at `CHECKPOINTS_HOST`; verifiers use `--log-url` |
| 4 | | this is the deployment, running at log.agent-custody.dev |
| 5 | | `onboard-tenant.sh` creates a tenant and prints the welcome sheet |
| 6 | witness | done: `deploy/witness/` is its own compose stack for a machine the operator does not control; `ROLE=witness` in the same image |
