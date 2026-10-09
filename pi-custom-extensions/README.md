# Pi Custom Extensions Development

This directory contains the TypeScript extensions used by the personal Pi configuration in this repository.

This directory is one local Pi package, with explicit extension entry points in
`package.json` and one dependency installation. Pi loads TypeScript directly
through jiti; no compilation or bundling step is needed. Local development
dependencies provide VS Code autocomplete and TypeScript checking.

## Structure

The package manifest lists both shapes of extension explicitly:

| Path | Loaded as |
|---|---|
| `<name>.ts` | a single-file extension |
| `<name>/index.ts` | a multi-file extension, with helpers next to it |
| `shared/*.ts` | **not** an extension — see below |

`shared/` holds genuinely reused helpers (`pager.ts`, `message-text.ts`,
`tool-guard.ts`). Feature-specific helpers live with their feature; for example,
SSH transport belongs in `ssh/transport.ts`. Helpers, contracts, tests, and scripts
are not listed in `pi.extensions`, so they are not loaded as extensions.

Everything in `shared/` and `contracts/` must be **stateless**. Pi loads each
extension with its own jiti instance and `moduleCache: false`; ordinary module
variables are not shared between those import graphs. Most state belongs to a
feature instance. The two intentional cross-extension services use process-wide
`Symbol.for` keys: `tool-set/service.ts` publishes the running ToolSet, and
`stylish-tools/overrides.ts` shares I/O overrides. Neither module registers an
extension. Lifecycle owners must release subscriptions and resources on shutdown.

Relative imports carry an explicit `.ts` extension (`./shared/pager.ts`),
matching pi's own multi-file extension examples, since jiti resolves the
specifier as written.

## Architecture and boundaries

Keep one package and one explicit manifest. Small extensions remain single files;
larger features use focused modules:

| Feature | Responsibilities |
|---|---|
| `prompt-suggestions/` | Registration, controller, config, context, generation, editor |
| `questionnaire/` | Registration/reanswer workflow, model parsing, schemas, UI, tree compatibility |
| `ssh/` | Registration/connection lifecycle, operations, transport, tool-set integration |
| `stylish-tools/` | Registration, tool factories, rendering, operation overrides |
| `tool-call-stats/` | Event wiring, accounting/persistence, formatting, contracts |
| `tool-set/` | Registration, instance-owned state, public service/contracts, mode commands/UI |

An entry point registers a feature; it is **not a reusable library API**. Production
modules must not import any manifest entry point, including another feature's
`index.ts`. Import focused modules instead. Runtime import cycles are forbidden;
type-only dependencies are allowed. `bun run check:architecture` enforces these
boundaries and checks that default factories match manifest entries.

Important runtime relationships that a static import tree cannot show:

| Relationship | Contract |
|---|---|
| SSH manages remote selection through tool-set | `tool-set/service.ts`, required after factories finish |
| SSH redirects base styled tools in CLI override mode | `stylish-tools/overrides.ts` |
| Reasoning tokens feed agent statistics | Event name/payload in `contracts/events.ts` |
| Footer positions mode and SSH badges | Keys in `contracts/status-keys.ts` |

Tool-set is the sole owner of active-tool application. Its blocked-tool additions
are instance-owned and survive session resets for that runtime. SSH integration
subscribes once per runtime, synchronizes selection across connection/mode changes,
and unsubscribes on shutdown. Publishing a replacement ToolSet is safe against
cleanup from an older instance.

Permission boundaries are deliberately unchanged: `permission-gate.ts` checks
local `bash`, and `protected-paths.ts` checks local `write`/`edit`. These guards do
not cover remote variants. SAFE mode separately blocks remote mutation tools.
These are safeguards, not a security sandbox.

`questionnaire/tree-compat.ts` isolates the private tree-rendering patch. It makes
question results visible to the tree filter by substituting display entries. It
relies on Pi's private `treeList.flatNodes` and `applyFilter` shape at the pinned
Pi version (1.1.0); manually verify this workflow on upgrades. Its process-wide
prototype marker prevents repeated installation on reload. Remove the patch if
Pi gains a supported question-result filtering hook.

The moved entry points are listed in `package.json`; the old `ssh.ts`,
`stylish-tools.ts`, `prompt-suggestions.ts`, `tool-call-stats.ts`, and misspelled
`questionnare.ts` paths are no longer entry points. Package-based loading is
unchanged; update any custom one-off `pi -e <file>` commands to the new paths.

## SSH and styled tools

With the package loaded, `/ssh user@host[:/path]` connects seven additional
`*_remote` tools while local tools remain local. `/ssh off` disconnects them.
Remote `read` is available in both modes, remote `write`/`edit`/`bash` are blocked
in SAFE mode, and remote `grep`/`ls`/`find` are exposed only while connected and
SAFE. SSH requires key-based authentication and Bash on the remote host.

CLI override mode instead redirects the base tools and user `!` commands for the
session; interactive `/ssh` switching is disabled in that mode:

```bash
pi -e ./pi-custom-extensions --ssh user@host:/remote/path
```

The styled tools delegate execution to Pi's original implementations and share
rendering between local and remote variants. Expanded results use an indicator
and gutter rather than boxes; compact previews retain each tool's output caps.

## Prerequisites

