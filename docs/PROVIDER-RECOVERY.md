# NVIDIA compatibility and provider recovery

## Observed Ultra incompatibility — 21 October 2026

Controlled live requests to `https://integrate.api.nvidia.com/v1/` established:

- Ultra with high effort, thinking enabled and numeric `reasoning_budget=16384` returned an internal-error 500 inside an HTTP 200 stream. Repeated controls reproduced it.
- Omitting only `reasoning_budget` produced a successful streamed response with reasoning output.
- A non-streaming request with the budget returned the exact NVIDIA V2 runner error stating that `thinking_token_budget` is unsupported.

This identifies a current endpoint compatibility problem. It does not establish that every future NVIDIA 500 has the same cause. The public API specification advertises the parameter; observed runner support takes precedence over that assumption.

## Capability policy

The gateway removes a budget only after the exact known incompatibility error, before meaningful output. It never removes parameters merely because a generic 500 occurred. Thinking, effort, temperature, top-p and output limits stay in the effective request.

Validated observations are stored in private `state/provider-capabilities.json`, keyed by exact HTTPS endpoint and model. The file contains the reason and observation timestamp, with no key, prompt or response body. It survives controller restarts. Unsupported observations remain until explicitly revalidated; an endpoint upgrade should be tested while idle before removing only the matching entry. Preserve a backup before changing capability state.

Requested and effective settings, omission provenance and `answerReserve: unavailable` are recorded per request. Omitting this unsupported control keeps thinking enabled, but the controller cannot enforce a separate thinking-versus-final-answer token allocation.

## Error and retry policy

- HTTP transport status is separate from semantic generation success. HTTP 200 structured JSON/SSE errors are failures.
- Stream framing handles UTF-8 chunk boundaries, CRLF and multiline data. Error messages are canonicalized so arbitrary provider echoes do not enter diagnostic metadata.
- An explicit stream completion ends the logical generation without requiring the remote connection to remain open or close normally afterward.
- The gateway owns transient HTTP/network recovery: at most four consecutive attempts per logical request, honoring Retry-After and sharing known cooldown across requests for the same endpoint/account.
- Three identical failed logical generations without usable output open a run-specific circuit. A nonretryable failure or failure after delivered output stops immediately. The SDK cannot continue making outbound attempts after that circuit opens.
- The controller also stops recurring OpenCode provider failures without source or usable tool progress. Source, candidate and diagnostic evidence are preserved.
- Productive repairs have no total token, tool, turn or elapsed-time budget. Failure recovery limits do not change NVIDIA's quota.
- Safe attempt metadata includes status, timing, retry owner, request ID (including `nvcf-reqid`) and allowlisted rate headers. Unknown usage stays unknown.

`transportComplete` describes observed HTTP-body completion; `semanticComplete` describes a completed generation. On explicit `[DONE]`, the gateway may close the upstream body itself, so semantic completion need not imply observed transport EOF.

## Validation boundaries

Local regression tests exercise errors, partial streams, cache reload/isolation, cooldown, privacy and recovery. The adapter gate uses the real pinned OpenCode container with a scripted provider. That gate is not a live NVIDIA test.

Opt-in live checks must additionally verify actual streaming parameters, a valid answer or tool call, its follow-up response, usage and finish metadata. A small successful request does not establish maximum context behavior or issue repair quality. Long-context retrieval and the medium coding task are separately recorded in the primary workspace's `state/nemotron-validation-20261021/` evidence.

The production default remains context 262144, working input 196608, critical output 24576 and compaction reserve 8192. Direct API research can request output 32768 and test larger catalog context capacities without changing those application settings.
