# APIMart Model Catalog Audit - 2026-10-10

Release: host 1.0.105. LAN client remains 1.0.56 and loads the host UI.

## Sources

- [Documentation discovery](https://docs.apimart.ai/llms.txt)
- [Current Chinese API index](https://docs.apimart.ai/_llms/zh-hans/api.md)
- Public marketplace: [page 1](https://api.apimart.ai/api/marketplace/models?page=1&page_size=100), [page 2](https://api.apimart.ai/api/marketplace/models?page=2&page_size=100), [page 3](https://api.apimart.ai/api/marketplace/models?page=3&page_size=100).
- [Nano Banana 2.1](https://docs.apimart.ai/cn/api-reference/images/gemini-nano-banana-2.1/generation)
- [FLUX 3 Image](https://docs.apimart.ai/cn/api-reference/images/flux-3-image/generation)
- [MAI-Image-2.6](https://docs.apimart.ai/cn/api-reference/images/mai-image-2.6/generation)
- [Vidu Q4 Preview](https://docs.apimart.ai/cn/api-reference/videos/vidu-q4-preview/generation)
- [GPT Image 2 official](https://docs.apimart.ai/cn/api-reference/images/gpt-image-2/official)
- Public pricing endpoint: `https://api.apimart.ai/api/pricing/model?model=<model>`.

Fetched all three marketplace pages: 201 grouped entries (148 chat, 24 image,
27 video, 2 audio). Compared with October 8: five new marketplace entries,
no removed IDs. Grouped entries can contain multiple callable variants.
No account API Key was used for the audit.

The old `/_llms/cn/api.md` index returns 404. Follow `llms.txt` to the new
`/_llms/zh-hans/api.md` index; individual Chinese pages remain under `/cn/`.
Fetched all 87 linked image/video Markdown pages. Of the 83 pre-existing
pages, only GPT Image 2 official changed: the `background` parameter and
its examples were removed. Four media documentation pages were added.

## Changes

- Add `gemini-nano-banana-2.1` and `gemini-nano-banana-2.1-ext`: 1K/2K/4K;
  official 1-4 outputs, Ext one output. Do not invent a reference-count cap.
  Check 20MB per reference, plus 50MB combined for Ext. Restrict Ext extreme
  ratios to 1K. Do not automatically enable the billing-changing fallback.
- Add `flux-3-image`: 768sq/1K/1.5K/2K/4K, documented aspect ratios, one
  output, at most ten references, no custom pixel dimensions. Use
  `aspect_ratio`, not inherited FLUX 2 output/background options.
- Add `mai-image-2.6` and `mai-image-2.6-flash`: 1K/2K, one output, at most
  five references. Text-only custom dimensions require at least 768px per
  side, at most 2,359,296 pixels and aspect ratio 1:4 through 4:1. Editing
  omits size/resolution because the model determines output dimensions.
- Add `viduq4-preview`: 3-16 seconds, 540p/720p/1080p/2K/4K. Support one
  first frame with optional prompt, or 1-15 reference images with a required
  prompt and up to three MP3 references (3-12 seconds, 50MB each). Two-image
  auto mode must use reference roles, never a last-frame role. Default output
  includes audio; silent output remains selectable. Map UI negative/random
  seed to zero. Keep multi-first-frame batch splitting working.
- Add `claude-haiku-5-5` to fallback chat choices. Live chat catalog refresh
  remains enabled.
- Remove `background` from GPT Image 2 official requests and hide that
  option for this model; other official image models retain it.
- The application now offers 46 image choices, 52 active video choices and
  167 fallback chat IDs. Retain historical compatibility rules and records.
- Bump host version and frontend cache identifiers to 1.0.105.

## Price Estimates

Read the public per-model pricing endpoint for FLUX 3, Nano Banana 2.1 Ext,
both MAI variants and Vidu Q4. Convert USD to the application's credits at its existing 10:1 rate.
These are default public prices, not account-specific billing guarantees.

| Model | Credits |
| --- | --- |
| Nano Banana 2.1 Ext | 1K: 0.2; 2K: 0.25; 4K: 0.3 per image |
| FLUX 3 Image | 768sq: 0.328; 1K: 0.384; 1.5K: 0.56; 2K: 0.8; 4K: 4.856 per image |
| Vidu Q4 Preview | 540p: 0.448; 720p: 0.912; 1080p: 1.024; 2K: 1.624; 4K: 3.328 per second |

Nano Banana 2.1 official and both MAI variants are token-metered. Mark them
dynamic rather than presenting precharges as fixed final image prices.

## Verification

- `npm run check`, including new mocked request/batch assembly tests for
  image rules and Vidu Q4, payload fields, reference limits, seeds and prices.
- `npm run lan-client:check`.
- Isolated hidden Electron/Chromium tests for image model switching and
  video model/resolution/mode/audio/duration controls. Network blocked in
  these test windows; production user data is not loaded.
- Desktop and narrow-window video screenshots inspected.
- `git diff --check`.
- No paid generation calls, production data edits or live app restart.
  End-to-end generation and account-specific availability are not verified.

Raw source snapshots are outside the release tree in
`outputs/apimart-audit-20261010`; screenshots are in
`outputs/model-catalog-verification-20261010`.
