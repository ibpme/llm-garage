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

`shared/` holds helpers imported by more than one extension (`pager.ts`,
`message-text.ts`, `tool-guard.ts`). Helpers, tests, and scripts are not listed
in `pi.extensions`, so they are not loaded as extensions. Add new extension
entry points to the manifest explicitly; do not list helper modules.

Everything in `shared/` must be **stateless**. Pi loads each extension with
its own jiti instance and `moduleCache: false`, so a module imported by two
extensions is instantiated twice: module-level variables are not shared and
a singleton there would silently split in two. Anything that genuinely
needs shared state must either live inside one extension (see `tool-set/`,
which merged the old `mode.ts` and `tools.ts` for exactly this reason) or
go through pi — `pi.events`, `pi.getActiveTools()`, or session entries.

Relative imports carry an explicit `.ts` extension (`./shared/pager.ts`),
matching pi's own multi-file extension examples, since jiti resolves the
specifier as written.

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

Verify manifest discovery and runtime imports without making model calls:

```bash
bun run test:loading
```

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
