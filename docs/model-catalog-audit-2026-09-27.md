# APIMart Model Catalog Audit - 2026-09-27

Release: host 1.0.101. LAN client remains 1.0.56 and loads the updated host UI.

## Sources

- [Documentation index](https://docs.apimart.ai/_llms/cn/api.md)
- [Public marketplace](https://api.apimart.ai/api/marketplace/models?page=1&page_size=100)
- [Seedream 5.0 Flash](https://docs.apimart.ai/cn/api-reference/images/seedream-5-0-flash/generation)
- [GPT Image 2.5](https://docs.apimart.ai/cn/api-reference/images/gpt-image-2.5/generation)
- [Pricing](https://apimart.ai/zh/pricing)
- [Flash model price](https://api.apimart.ai/api/pricing/model?model=seedream-5-0-flash)

Fetched all 84 image/video pages linked from the documentation index and both
marketplace pages (196 entries). Compared with the September 18 audit: one new
image page, one changed image page, four new chat IDs, no removed marketplace
IDs, and no changed video documentation. No account API Key was used.

## Model Changes

- Add seedream-5-0-flash to backend, homepage, settings and Agent image choices.
  Use /v1/images/generations and existing asynchronous task polling.
  Text-to-image and reference editing accept up to 10 references, one output,
  1K (default), 1.5K or 2K, JPEG/PNG, watermark and standard prompt optimization.
  Limit preset sizes to auto plus the ten documented ratios. Custom sizes
  require 921600-4624220 pixels and aspect ratio 1:16-16:1.
- Flash controls exclude unsupported 3K/4K, WebP and compression. Restore other
  models' options when leaving Flash. Do not redirect the existing Pro alias,
  despite the ambiguous alias listed on the Flash page.
- Add mask_url forwarding for gpt-image-2.5-flare and gpt-image-2.5-sunburst when
  input images exist. Keep GPT Image 2.5 Ext's restricted payload unchanged.
  This is parameter support through existing configuration, not a new mask UI.
  The caller must supply a matching alpha PNG mask as required by APIMart.
- Add gpt-6-sol, gpt-6-luna, claude-opus-5-5 and grok-4.7 to the offline chat
  fallback. Live public-catalog refresh remains enabled for AI chat and Agent.
- Image picker: 41 models. Video: 53 backend-supported choices, unchanged.
  Chat fallback: 164 IDs. Existing aliases and saved task IDs are retained.

## Pricing And Scope

Flash's pricing page publishes only a default display price (0.137144 Credits),
whereas its generation document describes different resolution-dependent USD
rates and reference-image charges. These sources do not establish a consistent
per-configuration price. Mark pricing as unverified and do not estimate a fixed
remaining-use count; preserve that warning through a live price refresh.

The update adds the standard generation/editing workflow. Flash's optional
layer decomposition and alpha-preserving workflow do not receive new UI here.
No video model or parameter was changed merely to make the catalog look newer.

## Verification

- npm run check: model alignment, payload contracts, pricing, and the existing
  task/status/storage/download/shortcut/asset/update regression suite.
- npm run lan-client:check.
- Electron scripts/verify-image-model-ui.js: real Chromium controls, model
  switching, unsupported settings, option restoration and output count.
- Tests run without paid generation calls. They verify local contracts, not
  account-specific model availability or generation success.
- No production output directory, asset index or running app was modified.
