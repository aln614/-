# Agent Live Replies - 1.0.102

## Cause

The Agent requested streaming chat completions, but its event callback only
updated the thinking badge. Text was assigned after the whole tool loop
finished. Its unused incremental renderer also replaced the entire bubble,
which would remove generation result cards and their preview handlers.

## Changes

- Extract and display only public message/content fields from partial Agent
  JSON. Never execute a partial directive or expose nested tool arguments.
  Keep compatibility with plain-text replies and fenced JSON.
- Request a short user-facing action description before tool arguments.
  Display waiting/replying/executing states and elapsed whole seconds, without
  exposing reasoning content or inventing progress percentages.
- Render text/status separately from image/video results. Update the specific
  message rather than whichever assistant bubble happens to be last.
  Coalesce paints to 50ms and retain the user's scroll position during updates.
- Wait for initial history hydration before creating a live reply. Reopening
  the Agent during execution does not reload its history over active messages.
  Save public action text between steps, not once per token/NAS write.
- Keep partial text on errors. Persisted messages do not keep stale live flags.
- Preserve UTF-8 across upstream chunks; accept non-stream JSON fallback text.
  Surface empty/upstream-error replies, keep SSE alive, release readers and
  terminate upstream work on client disconnect. Do not replay a request on a
  second proxy after text has already been delivered.

## Verification

- npm run check, including scripts/verify-agent-stream.js.
- npm run lan-client:check.
- Electron scripts/verify-agent-stream-ui.js: actual DOM updates before
  completion, window close/reopen, tool-call timing, preserved preview button
  identity/listeners, wide/narrow layouts and screenshots.
- Mock upstream and isolated local UI only. No paid generation/chat requests,
  production data modifications, or restart of the user's running application.

Model-side latency and gateways that return a buffered reply cannot be made
token-streaming by the client. They now show an explicit waiting state, then
display received content immediately.
