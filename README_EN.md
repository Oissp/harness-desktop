# DSH Desktop — Colorful desktop client for DeepSeek Harness

> **Download, install, double-click, and chat** — no terminal, no environment setup.
> The official DeepSeek Harness Web UI, wrapped in a native desktop shell.

[中文 README](README.md)

![splash](assets/screenshots/splash.png)

![main](assets/screenshots/main.png)

## Features

- **Out-of-the-box**: built-in DeepSeek Harness engine — install and chat. First-run wizard in 3 minutes
- **Streaming chat**: typewriter output + thinking visualization
- **Task panel**: task tracking / auto-review / failure retry
- **Agent evolution**: memory auto-persists (preferences / project conventions / success patterns) + skills auto-distilled from repeated tasks
- **Colorful appearance**: dark / light / follow-system themes × DeepSeek blue / green / purple / orange accents, font size / message density, applied live
- **Auto-update**: background check on startup + manual check from Settings/tray; downloads new versions and installs on restart
- **Security**: strict CSP / single-instance lock / attachment limits / safeStorage-encrypted credentials
- **System tray**: minimize to tray and keep running in background

## Install

**Debian 13 / amd64 installer** (`.deb`): [GitHub Releases](https://github.com/Oissp/harness-desktop/releases)

```bash
# download the latest .deb, then:
sudo dpkg -i harness-desktop_*.deb
```

**First run**: Run → 4-step wizard (welcome → API Key → workspace → done) → start chatting.
Get your API Key at [platform.deepseek.com](https://platform.deepseek.com/api_keys).

> No installer? Run from source:
> ```bash
> pnpm install
> pnpm dev
> ```

## Check for updates

The app embeds electron-updater. It auto-checks for new GitHub Release versions 15s after startup, then every 6 hours; you can also check manually from Settings → About & Update or the tray menu. New versions download in the background and prompt a restart to install.

Update detection reads `latest-linux.yml` from the Release (version / download URL / sha512), compares against the local version, and on a hit downloads and installs via `dpkg -i`.

## Release mechanism

Releases are driven by `package.json`'s `version` and **do not depend on the upstream dsh version number**: bump the version after a feature update, push to `main`, and CI builds the `.deb` + `latest-linux.yml` and publishes a `v<version>` Release.

The **dsh upstream npm version detection is retained**: a daily scheduled check queries `@deepseek-ai/dsh`'s npm latest, and on a new version upgrades the dependency and patch-bumps the app version (decoupled from the dsh version number — just marks a "dependency-update release"), released in the same run. A dsh engine dependency bump is itself a release. See `.github/workflows/build-debian.yml`.

## Development

```bash
pnpm install      # install deps (Node >=22.19, pnpm >=9)
pnpm dev          # dev mode: vite + electron (HMR)
pnpm build        # build renderer + main
pnpm test         # unit tests (Vitest)
pnpm typecheck    # TS type check
pnpm dist         # package Debian 13 .deb (amd64, output to out/)
```

## Tech Stack

- **Engine**: DeepSeek Harness `@deepseek-ai/dsh`
- **Shell**: Electron 43 (Linux artifacts pinned to 42.9.3) + electron-builder
- **Frontend**: React 18 + TypeScript + Vite (hand-written CSS + `--dsw-*` tokens, no heavy UI libs)
- **Isolation layer**: `adapter/` encapsulates the dsh API — upstream changes only touch the adapter, the renderer never sees raw dsh fields

## Known Limitations

- **Size**: installers ~130-230MB (bundled dsh engine + Electron)
- **Platform**: only Debian 13 (trixie) / amd64 `.deb` is built

## License

[MIT](LICENSE)

---

*Not an official DeepSeek product, not affiliated with DeepSeek; DeepSeek Harness is an open-source project by [DeepSeek AI](https://deepseek.com).*
