# APIMart Model Catalog Audit - 2026-10-19

Release: host 1.0.106. LAN client remains 1.0.56 and loads the host UI.

## Sources

- [Documentation discovery](https://docs.apimart.ai/llms.txt)
- [Current Chinese API index](https://docs.apimart.ai/_llms/zh-hans/api.txt)
- Public marketplace: [page 1](https://api.apimart.ai/api/marketplace/models?page=1&page_size=100), [page 2](https://api.apimart.ai/api/marketplace/models?page=2&page_size=100), [page 3](https://api.apimart.ai/api/marketplace/models?page=3&page_size=100).
- [Nano Banana 2.1](https://docs.apimart.ai/cn/api-reference/images/gemini-nano-banana-2.1/generation)
- [Kling v3](https://docs.apimart.ai/cn/api-reference/videos/kling-v3/generation)
- [General chat completions](https://docs.apimart.ai/cn/api-reference/texts/general/chat-completions)

Fetched all three marketplace pages: 230 entries (149 chat, 34 image,
45 video, 2 audio). Compared with October 10: 29 additional entries and
no removed IDs. Of these, 10 image variants and 18 video variants already
exist in the program, including canonical API model aliases. They are not
new app integrations and are not duplicated in the selectors.

The one newly listed chat model, `gemini-4-argon`, was not in the built-in
fallback list and is now included. Live chat refresh remains enabled for
both chat and Agent. No account API Key was used for this audit.

The documentation discovery URL now points to the `.txt` index. The index
contents and its 87 linked image/video pages are unchanged in membership.
Fetched all 87 pages and compared with October 10, ignoring trailing
whitespace only: 85 pages match; the two changes are described below.

## Changes

- Nano Banana 2.1 Ext now supports all 14 ratios at 1K, 2K and 4K according
  to the official document. Remove the old 1K-only restriction for 1:4,
  4:1, 1:8 and 8:1 in both backend validation and frontend controls.
  Preserve one output for Ext, 1-4 for official, and existing file limits.
- Add `gemini-4-argon` to the built-in chat fallback catalog. Keep the
  existing general chat request and model-family grouping behavior.
- Kling v3 now explicitly requires at least one `image_urls` image when
  using `element_list`; element images alone cannot replace the first
  frame. The app does not expose or forward `element_list`, so no change
  is needed to its existing first-frame / first-and-last-frame requests.
  This audit does not claim to add subject-element controls.
- Retain 46 image choices and 52 active video choices. Chat fallback now
  contains 168 IDs. Preserve historical compatibility rules and records.
- Bump host version and frontend cache identifiers to 1.0.106.
- No new price is inferred from marketplace entry splitting. Existing
  live pricing refresh and offline snapshots remain unchanged.

## Verification

- `npm run check`, including every Nano Banana 2.1 official/Ext ratio and
  resolution combination, output counts and updated required chat model.
- `npm run lan-client:check`.
- Isolated Electron/Chromium form tests: preserve all four extreme ratios
  at 1K/2K/4K when switching to Ext, keep single output, and restore other
  model controls correctly.
- `git diff --check`.
- No paid generation calls, production data edits or live app restart.
  Account-specific access and end-to-end generation are not verified.

Raw official source snapshots are stored outside the release tree in
`outputs/apimart-audit-20261019`.
