# Deploying the log

This directory runs the log server as a container: on one VM with docker compose, or on Kubernetes with the manifests in `k8s/`. Both use the same image and the same environment variables, so a deployment moves between them by changing where it runs, not what it is.

What it deploys today is the **reference log server** from `@agent-custody/receipts`: single tenant, file-backed, one signing key, bearer-token appends, the four endpoints the gateway and the verifier use. That is enough to run a log on a machine the agent's operator does not control, which is the property everything else is built on. The tenanted service with hash-only leaves, Postgres, published checkpoints, and a well-known key document is [issue #6](https://github.com/ch4r10t33r/agent-custody/issues/6); as its phases land, this directory picks them up without changing the contract below.

One caution until phase 1 of #6 lands: the reference server stores whole leaves, which are receipt envelopes, so it holds the receipts' arguments and results. Running it on a second machine you control is fine. Running it for other people's receipts should wait for hash-only appends.

## The contract

| variable | meaning | default |
| --- | --- | --- |
| `AGENT_CUSTODY_LOG_FILE` | the Merkle log, one leaf per line | `/data/log.jsonl` |
| `AGENT_CUSTODY_LOG_KEY` | the signing key; generated on first start if absent, public half printed to the container log | `/data/keys/log.key` |
| `AGENT_CUSTODY_LOG_PORT` | listen port inside the container | `8787` |
| `AGENT_CUSTODY_LOG_TOKEN` | bearer token required on append; without it the log accepts appends from anyone who can reach it | unset |

The volume at `/data` is the whole state: the log and the key. Back it up; a lost key means every tree head it signed is still verifiable, but new heads will be signed by a different key, which verifiers must be told about.

## One VM, docker compose

Any Linux VM with Docker works. A Hetzner CX22 (2 vCPU, 4 GB, about 4 EUR a month) is more than the first tenants need; the log does a hash and a signature per append.

```bash
# on the VM
git clone https://github.com/ch4r10t33r/agent-custody.git && cd agent-custody/deploy
cp .env.example .env
sed -i "s/^AGENT_CUSTODY_LOG_TOKEN=.*/AGENT_CUSTODY_LOG_TOKEN=$(openssl rand -hex 32)/" .env
sed -i "s/^LOG_HOST=.*/LOG_HOST=log.example.com/" .env        # a DNS A record for this host must point at the VM
docker compose --profile public up -d
docker compose logs log | grep -A3 "public key"                # hand this to verifiers as --log-key
```

Caddy obtains the certificate and forwards to the log. Without `--profile public` the log listens on the VM's loopback only, for a VPN or your own reverse proxy.

The operator's side is one config line, with the token in their environment:

```json
"log": { "url": "https://log.example.com/", "tokenEnv": "AGENT_CUSTODY_LOG_TOKEN" }
```

Verifiers add `--log-key log.pub` and, to prove history was not rewritten between two receipts, `agent-custody audit` against `GET /consistency`.

**Backups.** The volume is small; a nightly `docker run --rm -v agent-custody_logdata:/data -v /backup:/backup alpine tar czf /backup/log-$(date +%F).tgz /data` in cron, plus the provider's volume snapshots, is enough. Keep at least one signed tree head somewhere the VM cannot touch; that is what an auditor compares against.

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
| 1 | hash-only appends, tenant-scoped paths, `log` id in tree heads | nothing; the image picks up the new version |
| 2 | Postgres store, tokens table, rate limits | the `phase2` profile becomes the default; `DATABASE_URL` in the contract |
| 3 | signer process, well-known keys, checkpoint publisher | two more services: `signer`, `publisher`; a bucket for checkpoints |
| 4 | | this is the deployment |
| 6 | witness | a second, separately operated deployment of the signer |
