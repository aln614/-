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

## Build single Windows EXE

```bash
npm run dist
```

The portable EXE is generated in `dist/`.

## GitHub updater

The app can check a GitHub repository's latest Release, download the Windows `.exe` asset, replace the current executable in place, and restart.

Release requirements:

- Tag name should be a semantic version, for example `v1.0.2`.
- The included GitHub Actions workflow builds the Windows portable `.exe` and attaches it to the release automatically when a `v*` tag is pushed.
- The release asset is named like `TENYING_AI-1.0.2-win-x64.exe`.
- In the app, open Settings and fill the repository as `owner/repo`.

## Security Notes

Runtime data, generated files, packaged EXEs, `node_modules`, and private Flow2API local config are intentionally excluded from git.
