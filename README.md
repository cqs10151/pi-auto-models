# pi-auto-models

A [pi](https://pi.dev) extension that automatically switches between a **primary** and a **fallback** model based on quota. When your primary provider (Claude by default) is rate-limited, it transparently falls back (Codex by default) and switches back once quota recovers.

## Features

- **Auto-switch on quota** — on each session start it uses the primary model if quota is available, otherwise the fallback.
- **429/529 recovery** — detects rate-limit responses, caches the cooldown, and switches to the fallback mid-session.
- **Passive quota tracking** — reads rate-limit headers from provider responses (no extra requests for Claude); Codex quota is fetched live.
- **`/usage`** — shows 5h (and weekly) quota usage for both providers.
- **`/auto-model`** — interactive TUI to configure the primary/fallback model and thinking level.

## Install

```bash
pi install git:github.com/Fatpandac/pi-auto-models
```

Try it for one run without installing:

```bash
pi -e git:github.com/Fatpandac/pi-auto-models
```

## Commands

| Command | Description |
|---------|-------------|
| `/usage` | Show Claude / Codex 5h quota usage |
| `/auto-model` | Configure primary and fallback models (model + thinking level) |

## Configuration

`/auto-model` writes your choices to `~/.pi/agent/auto-model.json`:

```json
{
  "primary":  { "provider": "anthropic",   "model": "claude-opus-4-6", "thinking": "high" },
  "fallback": { "provider": "openai-codex", "model": "gpt-5.5",        "thinking": "high" }
}
```

Defaults (used when the file is absent):

| Slot | Provider | Model | Thinking |
|------|----------|-------|----------|
| Primary | `anthropic` | `claude-opus-4-6` | `high` |
| Fallback | `openai-codex` | `gpt-5.5` | `high` |

Thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.

## How it works

State is persisted under `~/.pi/agent/`:

- `auto-model.json` — your primary/fallback configuration
- `claude-quota-cache.json` — per-provider rate-limit cooldown expiry
- `auto-model-rate-limits.json` — last captured rate-limit snapshot per provider

Auth is read from pi's existing `auth.json`; the extension does not store credentials.
