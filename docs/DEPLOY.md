# Production

One small server runs Postgres, the API and Caddy (the web app, HTTPS). GPUs are rented from Runpod
by the API while app sessions ask for them (ARCHITECTURE.md, "Sessions and on-demand GPUs"). The
files are in `deploy/production/`.

| Piece | Choice | Cost (2026-11) |
|---|---|---|
| Server | Hetzner Cloud CX23 (2 vCPU, 4 GB, 40 GB), Nuremberg or Helsinki, Ubuntu 24.04 | ~€6/month, +20% for backups |
| Domain and DNS | Cloudflare Registrar; an `A` record for `SITE_DOMAIN`, DNS only | ~$10.5/year for a .com |
| HTTPS | Caddy, Let's Encrypt | free |
| GPUs | Runpod, EU-RO-1, A5000 / A4000 / 4090 | `CAPACITY_MONTHLY_BUDGET_USD` (beta: 15 USD) |
| Model cache | a Runpod network volume in EU-RO-1, 20 GB (optional) | ~$1.4/month |
| Email (sign-in codes) | Brevo, free plan: 300 emails a day | free |

## How it fits

**On the server (`/opt/neuracraft`):**
- `docker-compose.yml`, `Caddyfile`, `settings.env` and `deploy.sh`, copied there on every deploy;
- `internal.env`: the database password, the signing key and the worker token. cloud-init makes it
  once; it never leaves the server;
- `secrets.env`: the Runpod and Anthropic keys and the operator token, written from GitHub secrets on
  every deploy;
- `models/` (the catalog's files) and `backups/` (a `pg_dump` every night, one per weekday).

**From GitHub:**
- On every push to main, once CI passes, the `publish` job pushes three images to GHCR, tagged with the
  commit: `neuracraft-cloud-api`, `neuracraft-cloud-web` and `neuracraft-worker-gpu`.
- The `deploy` job then copies the files to the server and runs `deploy.sh` with that tag. It is
  skipped while the `DEPLOY_HOST` secret is unset.
- `deploy.sh`:
  - joins the env files into `.env`;
  - pulls the images and starts them;
  - waits for the API to answer;
  - the first time, downloads and adds the sketch_to_scene catalog models.

The Runpod pods run the GPU worker image of the same commit (`RUNPOD_IMAGE` is set to the tag).

## Settings and secrets

`deploy/production/settings.env` (committed):
- `SITE_DOMAIN`;
- the beta limits: one GPU, 5 USD a day, 15 USD a month, 5 minutes of grace, sessions idle after 20
  minutes;
- the Runpod GPU types and data centre, and the network volume id.

GitHub → Settings → Secrets and variables → Actions:

| Secret | What |
|---|---|
| `DEPLOY_HOST` | the server's IP address |
| `DEPLOY_SSH_KEY` | the private key whose public half was chosen when creating the server |
| `DEPLOY_KNOWN_HOSTS` | optional: `ssh-keyscan <ip>` output, so the deploy trusts only that host key |
| `RUNPOD_API_KEY` | a Runpod API key |
| `ANTHROPIC_API_KEY` | optional: narratives → prompts with Claude (a template otherwise) |
| `ADMIN_TOKEN` | optional, ≥ 16 characters: `GET /v1/admin/usage-report` (docs/USAGE_LOG.md) |
| `BREVO_API_KEY` | a Brevo API key, for partner apps' sign-in codes (below); without it, sign-in answers `auth.sign_in_unavailable` |

## First setup

1. Make a deploy key on your own computer: `ssh-keygen -t ed25519 -f ~/.ssh/neuracraft_deploy -N ""`.
2. Hetzner:
   - create a CX23 with Ubuntu 24.04 and the key `~/.ssh/neuracraft_deploy.pub`;
   - paste `deploy/production/cloud-init.yaml` into "Cloud config";
   - turn on backups.
3. Cloudflare: an `A` record from `SITE_DOMAIN` to the server's IPv4 address, proxy off (DNS only).
4. In the repository:
   - set `SITE_DOMAIN` in `settings.env`;
   - add the secrets above;
   - push to main, or re-run the last main workflow.
5. Make the GM Cebi partner account:
   - sign up on `https://<SITE_DOMAIN>` with its email;
   - then, on the server:
     ```
     ssh -i ~/.ssh/neuracraft_deploy deploy@<ip>
     cd /opt/neuracraft
     docker compose exec api node apps/api/dist/src/cli/partner.js --email <account> --daily-jobs 20 --partner-daily-jobs 300
     docker compose exec api node apps/api/dist/src/cli/grant-credits.js --email <account> --credits 5000 --reason beta
     docker compose exec api node apps/api/dist/src/cli/partner-client.js --email <account> --name "GM Cebi"
     ```
   - The last command prints the client id (`nc_client_...`). It is public: it goes into the GM Cebi
     build, and end users sign in with an emailed code (docs/partners/gm-cebi.md).
   - Builds from before sign-in used an app token (`create-token.js --kind app`, sent with
     `X-End-User`). Once the sign-in build ships: `partner.js --email <account> --require-end-user-tokens on`,
     then revoke that token.
6. Brevo, for the sign-in codes:
   - sign up at brevo.com (free plan);
   - Senders, Domains & Dedicated IPs → Domains → add `neuracraft.app`, and add the DNS records it
     shows (a Brevo code, DKIM, DMARC) in Cloudflare, proxy off;
   - once the domain is verified, add the sender `no-reply@neuracraft.app` (`MAIL_FROM` in
     `settings.env`);
   - SMTP & API → API keys → create a key, and save it as the `BREVO_API_KEY` secret.
   - after the next deploy, check it:
     `docker compose exec api node apps/api/dist/src/cli/mail-test.js --to <your address>`.
     A failure prints Brevo's answer (an unverified sender, an IP not in Brevo's authorized IPs, a
     wrong key).

