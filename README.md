# opencode-copilot-auth

Package on npm: https://www.npmjs.com/package/@zhzy0077/opencode-copilot-cli-auth

A fork of [anomalyco/opencode-copilot-auth](https://github.com/anomalyco/opencode-copilot-auth) that adds native **1M token context** for Claude models by routing requests through the Anthropic Messages API (`/v1/messages`) instead of the OpenAI-compatible `/chat/completions` endpoint.

## How to use

Add the plugin to your `opencode` config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@zhzy0077/opencode-copilot-cli-auth@0.0.22"
  ]
}
```

Then start `opencode` and log in to the `github-copilot` provider using the device flow.

For local development before publishing, you can load the file directly:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///absolute/path/to/index.mjs"
  ]
}
```

> **Note:** if the file path contains `opencode-copilot-auth`, current `opencode` builds may skip loading it due to a hardcoded plugin-name filter. Use a path that does not contain that substring.

## What this fork adds over upstream

### 1M context for Claude models

The Copilot API exposes a native Anthropic Messages endpoint at `/v1/messages` that accepts up to **1,000,000 tokens** — far beyond the 168K hard cap on `/chat/completions`. This fork automatically routes all Claude model requests to that endpoint and translates the request/response format transparently.

The Copilot API metadata reports `max_context_window_tokens: 200000` for most Claude models. This fork overrides those values to `1,000,000` for any model that supports `/v1/messages`, so `opencode` sends the correct window size.

Empirically verified (needle-in-haystack tests):
- `claude-opus-4.7`: 350K tokens ✓, 1M tokens ✓, 1.44M tokens ✗ (confirmed 1M ceiling)
- `claude-sonnet-4.6`: 302K tokens ✓ (secret retrieved correctly)

### More models (20 vs upstream's baseline)

Uses the VSCode OAuth client (`Iv1.b507a08c87ecfe98`) and `api.githubcopilot.com`, which exposes 20 picker models including `gemini-3.1-pro-preview`, `gemini-3-flash-preview`, and `gpt-4o` that the enterprise endpoint omits.

### Persistent token caching

The short-lived Copilot token (exchanged via `/copilot_internal/v2/token`) is written back to the `opencode` auth store with a 5-minute expiry buffer. When you run multiple `opencode` instances simultaneously, only the first one fetches a new token — the rest reuse the persisted one.

## Model limits exposed to opencode

| Model                | Context    | Input (prompt) | Output |
|----------------------|-----------:|---------------:|-------:|
| `claude-opus-4.7`    | 1,000,000  | 1,000,000      | 32,000 |
| `claude-opus-4.6`    | 1,000,000  | 1,000,000      | 32,000 |
| `claude-opus-4.6-1m` | 1,000,000  | 936,000        | 64,000 |
| `claude-sonnet-4.6`  | 1,000,000  | 1,000,000      | 32,000 |
| `claude-sonnet-4.5`  | 1,000,000  | 1,000,000      | 32,000 |
| `claude-haiku-4.5`   | 1,000,000  | 1,000,000      | 64,000 |

## Claude thinking budget

When the `thinking` variant is selected, the plugin sends `thinking_budget: 16000`. When no variant is selected, it omits the field entirely.

## Publishing

```zsh
./script/publish.ts
```

