# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

harness-desktop is an Electron desktop client for the DeepSeek Harness engine (`@deepseek-ai/dsh`). It does not reimplement the chat UI — it launches the official dsh web engine as a child process on a random loopback port and points a `BrowserWindow` at it. The desktop shell (this repo's own React app) shows only during boot, the first-run wizard, and as the fallback screen if the engine fails to load.

## Commands

```bash
pnpm install          # install deps (Node >=22.19, pnpm >=9)
pnpm dev              # vite dev server (5173) + electron, with HMR
pnpm build            # build renderer (vite) + electron main (tsc)
pnpm typecheck        # tsc --noEmit against BOTH tsconfig.json and tsconfig.electron.json
pnpm test             # vitest run
pnpm test:watch       # vitest watch
pnpm dist             # build + electron-builder (mac dmg + win exe → out/)
pnpm dist:mac         # mac only
pnpm dist:win         # windows only
```

Run a single test file: `pnpm test src/__tests__/chatReducer.test.ts` (vitest takes a path filter). Run a single test by name: `pnpm test -t "name fragment"`.

Two TypeScript projects are kept separate on purpose: `tsconfig.json` (renderer/adapter/shared, `moduleResolution: bundler`, DOM libs) and `tsconfig.electron.json` (electron/adapter/shared, `moduleResolution: NodeNext`, Node types, emits to `dist-electron/`). `adapter/` and `shared/` are compiled by both. When touching those, both must typecheck.

## Architecture

### The three-layer boundary (the most important thing in this repo)

```
renderer (src/, React)  ──window.harness.*──  preload (electron/preload.ts)  ──ipc──  main (electron/)  ──adapter──  dsh engine
```

The renderer **never** sees dsh's wire format. The boundary is enforced at three points:

1. **`adapter/`** — the *only* code that knows dsh's JSON-RPC + SSE/WebSocket protocol. `dsh-client.ts` is the low-level transport (`/api/<method>` POST + `ws://.../api/events.mux`). `index.ts` (`DshAdapter`) is the business API. `events.ts` normalizes raw dsh events into the stable `SessionStreamEvent` vocabulary. When the dsh upstream changes its API, only `adapter/` changes.
2. **`shared/types.ts`** — the stable IPC contract. `HarnessApi` is the complete surface the renderer is allowed to call; `SessionStreamEvent` / `MessageBlock` / `AppSettings` are the only data shapes the renderer sees. This file must not import dsh types.
3. **`electron/ipc.ts`** + **`electron/preload.ts`** — the IPC bridge. `ipc.ts` registers `ipcMain.handle` channels that delegate to the adapter; `preload.ts` exposes `window.harness` (via `contextBridge`) mapping 1:1 to `HarnessApi`. Adding a renderer capability means touching all three in lockstep: `shared/types.ts` (type) → `preload.ts` (binding) → `ipc.ts` (handler) → `adapter/index.ts` (impl).

### Two UIs in one window

The window points at **two different things over its lifetime**:

- **Desktop React UI** (`src/`, built by vite to `dist/`) — loaded first as the boot/fallback screen and runs the onboarding wizard (`Wizard.tsx`), settings modal, task panel, memory/evolution sections. These are desktop-only features the official UI lacks.
- **Official dsh web UI** — once the engine reports a port, `main.ts:loadEngineUI(port)` calls `mainWindow.loadURL('http://127.0.0.1:<port>')`, replacing the desktop UI with the engine's own SPA. The official UI consumes desktop-shell capabilities through a second bridge, `window.__desktop__` (also exposed in `preload.ts`), and gets brand injection (`injectDesktopBrand()` in `preload.ts`) that swaps in the whale logo/hero via MutationObserver since React may re-render.

Port drift is real: if the engine crashes and restarts on a new port, `loadEngineUI` reloads to the new port, and `DshManager.rebindEventListeners()` reattaches all event subscribers to the new adapter. Event subscription is designed to survive adapter recreation — `dsh:subscribe` queues listeners if the adapter isn't ready yet.

### Engine lifecycle (`electron/dsh-manager.ts`)

`DshManager` spawns `dsh web --host 127.0.0.1 --port 0`, scrapes the assigned port from stdout, polls `host.describe` until ready (90s timeout), and exposes `DshAdapter` once ready. Dev uses the system node; packaged builds run the dsh bin under `ELECTRON_RUN_AS_NODE`. On unexpected exit after it was once ready, it auto-restarts after 1.5s. First run needs "priming": dsh initializes its profile (downloads deps), so `DshManager.start()` runs the engine once, stops it, then starts again — see `electron/profile-setup.ts`.

### Profile + plugins (`electron/profile-setup.ts`, `plugins/`)

The dsh engine keeps a per-install profile at `<userData>/dsh-home/profiles/web/`. Local plugins (currently `harness-memory`) are copied from `plugins/<name>` into the profile's `node_modules` and registered as bundles in the profile's `package.json`. `checkProfile` runs on every start (always re-copies plugin source so edits take effect). The memory plugin is non-fatal — if it fails, memory features degrade silently.

### State the desktop owns vs. delegates

App-level settings (`AppSettings` in `shared/types.ts`) live in `<userData>` via `SettingsStore`, separate from dsh's own data. Desktop-owned, dsh-has-no-native-support state includes: pinned sessions, session colors, reminders, task records, evolution config, the hidden review session, appearance config. Credentials are encrypted with Electron `safeStorage` (`credential-store.ts`) and migrated from dsh's plaintext `.credentials.yaml` on first run.

## Packaging notes

- **`asar: false`** in `electron-builder.yml` — dsh profile init creates symlinks that don't resolve inside asar. Native modules (`node-pty`, `koffi`) are `asarUnpack`ed instead so they load under `ELECTRON_RUN_AS_NODE`.
- **`scripts/after-pack.mjs`** copies the entire flat `node_modules` into the build (electron-builder's dependency collection misses transitive `@deepseek-ai/*` deps under pnpm) and fetches target-platform native binaries (`koffi-<platform>-<arch>`) for cross-platform builds.
- **`pnpm-workspace.yaml`** uses `nodeLinker: hoisted` (no symlinks, flat layout) specifically so the packaged dependency closure resolves.
- macOS auto-update requires code signing; unsigned builds silently skip updates. Signing flow is in `docs/SIGNING.md`.

## Conventions

- Comments and UI strings are in Chinese (the primary audience). Match the surrounding language.
- The adapter must stay thin: raw dsh shapes are cast through `Record<string, unknown>` and normalized to `shared/types.ts` shapes — never leak dsh field names past `adapter/`.
- IPC handlers wrap everything in `run(() => ...)` which returns `IpcResult<T>` (`{ ok, value }` / `{ ok: false, error }`). Never throw past the IPC boundary to the renderer; failures become `IpcResult` errors.
- `sandbox: false` in the BrowserWindow is intentional and compensated for: preload is ESM (package.json `type: module`), which crashes under Electron's sandboxed CJS-only preload. Security is handled via `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`, strict CSP in `index.html`, and navigation/window-open guards in `main.ts`.

## Docs

- `docs/REPORT.md` + `docs/history/REPORT-*.md` — delivery reports per version (the numbered comments like `021`, `026`, `031` in the code refer to these).
- `docs/MIGRATION-DESIGN.md` — the design rationale for pointing the window at the official web UI.
- `docs/SIGNING.md` — macOS signing/notarization; `docs/SIZE.md` — bundle size.
