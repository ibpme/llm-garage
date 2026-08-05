# Pi Custom Extensions Development

This directory contains the TypeScript extensions used by the personal Pi configuration in this repository.

The setup is intended for local VS Code and TypeScript development. Pi itself may be installed globally, but the TypeScript language service needs local copies of the package declarations in order to resolve imports and provide autocomplete.

## Prerequisites

- A clone of this repository
- [Bun](https://bun.sh/) installed
- The latest Pi release installed and available as `pi`
- VS Code with its built-in TypeScript support

Check the installations:

```bash
bun --version
pi --version
```

## Install development dependencies

From the repository root:

```bash
cd pi-custom-extensions
bun install
```

The local `package.json` uses the `latest` tag for Pi packages so that the development types follow the current Pi release. The following packages are installed locally for editor support and type checking:

- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `typebox`
- `typescript`
- `@types/node`

`node_modules/` and dependency lockfiles are intentionally ignored by this repository. Run `bun install` again after updating Pi or when setting up another machine.

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

## Run the extensions in Pi

The repository's Pi sync script links these extension files into `~/.pi/agent/extensions/`:

```bash
cd /path/to/llm-garage
./sync/sync-all.sh
```

After syncing, start Pi normally. Extensions in the global extension directory are automatically discovered. Use `/reload` in Pi after changing an extension.

For a one-off test without syncing:

```bash
pi -e ./pi-custom-extensions/status-line.ts
```

## Adding dependencies

Add development dependencies with Bun:

```bash
cd pi-custom-extensions
bun add --dev <package-name>
```

Then run the type check again:

```bash
bun run typecheck
```

Do not manually install packages into Bun's global directory for extension development. Global installation makes the Pi CLI available, but it does not reliably expose package types to VS Code's TypeScript server.
