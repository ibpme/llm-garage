# Account usage

Our own Pi extension; no external usage package or runtime dependency.
Run `/reload` after editing it. It is included in the package manifest and
uses the existing package symlink, so no resync is needed.

## Commands

| Command | Result |
| --- | --- |
| `/usage` or `/usage all` | All configured supported providers |
| `/usage opencode-go` | OpenCode Go rolling, weekly, and monthly quotas |
| `/usage openai` | Native OpenAI ChatGPT subscription guidance or shared-plan quotas |
| `/usage openai-codex` | Legacy Codex subscription quotas directly |

If both OpenAI logins are configured, the default view includes native OpenAI
only, avoiding a duplicate companion report. Explicit provider selection works
without changing the session model. One provider's failure does not hide the
others.

Each quota is one line: a severity-colored bar, **used** and **left** percentages,
and a reset countdown captured at lookup time (the local timestamp is dropped when
the viewer is narrow). Passed reset times do not imply that
usage has returned to zero. The TUI opens a scrollable viewer; Esc/q closes it.
RPC uses a notification, and print/JSON modes use plain console output, following
the shared pager convention. No report is added to model context or saved.

## Authentication and limitations

### OpenCode Go

Use Pi's existing `/login opencode-go`, `OPENCODE_API_KEY`, or provider configuration.
The adapter resolves auth through Pi and calls:

`GET https://opencode.ai/zen/go/v1/usage`

Known `ok` and `rate-limited` windows remain visible. Missing or unrecognized
values are shown as unavailable, not as zero usage.

### Native OpenAI (`openai`)

Pi 1.1.0's native “Sign in with ChatGPT” token is scoped to the public Responses
API. It **cannot** be sent to the legacy ChatGPT quota endpoint.

Without a companion login, the report gives a web-only fallback:
https://chatgpt.com/settings/usage. It cannot establish numerical usage or plan
tier from the native grant alone.

For shared-plan quota reporting:

1. Keep your existing `/login openai` login.
2. Use `/login openai-codex` and choose the **same ChatGPT account/workspace**.
3. Run `/usage` again; switching the active model is unnecessary.

The adapter refreshes the companion through Pi's auth resolver, checks for a
unique registration of the native grant's `clientId` in
`GET https://chatgpt.com/backend-api/wham/usage/chatpass/apps`, then reads
`GET https://chatgpt.com/backend-api/wham/usage` with **only the Codex bearer** and
its matching account ID.

This is an experimental, undocumented companion integration, not a native
OpenAI quota API. App registration matching is not independent cryptographic
proof of account identity. Plan windows are labeled **Shared plan**; separate
app-specific allowances can also block Pi requests and must be checked on the
usage page. Codex code-review windows are not presented as native app quotas.

### Legacy OpenAI Codex (`openai-codex`)

Uses Pi's resolved OAuth credentials for the fixed `/wham/usage` endpoint.
Shows returned primary/secondary window durations, optional code-review
windows, plan tier, limit flags, and credits. It does not redeem reset credits
or perform other account mutations.

### OpenAI API keys

Organization Usage API reporting is not implemented: that API requires a
separate admin key, not the ordinary inference credential. API-key users get
a link to https://platform.openai.com/usage. No subscription endpoint is probed.

## Safety and maintenance

- Requests happen only on command invocation, not on startup or background timers.
- OAuth refresh is delegated to Pi; this extension does not implement login or
  rotate tokens itself.
- Model and resolved-auth origins must be official. Effective authorization must
  match provider authorization; proxy and model-level credential replacements
  fail closed.
- OAuth credentials must exactly match Pi's stored login after resolution.
  Other CLIs' auth files and browser cookies are never used.
- Only allowlisted request headers are sent. Redirects are rejected, requests
  time out after 10 seconds, and responses are limited to 1 MiB.
- Tokens and account IDs are never rendered or persisted. Raw auth/network
  errors and response bodies are not included in diagnostics.
- Session replacement/shutdown cancels pending HTTP requests.

| File | Responsibility |
| --- | --- |
| `index.ts` | Command registration, lifecycle, presentation |
| `service.ts` | Provider selection, auth boundaries, HTTP, companion orchestration |
| `providers.ts` | Response normalization and report types |
| `formatting.ts` | Themed usage report: eighth-block bars colored by severity (<60% green, 60–85% amber, ≥85% red); plain text for RPC and print |
| `*.test.ts` | Synthetic provider/auth/HTTP fixtures and Pi auth integration |

Run from `pi-custom-extensions/`:

```bash
node --experimental-strip-types --test usage/*.test.ts
bun run check
```

Contract references:
[OpenCode usage endpoint](https://github.com/anomalyco/opencode/issues/16017),
[OpenAI token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference),
[OpenAI errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery),
and [companion integration research](https://cdn.jsdelivr.net/npm/@narumitw/pi-usage@0.64.1/docs/providers.md).
Native/legacy OpenAI auth behavior was checked against Pi 1.1.0's installed
provider and OAuth implementations. OpenCode Go was live-verified; companion
reporting is covered by synthetic fixtures, not a live companion login.
