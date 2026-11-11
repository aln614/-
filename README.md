# LocalApiImageGenerator

Electron local WebUI for APIMart / Flow2API image, Midjourney and video workflows.

## Features

- Local Electron desktop UI
- APIMart image and video generation
- Local Flow2API image/video bridge
- Midjourney task, history, mask editor and secondary actions
- Batch history, image/video management, asset library and prompt library
- LAN/public access with per-device data isolation
- GitHub Release based in-app updater

## Development

```bash
npm install
npm start
```

## Build desktop packages

```bash
npm run dist
```

The Windows portable EXE is generated in `dist/`.

macOS builds require a Mac. The command below generates a DMG and ZIP for the current Mac architecture:

```bash
npm run dist:mac
```

GitHub Actions builds separate Apple Silicon (`arm64`) and Intel (`x64`) packages and attaches both to tagged releases. The current macOS packages are unsigned and not notarized; on first launch, Control-click TENYING_AI in Finder and choose Open.

## GitHub updater

On Windows, the app can download the latest `.exe`, replace the current executable in place, and restart. On macOS, the update window opens the matching architecture's `.dmg`; drag TENYING_AI into Applications to replace the installed app.

Release requirements:

- Tag name should be a semantic version, for example `v1.0.4`.
- The included GitHub Actions workflow builds the Windows portable `.exe`, Windows LAN client, and macOS arm64/x64 DMG and ZIP packages. All packages are attached to the GitHub release when a matching `v*` tag is pushed.
- The release asset is named like `TENYING_AI-1.0.4-win-x64.exe`.
- macOS assets are named `TENYING_AI-<version>-mac-arm64.dmg` / `...-mac-x64.dmg` and have matching ZIP archives.
- In the app, open Settings and fill the repository as `owner/repo`.

## Security Notes

Runtime data, generated files, packaged EXEs, `node_modules`, and private Flow2API local config are intentionally excluded from git.