- A clone of this repository
- [Bun](https://bun.sh/) installed
- Pi 1.1.0 installed and available as `pi` (matching the pinned development types)
- VS Code with its built-in TypeScript support

Check the installations:

```bash
bun --version
pi --version
```

## Install dependencies

From the repository root:

```bash
cd pi-custom-extensions
bun install --frozen-lockfile
```

Dependencies are separated by responsibility:

- **Runtime dependencies:** `grok-mermaid`.
- **Host-provided peers:** the four `@earendil-works/pi-*` packages and `typebox`,
  declared with `"*"` ranges. Pi supplies these at runtime; do not bundle them or
  put them in `dependencies`.
- **Development dependencies:** pinned local copies of the host packages,
  `typescript`, and `@types/node`, for editor support, tests, and type checking.

`bun.lock` is tracked; `node_modules/` is not. Local Pi packages are not
installed automatically, so run the install command once on each machine.
When upgrading Pi, deliberately update the pinned development package versions
and lockfile to match; see the update routine below.

## Updating Pi

Updating the installed Pi changes the host APIs used by extensions in newly
started Pi processes. It does **not** update this package's pinned development
copies, `package.json`, or `bun.lock`. `grok-mermaid` also stays at its locked
version. The package symlink remains valid because it points to this repository,
not Pi's installation; no resync is needed.

Compatible updates should keep working. Breaking API changes can cause loading
errors or failures when a command or tool runs. The `"*"` peer ranges allow Pi
to provide its packages; they do not guarantee compatibility. Checking against
old development types can miss incompatibilities with a newer runtime.

After updating Pi:

1. Check `pi --version` and review the release notes for extension API changes.
2. Update the four local Pi development packages to that release. For example,
   if the installed release is `1.2.0` (replace with your actual version):

   ```bash
   cd pi-custom-extensions
   bun add --dev --exact \
     @earendil-works/pi-agent-core@1.2.0 \
     @earendil-works/pi-ai@1.2.0 \
     @earendil-works/pi-coding-agent@1.2.0 \
     @earendil-works/pi-tui@1.2.0
   ```

3. If Pi changed its TypeBox version, align the local `typebox` development
   dependency too, using `bun add --dev --exact typebox@<version>`.
4. Run the checks:

   ```bash
   bun run typecheck
   bun run test:loading
   ```

   The loading test uses the **local development copy of Pi**, not the installed
   CLI. Keeping versions aligned makes it relevant to the new runtime. It checks
   imports and registration, not every command or tool; manually exercise key
   workflows after significant updates.
5. Review and commit `package.json` and `bun.lock`, and update the prerequisite
   version in this README. Restart existing Pi processes to use the updated
   runtime; `/reload` reloads extension code but does not replace the running Pi.

Pinned development dependencies make installs reproducible. Updating them
alongside Pi keeps autocomplete, type checking, and loading tests aligned with
the runtime.

## Open in VS Code

Open the repository root, not just an individual TypeScript file:

```bash
code /path/to/llm-garage
```

The repository's `.vscode/settings.json` points VS Code at the TypeScript installation under `pi-custom-extensions/node_modules/`.

If VS Code still reports unresolved imports:

1. Run **TypeScript: Select TypeScript Version**.
2. Select **Use Workspace Version**.
3. Run **TypeScript: Restart TS Server**.

The `tsconfig.json` in this directory configures strict ESM-aware type checking with `moduleResolution: "NodeNext"`.

## Type-check the extensions

```bash
cd pi-custom-extensions
bun run typecheck
```

This runs `tsc --noEmit` against all `.ts` files in this directory.

Run all tests and architectural checks:

```bash
bun run check
```

Or run them independently:

```bash
bun run test                 # Colocated .test.ts files through Node's test runner
bun run check:architecture   # Entry-point boundaries and runtime import cycles
bun run test:loading         # Manifest discovery and imports; no model calls
```

Tests cover tool selection and SAFE masking, remote integration in both startup
orders, cross-import services, guards, and pure parsing/formatting/accounting.
Live SSH, model-provider calls, and interactive UI behavior still require manual
smoke testing.

This loads the package through a temporary symlink, checks that every declared
extension loads exactly once, and rejects loading errors or warnings.

## Run the extensions in Pi

The repository's Pi sync script creates one link:
`~/.pi/agent/extensions/llm-garage` → this package directory. Pi reads its
`pi.extensions` manifest and resolves runtime imports within the package:

```bash
cd /path/to/llm-garage
./sync/sync-all.sh
```

After syncing, start Pi normally or use `/reload` in an existing session.
Sync migrates old per-extension repo symlinks to the single package link,
restoring their backups and preserving unrelated local extensions. Unsync
removes the package link using the same backup/restore rules.

Edits and manifest additions take effect on `/reload`; no resync is needed
unless the package location changes.

For a one-off test without syncing:

```bash
pi -e ./pi-custom-extensions
```

## Adding dependencies

From `pi-custom-extensions/`, add third-party runtime dependencies normally:

```bash
bun add <package-name>
```

Use `bun add --dev <package-name>` only for development tools. Do not create
nested dependency manifests for extensions in this collection. Commit changes
to both `package.json` and `bun.lock`, then run:

```bash
bun run typecheck
bun run test:loading
```

Do not manually link packages from Pi's installation or install them into Bun's
global directory for extension development. Those paths are machine-specific
and unnecessary with the local development dependencies.
