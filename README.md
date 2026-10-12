# Homelert

Self-hosted homelab notification center. Receives webhooks, polls infrastructure APIs, evaluates rules, and sends Telegram alerts.

## Features

- **Webhook ingestion** — POST `/webhook/:source` for GitHub Actions, Docker, Kubernetes, Uptime checks, and generic sources
- **Polling agents** — Proxmox (CPU/RAM/disk), Docker (container state), Kubernetes (pod events), Uptime (HTTP ping)
- **Rules engine** — YAML-configured rules with condition evaluation and deduplication windows
- **Silence windows** — Suppress alerts during maintenance hours
- **Telegram notifications** — Formatted alerts with severity emoji (❌ ⚠️ ℹ️)
- **Web dashboard** — Dark-theme UI with alert history, rules list, agent status, silence controls

## Quick Start

### 1. Clone and configure

```bash
cp .env.example .env
# Edit .env with your Telegram bot token, Proxmox API token, etc.
```

### 2. Edit rules

```bash
# Edit rules.yaml to match your infrastructure
nano rules.yaml
```

### 3. Run with Docker Compose

```bash
docker compose up -d
```

Dashboard available at: `http://localhost:3000`

---

## Configuration

### Environment Variables (`.env`)

| Variable | Description | Required |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather | Yes |
| `TELEGRAM_CHAT_ID` | Telegram chat ID to send alerts to | Yes |
| `PROXMOX_HOST` | Proxmox API URL (e.g. `https://pve.local:8006`) | No |
| `PROXMOX_TOKEN` | Proxmox API token (`user@pam!tokenid=secret`) | No |
| `K8S_KUBECONFIG_PATH` | Path to kubeconfig inside container | No |
| `DOCKER_SOCKET_PATH` | Docker socket path (default `/var/run/docker.sock`) | No |
| `POLL_INTERVAL_SECONDS` | How often agents poll (default `60`) | No |
| `UPTIME_URLS` | Comma-separated URLs to HTTP-ping | No |
| `PORT` | HTTP port (default `3000`) | No |
| `DB_PATH` | SQLite file path (default `/data/homelert.db`) | No |
| `RULES_PATH` | Path to rules.yaml (default `/config/rules.yaml`) | No |

### Get your Telegram chat ID

1. Start a chat with your bot
2. Visit `https://api.telegram.org/bot<TOKEN>/getUpdates`
3. Find `"chat":{"id": <YOUR_CHAT_ID>}`

---

## Webhook API

Send events to Homelert from any source:

```
POST /webhook/:source
Content-Type: application/json
```

### GitHub Actions example

```yaml
- name: Notify Homelert
  if: failure()
  run: |
    curl -X POST http://homelert:3000/webhook/github \
      -H 'Content-Type: application/json' \
      -d '{"action":"failure","repository":{"full_name":"${{ github.repository }}"},"workflow_run":{"name":"${{ github.workflow }}","conclusion":"failure","head_branch":"${{ github.ref_name }}"}}'
```

### Generic webhook

```bash
curl -X POST http://localhost:3000/webhook/myapp \
  -H 'Content-Type: application/json' \
  -d '{"title":"Deploy failed","body":"v1.2.3 deployment failed on prod","severity":"critical"}'
```

---

## Rules Configuration (`rules.yaml`)

```yaml
rules:
  - name: "Rule name"
    condition: "source == 'proxmox' AND cpu > 80"
    window: "5m"        # Dedup window: 30s, 5m, 1h, etc.
    severity: "warning" # critical | warning | info

silences:
  - from: "02:00"       # HH:MM (24h)
    to: "06:00"
```

### Condition syntax

Conditions support `AND`, `OR`, and comparisons: `==`, `!=`, `>`, `<`, `>=`, `<=`

Available fields depend on source:

| Source | Fields |
|---|---|
| `proxmox` | `cpu`, `ram`, `disk`, `node` |
| `docker` | `container`, `status`, `state`, `restartCount` |
| `kubernetes` | `reason`, `name`, `namespace`, `restartCount` |
| `uptime` | `url`, `status`, `responseTime` |
| `github` | `repo`, `conclusion`, `action`, `branch` |
| all | `source`, `severity`, `title` |

---

## REST API

| Method | Path | Description |
|---|---|---|
| GET | `/api/alerts` | Alert history (`?severity=critical&source=docker&limit=50`) |
| GET | `/api/events` | Raw event history |
| GET | `/api/rules` | Loaded rules |
| GET | `/api/agents` | Agent statuses |
| GET | `/api/silences` | Active silences |
| POST | `/api/silences` | Add silence `{from_time, to_time, label}` |
| DELETE | `/api/silences/:id` | Remove silence |
| GET | `/api/stats` | Aggregate stats |
| GET | `/health` | Health check |

---

## Docker Compose — Enabling Docker Socket Polling

Uncomment in `docker-compose.yml`:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock:ro
```

## Docker Compose — Enabling Kubernetes Polling

```yaml
volumes:
  - ~/.kube/config:/config/kubeconfig:ro
environment:
  - K8S_KUBECONFIG_PATH=/config/kubeconfig
```

---

## Project Structure

```
homelert/
├── src/
│   ├── server.js           # Fastify server entry point
│   ├── db/
│   │   └── index.js        # SQLite schema + connection
│   ├── routes/
│   │   ├── webhook.js      # POST /webhook/:source
│   │   ├── api.js          # REST API routes
│   │   └── normalizer.js   # Payload normalization per source
│   ├── rules/
│   │   └── engine.js       # Rule loading, evaluation, dedup
│   ├── agents/
│   │   └── index.js        # Proxmox, Docker, K8s, Uptime polling
│   └── notifiers/
│       └── telegram.js     # Telegram Bot API sender
├── public/
│   └── index.html          # Web dashboard (vanilla JS)
├── rules.yaml              # Rule definitions
├── .env.example            # Environment variable template
├── Dockerfile
├── docker-compose.yml
└── README.md
```

---

## Deploying to k3s (ArgoCD)

Manifests live in `kubernetes/` and are synced by ArgoCD (`k8s/apps/homelert.yml` in the homelab repo).
The `homelert-secrets` Secret (Telegram / Proxmox) is created by the homelab Ansible `homelert` role.

On every push to `main`, `.github/workflows/deploy.yml`:

1. Builds the image and pushes `prateeksavanur/homelert:<sha>` (and `:latest`) to Docker Hub
2. Pins `<sha>` in `kubernetes/deployment.yaml` and commits it back
3. ArgoCD sees the change and rolls out the new version

Required repo secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`.

> `kubernetes/configmap.yaml` holds a copy of `rules.yaml` — edit both when changing rules.

---

## Development

```bash
npm install
cp .env.example .env
# Edit .env
node src/server.js
# or with watch mode:
npm run dev
```

SQLite database will be created at `./homelert.db` by default.