## The operator console

The web app's **Operator** tab (`https://<SITE_DOMAIN>/#admin`), for operators only:
- **Overview**: GPUs now, spend against the daily and monthly limits, open sessions, jobs in the last
  24 hours per account, capacity events;
- **Accounts**: each account's credits, partner settings, sign-in clients, tokens, signed-in end users
  (block or unblock one), jobs per day;
- **Jobs**: every account's jobs, filtered by account, end user, state and region layer. Pictures and
  texts appear only for accounts with support access (docs/PRIVACY.md);
- **Reports**: the review queue with the evidence (the CLI `review.js` does the same);
- **Log & usage**: the operator log, and the usage export as CSV.

To become an operator, sign up on the web app, then on the server:
```
docker compose exec api node apps/api/dist/src/cli/operator.js --email <your account> --on
```
An account lets operators see its content from its own API page ("Support access"), or, when it
agreed elsewhere (a partner's closed beta):
```
docker compose exec api node apps/api/dist/src/cli/support-access.js --email <account> --days 30 --note "closed beta, testers agreed"
```

## Day to day

- **Deploying again without a new commit:** GitHub → Actions → CI → Run workflow (branch main).
- **Logs:** `docker compose logs -f api`, or in a browser with Dozzle (read-only, every container):
  ```
  ssh -N -L 8081:127.0.0.1:8081 -i ~/.ssh/neuracraft_deploy deploy@<ip>
  ```
  then open `http://localhost:8081`. It listens on the server's loopback only, so the tunnel is the
  way in.
- **Capacity:** `docker compose exec db psql -U nc neuracraft -c "SELECT at, kind, detail FROM capacity_events ORDER BY at DESC LIMIT 20"`.
- **Usage export:** docs/USAGE_LOG.md.
- **Testers' results** (closed beta only, docs/PRIVACY.md): the last 10 maps with their sketch,
  colour hint, result and texts, as one archive:
  ```
  docker compose exec -T api node apps/api/dist/src/cli/job-export.js --last 10 > jobs.tar.gz
  ```
  Then, on your computer: `scp -i ~/.ssh/neuracraft_deploy deploy@<ip>:/opt/neuracraft/jobs.tar.gz .`
  Other filters: `--since 2026-11-12`, `--job <id>` (repeatable), `--end-user <id>`.
- **Restoring the database:**
  ```
  gunzip -c backups/db-Mon.sql.gz | docker compose exec -T db psql -U nc neuracraft
  ```
  into an empty database.
