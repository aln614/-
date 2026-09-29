# APIMart Model Catalog Audit - 2026-09-29

Release: host 1.0.103. LAN client remains 1.0.56 and loads the host UI.

## Sources

- [Official documentation index](https://docs.apimart.ai/_llms/cn/api.md)
- [Public model marketplace](https://api.apimart.ai/api/marketplace/models?page=1&page_size=100)
- [Seedance 2.5 generation](https://docs.apimart.ai/cn/api-reference/videos/seedance-2-5/generation)
- [Public pricing](https://apimart.ai/zh/pricing)

Fetched both marketplace pages: 195 entries (146 chat, 21 image, 26 video,
2 audio). Marketplace entries can represent multiple callable model variants;
these counts are not the application's picker counts. Fetched all 83 image/video
pages linked by the current documentation index and compared them against the
September 27 snapshot. Ignored table padding/separator formatting only when
reviewing changes; the only substantive media-parameter change is Seedance 2.5
draft mode. No account API Key was used for this audit.

## Changes

- Add `claude-sonnet-5-5` to the chat fallback catalog. There are now 165 fallback
  IDs; AI chat and Agent retain their live marketplace refresh.
- No new image IDs or substantive image-generation parameter changes. All 41
  existing image choices remain, including Seedream 5.0 Flash.
- `sora-2` and `sora-2-pro` are absent from both the current marketplace and the
  documentation index. Remove them from new-task pickers and Agent's supplemental
  choices; retain backend rules and historical records. Absence is not a claim
  that every account's API access has been permanently disabled. There are now
  51 active video picker choices, plus the two retained compatibility rules.
- Seedance 2.5: add a 480p draft checkbox, lock resolution while enabled, and
  restore other models' resolution choices on switching.
- A completed draft's video card offers generation of a 1080p final video.
  Require confirmation of separate billing and explain the seven-day/current
  account requirements. Do not automatically charge for a final video.
- Final submission sends the APIMart draft task ID and output options only. It
  must not resend inherited prompts, media, duration, seed, ratio, or audio
  settings, including program-generated defaults. Validate before uploads or
  batch expansion. Preserve draft metadata and protect against repeated clicks.
- APIMart remains authoritative for draft age, ownership, completion and route
  availability. No local-only check claims to guarantee upstream acceptance.

## Pricing

The fetched pricing HTML did not contain parseable model prices during this
audit. The existing parser rejects empty live catalogs and retains its fallback;
no prices were overwritten with empty data. The public Seedream Flash pricing
endpoint still provides a single default rate, not a resolution-dependent
contract that resolves the earlier documentation discrepancy. Preserve its
unverified-price warning. No new fixed rate was inferred for draft conversion.

## Verification

- `npm run check`, including the new Seedance draft regression suite.
- `npm run lan-client:check`.
- Hidden Electron image and video picker tests: model switching, 480p constraint,
  restoration, removed-model filtering, final action, desktop/narrow text fit.
- Execute real local video batch/task assembly with mocked uploads and APIMart:
  normal generation, draft generation, exact final payload, invalid-input early
  rejection, confirmation cancellation and duplicate-click protection.
- No paid image/video generation, production data edits or live app restart.

Raw source snapshots and test screenshots are stored outside the release tree
in `outputs/apimart-audit-20260929` and
`outputs/model-catalog-verification-20260929` respectively.
