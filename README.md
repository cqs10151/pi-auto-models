# pi-auto-models

A [pi](https://pi.dev) extension that provides a **pure, deterministic 4-tier model fallback chain** with automatic error recovery and manual override awareness.

When your active model hits rate limits (429), server overloads (500/502/503/529), or stream errors, it automatically switches to the next configured fallback model and triggers a retry.

## Features

- **4-Tier Fallback Chain** — sequentially downgrades through 4 configured model slots (`M1 -> M2 -> M3 -> M4 -> M1...`).
- **Auto Error Recovery & Retry** — intercepts HTTP errors (400, 429, 5xx) and stream failures, automatically switching slots and retrying seamlessly after a brief debounce.
- **Intent-Aware Manual Override** — manually switching to an external model won't disrupt your saved fallback state; user interrupts (Cancel/Abort) are safely ignored without triggering false-positive fallbacks.
- **Interactive `/auto-model` TUI** — search and configure each slot's provider, model, and thinking level with instant fuzzy search.

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
| `/auto-model` | Open interactive TUI to configure the 4-tier fallback chain |

## Configuration

`/auto-model` saves your configuration to `~/.pi/agent/auto-model.json`:

```json
{
  "models": [
    { "provider": "opencode", "model": "deepseek-v4-flash-free", "thinking": "high" },
    { "provider": "cloudflare-workers-ai", "model": "@cf/zai-org/glm-4.7-flash", "thinking": "off" },
    { "provider": "nvidia", "model": "stepfun-ai/step-3.7-flash", "thinking": "off" },
    { "provider": "openrouter", "model": "openrouter/free", "thinking": "off" }
  ]
}
```

### Defaults (used when config file is absent)

| Slot | Provider | Model | Thinking |
|------|----------|-------|----------|
| **M1 (Primary)** | `opencode` | `deepseek-v4-flash-free` | `high` |
| **M2 (Fallback 1)** | `cloudflare-workers-ai` | `@cf/zai-org/glm-4.7-flash` | `off` |
| **M3 (Fallback 2)** | `nvidia` | `stepfun-ai/step-3.7-flash` | `off` |
| **M4 (Fallback 3)** | `openrouter` | `openrouter/free` | `off` |

Valid thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.

## How it works

- **State Persistence**: Model slot configurations are saved atomically to `~/.pi/agent/auto-model.json`.
- **Status Display**: Current active slot is displayed in pi's status bar (e.g. `⚡ [M1] deepseek-v4-flash-free` or `⚡ [Manual] <model_name>`).
- **Auth**: Provider authentication is managed directly by pi (`auth.json`); the extension stores no credentials.