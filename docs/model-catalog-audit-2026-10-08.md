# APIMart Model Catalog Audit - 2026-10-08

Release: host 1.0.104. LAN client remains 1.0.56 and loads the host UI.

## Sources

- [Official documentation index](https://docs.apimart.ai/_llms/cn/api.md)
- [Public model marketplace, page 1](https://api.apimart.ai/api/marketplace/models?page=1&page_size=100)
- [Public model marketplace, page 2](https://api.apimart.ai/api/marketplace/models?page=2&page_size=100)

Fetched both marketplace pages: 196 entries (147 chat, 21 image, 26 video,
2 audio). Marketplace entries can represent multiple callable model variants;
these counts are not the application's picker counts. Compared all entries
against the September 29 snapshot: one added chat model and no removed IDs.
No account API Key was used for this audit.

The official documentation index is unchanged. Fetched all 83 linked image/video
Markdown pages and compared them against September 29. After removing only the
new Mintlify attribution footer and trailing whitespace, all 83 pages match.
There are no observed media-generation parameter changes in those sources.

## Changes

- Add `gpt-6.1-sol` to the chat fallback catalog. There are now 166 fallback
  IDs; AI chat and Agent retain their live marketplace refresh.
- Keep all 41 image choices and 51 active video picker choices unchanged.
  Preserve the existing compatibility rules and historical model records.
- No pricing changes are inferred from the new model listing.
- Bump the host version and frontend cache identifiers to 1.0.104.

## Verification

- `npm run check`, including the updated required-model regression assertion.
- `npm run lan-client:check`.
- `git diff --check`.
- No paid generation calls, production data edits or live app restart.

Raw official source snapshots are stored outside the release tree in
`outputs/apimart-audit-20261008`.
