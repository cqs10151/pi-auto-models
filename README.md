# pi-auto-models

A [pi](https://pi.dev) extension that automatically switches between a **primary** and a **fallback** model based on quota. When your primary provider (Claude by default) is rate-limited, it transparently falls back (Codex by default) and switches back once quota recovers.

## Features

- **Auto-switch on quota** — on each session start it uses the primary model if quota is available, otherwise the fallback.
- **429/529 recovery** — detects rate-limit responses, caches the cooldown, and switches to the fallback mid-session.
- **Passive quota tracking** — reads rate-limit headers from provider responses to detect limits before they block you.
- **`/auto-model`** — interactive TUI to configure the primary/fallback model and thinking level.

## Install

```bash
pi install npm:pi-auto-models
```

Or install from git:

```bash
pi install git:github.com/Fatpandac/pi-auto-models
```

Try it for one run without installing:

```bash
pi -e npm:pi-auto-models
```

## Commands

| Command | Description |
|---------|-------------|
| `/auto-model` | Configure primary and fallback models (model + thinking level) |

## Configuration

`/auto-model` writes your choices to `~/.pi/agent/auto-model.json`:

```json
{
  "models": [
    { "provider": "anthropic",   "model": "claude-opus-4-6",               "thinking": "high" },
    { "provider": "openai-codex", "model": "gpt-5.5",                     "thinking": "high" },
    { "provider": "openrouter",   "model": "google/gemma-4-31b-it:free",  "thinking": "off" },
    { "provider": "openrouter",   "model": "openai/gpt-oss-20b:free",      "thinking": "off" }
  ]
}
```

Defaults (used when the file is absent):

| Slot | Provider | Model | Thinking |
|------|----------|-------|----------|
| M1 (Primary) | `anthropic` | `claude-opus-4-6` | `high` |
| M2 (Fallback 1) | `openai-codex` | `gpt-5.5` | `high` |
| M3 (Fallback 2) | `openrouter` | `google/gemma-4-31b-it:free` | `off` |
| M4 (Fallback 3) | `openrouter` | `openai/gpt-oss-20b:free` | `off` |

Thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.

## How it works

State is persisted under `~/.pi/agent/`:

- `auto-model.json` — your primary/fallback configuration
- `claude-quota-cache.json` — per-provider rate-limit cooldown expiry
- `auto-model-rate-limits.json` — last captured rate-limit snapshot per provider

Auth is read from pi's existing `auth.json`; the extension does not store credentials.
