# APIMart Model Catalog Audit - 2026-09-12

Target release: 1.0.97. Existing model IDs and saved tasks are preserved.

## Sources

- [Official documentation index](https://docs.apimart.ai/_llms/cn/api.md)
- [Public model marketplace](https://api.apimart.ai/api/marketplace/models)
- [Official pricing](https://apimart.ai/zh/pricing)
- [GPT Image 2.5 Ext](https://docs.apimart.ai/cn/api-reference/images/gpt-image-2.5-ext/generation)
- [Seedance 2.5](https://docs.apimart.ai/cn/api-reference/videos/seedance-2-5/generation)
- [Grok video](https://docs.apimart.ai/cn/api-reference/videos/grok-imagine/generation)

83 image/video documentation pages were fetched. The review compared family IDs,
duration/resolution fields, output counts and reference limits with application
rules. Public marketplace families are not a count of individual model variants.
No user credentials were needed for this audit.

## Updates

- Image picker: 40 entries. Add Ext Flare and Ext Sunburst. Both use
  POST /v1/images/generations with model=gpt-image-2.5-ext and the corresponding
  version. gpt-image-2.5-ext-sunburst is an application-only selection ID, never an
  upstream model ID. Existing non-Ext GPT 2.5 variants remain unchanged.
- Ext supports auto plus ten ratios, 1K/2K/4K, 1-4 outputs, and 16 references.
  Do not send custom pixels, quality, background, mask or output-format options.
  Pricing separates version and resolution; current fixed prices are
  0.085/0.14/0.21 Credits per image for 1K/2K/4K for both versions.
- Video picker: 52 variants; no new video family found in this audit.
  Enable Seedance 2.5 1080p in UI and backend. Grok Ext now submits resolution
  instead of quality. Preserve its 6-15 second constraint.
- GPT 1/1.5 official and GPT 2 reference limits: 15, while GPT 2 official and
  GPT 2.5 retain 16.
- Nano Banana (Gemini 2.5) accepts 14 references, 1 output, 1K. Fix the missing
  reference limit that incorrectly rejected image editing.
- Grok 1.5 images accept five references. Grok Image 2.0 uses low/medium quality
  for text-only requests and omits quality for image editing.
- Wan 2.7 Pro image editing is limited to 2K; text-only generation retains 4K.
- Add 32 publicly listed recent chat IDs to the fallback catalog. Live chat/Agent
  refresh remains in place; access and availability depend on the platform account.

The Seedream Lite summary omits 4K and the Omni Ext summary omits 360p, but their
detailed parameter sections explicitly support these values. Keep those working
options instead of removing them based only on the short summaries.

## Verification

- npm run check: syntax, picker/backend alignment, request normalization, pricing,
  video rules and existing application regressions.
- scripts/verify-apimart-model-contracts.js adds executable request/payload tests.
- Run scripts/verify-image-model-ui.js with Electron for an isolated hidden
  Chromium test of model switching, valid option lists and restored controls.
- No paid generation requests were submitted. Contract tests and UI checks do
  not establish availability of every model for every API Key.
