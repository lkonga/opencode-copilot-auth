# opencode-copilot-cli-auth

Package on npm: https://www.npmjs.com/package/@zhzy0077/opencode-copilot-cli-auth

This fork replaces the older GitHub Copilot chat-auth flow with the newer Copilot CLI-style OAuth flow and makes `opencode` use the live Copilot model metadata for your account.

## How to use

Add the plugin to your `opencode` config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@zhzy0077/opencode-copilot-cli-auth@0.0.19"
  ]
}
```

Then start `opencode` and log in to the `github-copilot` provider. The plugin handles the Copilot CLI-style device flow and will reuse the stored GitHub OAuth token afterward.

For local development before publishing, you can load the file directly:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///absolute/path/to/index.mjs"
  ]
}
```

Important: if the file path contains `opencode-copilot-auth`, current `opencode` builds may skip loading it because of a hardcoded plugin-name filter. Use a path that does not contain that substring.

## What changed in this fork

- Auth flow: uses the Copilot CLI-style OAuth client flow and keeps the GitHub OAuth token directly.
- Entitlement: fetches `/copilot_internal/user` and uses the entitlement-provided Copilot API base URL.
- Token exchange: does not call `/copilot_internal/v2/token`.
- Request profile: uses the newer `copilot-developer-cli` headers instead of the older chat profile.
- Model metadata: fetches the live Copilot `/models` response via the plugin `provider.models` hook so the final `opencode` model list comes from the entitlement-backed Copilot API.

## Context window and model limits

The main practical difference from upstream is that this fork patches live per-model limits from Copilot instead of relying only on static metadata.

That means `opencode` can see the Copilot-advertised values for:

- `limit.context`
- `limit.input`
- `limit.output`

As of March 10, 2026, the live GitHub Copilot `/models` response used by this
fork exposes the Copilot CLI model profile. The table below compares the live
Copilot CLI context window against the static `github-copilot` catalog on
[`models.dev`](https://models.dev).

| Model               | This Fork (CLI Context) | `models.dev` Context | Difference |
| ------------------- | ----------------------: | -------------------: | ---------: |
| `claude-opus-4.6`   |                 200,000 |              128,000 |    +72,000 |
| `claude-sonnet-4.6` |                 200,000 |              128,000 |    +72,000 |
| `claude-haiku-4.5`  |                 144,000 |              128,000 |    +16,000 |

The practical takeaway is that this fork exposes larger live Claude context
windows than the static `models.dev` values.

Examples observed with this fork:

- `claude-sonnet-4.6`
  - context window: `200000`
  - prompt/input limit: `168000`
  - output limit: `32000`
- `claude-opus-4.6`
  - context window: `200000`
  - prompt/input limit: `168000`
  - output limit: `64000`
- `claude-haiku-4.5`
  - context window: `144000`
  - prompt/input limit: `128000`
  - output limit: `32000`

Without this patching, `opencode` may show stale or smaller limits depending on the static model catalog it started from.

## Claude thinking budget behavior

This fork also changes Copilot Claude request behavior:

- when the `thinking` variant is selected, it sends `thinking_budget: 16000`
- when no variant is selected, it omits `thinking_budget` entirely

This differs from upstream `opencode`, which currently sends `thinking_budget: 4000` for the built-in `thinking` variant.

The plugin intentionally does not try to change the `opencode` core UI. So the visible Claude variant list is still controlled by `opencode` itself; this fork changes the request behavior, not the built-in variant picker labels.

## Publishing

```zsh
./script/publish.ts
```
