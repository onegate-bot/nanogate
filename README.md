# nanogate

**NanoClaw, wired to OneGate.**

nanogate is a fork of [nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw) — the
container-isolated personal AI assistant — that routes every agent's outbound API traffic
through a self-hosted [OneGate](https://github.com/onegate-bot/onegate) credential gateway,
and adds the operational tooling needed to run a fleet of these bots.

Agents never hold a real credential. The host injects a placeholder, OneGate rewrites the
real `Authorization` header at the network edge, and the only way to switch gateways is a
file on disk — no LLM in the loop, no rebuild.

- Upstream project, docs and community: [nanoclaw.dev](https://nanoclaw.dev) · [docs.nanoclaw.dev](https://docs.nanoclaw.dev)
- The gateway: [onegate-bot/onegate](https://github.com/onegate-bot/onegate) (Apache-2.0)

Everything not described below — architecture, channels, scheduled tasks, templates,
isolation model, `/customize`, `/debug` — is unchanged from upstream. Read the
[upstream README](https://github.com/nanocoai/nanoclaw#readme) for that.

## What nanogate adds

**OneGate gateway provider, on by default.** `src/gateway-providers/onegate.ts` registers a
`GatewayProvider` of kind `onegate` and makes it the install default
(`NANOCLAW_GATEWAY_PROVIDER` still overrides). At every container spawn it reads
`~/.nanoclaw-onegate/mode` and picks one of three egress paths:

| Mode | What the container gets | When to use it |
|------|-------------------------|----------------|
| `onegate` | `HTTPS_PROXY` pointing at a local forward to your OneGate, the OneGate root CA mounted at `/etc/onegate/rootCA.pem` and trusted via `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE`, and a format-valid **placeholder** OAuth token so the Claude Code SDK passes its local login check. | Normal operation. |
| `onecli` | Exactly upstream's behaviour — the `onegate` provider delegates to upstream's own `onecli` provider, so upstream changes to OneCLI land untouched. | Safe fallback. Also the result of a missing or unreadable mode file. |
| `direct` | No proxy. A credential resolved from host env, `~/.claude/.credentials.json`, or `~/.nanoclaw-onegate/direct.env` is injected straight into the container. | Last resort when both gateways are down. |

Mode-read, env and CA-mount logic lives in the fork-only `src/onegate-proxy.ts`. A missing
agent token or CA in `onegate` mode refuses to spawn rather than spawning without credentials.

**Deterministic switch kit** in [`onegate-switch/`](onegate-switch/): `nanoclaw-proxy.sh
{onegate|onecli|direct|status}` rewrites the mode file, loads or unloads a persistent SSH
tunnel (launchd plist included) to the OneGate host, and restarts the NanoClaw service.
Pure bash, so it works when the agent itself is down. One-time setup is in
[`onegate-switch/SETUP.md`](onegate-switch/SETUP.md).

**Telegram in-tree.** Upstream keeps channel adapters on a registry branch and installs them
per fork with `/add-telegram`; this trunk ships `src/channels/telegram.ts` already wired, so
a fresh checkout can pair a Telegram bot without a skill run. The files are kept
byte-identical to the `channels` branch so the skill stays a no-op.

**`ncc` — NanoClaw Control.** A stdlib-only Python CLI (`scripts/ncc`, installable via the
`/ncc` skill) for the operational surface `ncl` does not cover: service
start/stop/restart on launchd or systemd, a `health` scan of the service, Docker, central
DB, disk, each agent container and overdue tasks (exit 2 on hard failure, monitoring-safe),
and `tasks` / `crons` visibility. It reads the SQLite databases directly, so it keeps
working while the host is down. Optional `--llm` makes one real completion through the
agent's own client inside the container to prove the gateway path end to end.

**`nanoclaw_control.sh`.** Start/stop/restart/status for the launchd service plus per-group
container and task reporting, text or `--json`, driven by the driver-seam container labels.

**Best-effort reactions.** `addReaction` in the Chat SDK bridge is wrapped so a platform
that rejects an emoji does not burn delivery retries and mark the message permanently failed.

**A guarded fork contract.** `src/fork-divergences.test.ts` drives the divergences above
through the real gateway-provider registry and fails CI if an upstream merge silently drops
one of them. `CLAUDE.md` documents each divergence and how to resolve conflicts in it.

## Quick start

```bash
git clone https://github.com/onegate-bot/nanogate.git nanoclaw-v2
cd nanoclaw-v2
bash nanoclaw.sh
```

`nanoclaw.sh` is upstream's installer and behaves exactly as documented there. With no
mode file present the gateway provider falls back to `onecli`, so a fresh install runs as a
stock NanoClaw. To move it onto OneGate, follow [`onegate-switch/SETUP.md`](onegate-switch/SETUP.md)
once, then:

```bash
nanoclaw-proxy.sh onegate   # route through OneGate
nanoclaw-proxy.sh status
nanoclaw-proxy.sh onecli    # back to the safe default
```

## Versioning and releases

nanogate has its own version, independent of the `package.json` version (which keeps
tracking upstream and is never edited for fork releases).

- The version is the single line in [`NANOGATE_VERSION`](NANOGATE_VERSION), `MAJOR.MINOR.PATCH`.
- Every merge to `main` bumps it: patch for fixes and docs, minor for features or a routine
  upstream sync, major for breaking changes to how the fork is operated. The
  `nanogate version` workflow fails any PR to `main` that does not raise it.
- On push to `main` the same workflow creates the tag `nanogate-vX.Y.Z` and a GitHub
  Release. Tags are prefixed because the repo also carries upstream's `vX.Y.Z` tags.
- `nanogate-v1.0.0` is `main` before the 2026-09-10 upstream sync; that sync is
  `nanogate-v2.0.1`.

Releases: [github.com/onegate-bot/nanogate/releases](https://github.com/onegate-bot/nanogate/releases)

## Staying in sync with upstream

Upstream is merged in on a `merge/upstream-<date>` branch, resolved against the fork
contract in `CLAUDE.md`, checked by `src/fork-divergences.test.ts` and the full upstream CI,
then merged to `main` with a merge commit so upstream history is preserved. Upstream's
`CHANGELOG.md` is the source for operator migration steps; the PR body of each sync lists the
ones that apply.

The `providers` and `channels` registry branches are mirrored from upstream so the
`/add-<channel>` and `/add-<provider>` skills work the same way here.

## Requirements

Upstream's, plus Python 3.8+ for `ncc` and an SSH-reachable OneGate instance for
`onegate` mode. See the [upstream README](https://github.com/nanocoai/nanoclaw#requirements).

## License

MIT, same as upstream. NanoClaw is © its contributors; see
[nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw) for the original project.
