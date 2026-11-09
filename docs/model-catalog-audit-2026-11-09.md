# APIMart Model Catalog Audit - 2026-11-09

Release: host 1.0.142. LAN client stays at 1.0.65 because it loads the
host renderer; this update changes no native client functionality.

## Sources

- [Documentation index](https://docs.apimart.ai/llms.txt)
- [Chinese API index](https://docs.apimart.ai/_llms/zh-hans/api.txt)
- Public marketplace: [page 1](https://api.apimart.ai/api/marketplace/models?page=1&page_size=100), [page 2](https://api.apimart.ai/api/marketplace/models?page=2&page_size=100), [page 3](https://api.apimart.ai/api/marketplace/models?page=3&page_size=100).
- [GPT Image 2.6 Ext](https://docs.apimart.ai/cn/api-reference/images/gpt-image-2.6-ext/generation)
- [HY Image 3.5](https://docs.apimart.ai/cn/api-reference/images/hy-image-v3.5-preview/generation)
- [Muse Image](https://docs.apimart.ai/cn/api-reference/images/muse-image-ext/generation)
- [Kling V4](https://docs.apimart.ai/cn/api-reference/videos/kling-v4/generation)
- [Kling V4 Flash](https://docs.apimart.ai/cn/api-reference/videos/kling-v4-flash/generation)
- [Omni 1.2](https://docs.apimart.ai/cn/api-reference/videos/gemini-omni-1.2-flash/generation)
- [Omni 1.2 Ext](https://docs.apimart.ai/cn/api-reference/videos/gemini-omni-1.2-flash-ext/generation)
- [Muse Video](https://docs.apimart.ai/cn/api-reference/videos/muse-video-ext/generation)
- Public per-model prices: `https://api.apimart.ai/api/pricing/model?model=<model-id>`.

Fetched three marketplace pages: 217 grouped entries (39 image, 50 video,
126 chat, 2 audio). Grouped entries are not selectable variant counts.
Fetched the 98 image/video documentation pages linked by the API index.
No account API Key was used to retrieve catalog or price information.

## Changes

- Add six image choices: GPT Image 2.6 Flare/Sunburst, GPT Image 2.6 Ext
  Flare/Sunburst, HY Image 3.5 Preview, and Muse Image Ext. Total: 53.
- Preserve the Ext Sunburst selector as an alias for `gpt-image-2.6-ext`
  with `version: sunburst`. Ext outputs one image, with 1K/2K/4K fixed
  pricing, six quality settings, and PNG/JPEG/WebP output. The normal
  Flare/Sunburst routes support up to four images and token billing.
- This release integrates static raster generation/editing. It does not
  add the new GPT SVG/GIF/markup UI or Muse marketing generation modes.
- HY supports five references and validated custom pixel dimensions.
  Muse Image has automatic dimensions, one WebP output, and nine
  references totaling at most 11MiB. Omit its automatic aspect field.
- Add five video choices: Kling V4/V4 Flash, Gemini Omni 1.2 Flash/Ext,
  and Muse Video Ext. Total: 58 active video choices, with 60 backend
  rules including two historical, non-selectable Sora entries.
- Kling V4 supports 3-30 seconds; Flash supports 3-20 seconds at 720p
  and no last frame. Single-video editing sends an explicit edit type,
  omits requested duration/aspect, and follows the source. Multivideo,
  audio-reference and extension controls for these new models are not
  introduced in this release.
- Omni 1.2 supports 3-15 seconds, 360p through 4K, and up to ten images.
  First/last frames cap at ten seconds. Ext editing cannot mix images
  with video, and must not send duration. Prompts remain required.
- Muse Video is reference-only, not first/last-frame control: fixed
  approximately ten seconds at 720p with audio, up to nine images and
  11MiB total. Disable incompatible modes and multiple-first-frame UI.
- Update fixed-price fallbacks and Ext version mapping. Kling V4 edits
  use the video-input tier and rounded input-plus-output billing seconds.
  Official Omni 1.2 documents token billing despite public per-second
  pricing; do not publish an exact available-generation count.
- Add `gpt-6.1-terra` and `deepseek-v4.1-flash` to the chat fallback
  catalog (170 IDs). Existing live refresh remains unchanged.
- Bump host version and renderer cache identifiers to 1.0.142. Retain
  existing glass styling and native window behavior.

## Verification

- `npm run check`, including the new November contract test: payloads,
  aliases, quality/resolution variants, reference counts and size limits,
  video editing, first/last-frame restrictions and price safeguards.
- `npm run lan-client:check`.
- Isolated Electron host and headless browser form tests: all new
  choices, HY custom dimensions, switching models/modes, audio locks,
  Ext pricing and dynamic billing. Screenshots captured separately.
- No paid generation requests; upstream output quality and account-level
  access are not validated by mocked submission tests.
