# APIMart Model Catalog Audit - 2026-09-18

Release: host 1.0.100, LAN client 1.0.56.

## Sources

- [Documentation index](https://docs.apimart.ai/_llms/cn/api.md)
- [Public marketplace](https://api.apimart.ai/api/marketplace/models)
- [Wan3.0 / Prime contract](https://docs.apimart.ai/cn/api-reference/videos/wan3.0-video/generation)
- [MiniMax H3 Max contract](https://docs.apimart.ai/cn/api-reference/videos/minimax-h3/max)
- [Pricing](https://apimart.ai/zh/pricing)

Fetched 83 image/video documentation pages and both pages of the public
marketplace (191 entries, including chat). No user API Key was required.

## Changes

- Add wan3.0-video-prime. The official page explicitly gives Prime the same
  parameters as wan3.0-video: 480P/720P/1080P, 2-30 seconds or automatic duration,
  images/video/audio, document or link references, generated audio.
  Reuse the existing rule and UI controls; keep the upstream Prime model ID.
- Update MiniMax-H3-Max: add 1080P, up to 9 reference images, 3 reference videos
  and 3 reference audios. Keep 5-15 seconds; audio needs image/video references.
  Frame mode must not mix with reference mode. Omit watermark entirely at 1080P.
  Limit prompt to 7000 characters. No 2K, middle-frame or seed support.
- Image selections remain 40: no missing newly documented image ID was found.
  Preserve previous variants, aliases and saved tasks. Video picker now has
  53 backend-supported selections; legacy hidden UI aliases are retained.
- Refresh fallback pricing for H3 Max and Wan3; add separate Prime pricing.
  Snapshot Credits/second: H3 Max 480P/768P/1080P = 0.3768/0.5712/1.28;
  Wan3 480P/720P/1080P = 0.3288/0.65752/1.31504;
  Prime 480P/720P/1080P = 0.514288/1.028568/2.057144.
  Live pricing remains authoritative and refreshable.

## Folder Downloads

History single/multi-batch, selected images/videos and bulk asset downloads now
save original files under a fresh export directory, grouped by batch/category.
No ZIP is produced by these UI actions. Single-file downloads and Describe XLSX
exports retain their original formats. Legacy ZIP HTTP routes are retained for
older clients.

Host and LAN client use an origin-restricted Electron bridge and a native folder
picker. HTTPS Chrome/Edge and localhost browsers can use the File System Access
directory picker. Ordinary HTTP LAN browsers cannot write directories: use the
updated LAN client or HTTPS. There is no silent ZIP fallback.

Files are streamed; originals are not moved or changed. Duplicate filenames and
batch names are disambiguated. Progress, cancellation, read failures, truncated
responses and timeouts are handled; partial files are removed. Permission checks
apply both to manifest creation and each file request.

## Verification

- npm run check: existing regressions, model alignment, actual payload-field
  assembly, fallback prices, folder streaming and ownership checks.
- npm run lan-client:check.
- scripts/verify-folder-export-integration.js (Playwright from NODE_PATH):
  isolated HTTP server, original-byte download, CSRF, history single/selected
  download clicks, progress UI, model controls and real Electron IPC/session.fetch.
  Native folder picker is stubbed to an isolated destination in this test.
- No paid generation requests were sent. Model contract tests do not guarantee
  account-specific availability or generation success.
- The live application, existing output directories and asset indexes were not
  modified or restarted during testing.

