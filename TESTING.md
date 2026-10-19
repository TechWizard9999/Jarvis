# Verification record — 19 October 2026 (this repository)

Local checks after the RTK hardening (no live NVIDIA call, no GitHub write):

- All four images build: worker = Rust 1.99.1 on Debian trixie with git 2.56.0 (checksum-pinned) and jq; OpenCode; publisher; controller.
- `pnpm check` (strict TypeScript) passes; `node --test tests/*.test.ts`: 29/29 pass, including crate-path regressions in submodules, `skipTests`, and the model gateway's 429/5xx retries.
- `scripts/e2e.ts` (real Docker/Cargo/Git, scripted agent): `verified_patch` with fail-to-pass in independent containers, and an honest `cannot_reproduce`.
- `scripts/adapter-e2e.ts`: real OpenCode with a local scripted model endpoint passes.
- `scripts/publisher-e2e.ts` (mocked `gh`, local bare remote): passes, including a competing linked PR disclosed in the draft body instead of blocking, and rejection of `--slurp` (absent from the image's gh 2.23).
- Full RTK `develop` baseline (`e542dca0`) in the read-only sandbox: fmt, workspace Clippy, workspace tests, no-default-features Clippy/tests and docs all pass with one documented skip (see `profiles/rtk.json`).
- Live runs against rtk-ai/rtk#4644 with `nvidia/nemotron-3-ultra-550b-a55b` consistently identified the root cause (an explicit Claude `ask` rule is bypassed because `rtk hook claude` rewrites the command) and one run froze a failing regression; the run-stopping causes found along the way are fixed (see the README's "What can stop a run").
- Dashboard: a 6,400-event run renders in about 2 s with no long tasks (previously the page never finished rendering).

The record below is the original author's, kept for history; its paths refer to their machine.

# Verification record — 18 October 2026

The application plumbing passed the checks below. **A live NVIDIA-generated repair of a real RTK issue and a real GitHub draft PR have not been verified.** Credentials/model configuration are missing, and the currently cloned RTK baseline fails Clippy before repair.

## Passed application checks

- Docker Desktop/Engine is running on Apple Silicon: engine 29.8.2. All four application images built successfully.
- TypeScript strict checking passed. Python setup/preparation and shell launcher syntax passed.
- All **26 automated tests passed inside the controller container**: Git worktree/patch integrity, regression freezing, existing-test protection, snapshot review policy, traversal/symlink rejection, tool filtering, HTTP authentication, origin checks, durable event ordering/replay, restart recovery and early configuration failures. See `state/recheck-unit-tests.log`.
- The Docker repair integration used a **scripted agent with a small Rust fixture**, real Graphify, Cargo, Git and independent containers. Query/explain/path worked before edits; graph use was rejected after edits; scoped text fallback worked. A new test failed for the intended assertion three times, then passed with the fix. A separate baseline-plus-test container reproduced the failure. The final candidate passed its focused test and six configured final checks. The original checkout remained unchanged. A separate refusal case ended as `cannot_reproduce`.
- The actual OpenCode 1.19.3 container used a **custom provider name**, the generated config, real custom tool execution, controller bridge, allowlisted outbound requests and streaming completions. The upstream endpoint was a **local scripted SSE provider**, not NVIDIA. No key was sent to NVIDIA.
- The production publisher container verified a real bundle and pushed to a local bare Git remote. With GitHub CLI responses **mocked and networking disabled**, it used an alternate repository and `main` base, completed normal creation/readback, recovered from an uncertain creation without a duplicate, and rejected a changed PR head and a mismatched bundle. No real GitHub branch or PR was created.
- Chrome exercised dashboard authentication, live/replayed events, labelled demo, accurate stage completion, diff/report views, setup checks and desktop/mobile layout. No JavaScript errors were observed. Screenshots are `.cache/dashboard-desktop.png` and `.cache/dashboard-mobile.png`.

## Evidence locations

- Repair run: `20261018105436-7de6f3ab`; refusal: `20261018105446-7fb989d8`.
- Repair evidence: `/Users/sdachepally/Documents/Automation/state/integration/9e47497f78/state/runs/20261018105436-7de6f3ab/`.
- Verified fixture commit: `3175f2201a44ca33cd139913808b51dde0f75d41`.
- Actual worker compiler recorded by the run: `rustc 1.91.0 (f8297e351 2025-10-28)`; Graphify: `0.9.92`.
- Machine-readable summaries: `state/integration-results.json`, `state/adapter-results.json`, `state/publisher-results.json`, `state/browser-results.json`, `state/graph-results.json`, `state/readiness-results.json`.
- Publication test evidence: `/Users/sdachepally/Documents/Automation/state/publisher-integration/fe3b437e6e`.

These local runtime files are intentionally ignored by Git. Reports contain test evidence, not credentials.

## Real RTK readiness

The clone is at `repos/rtk`, commit `e542dca0bdcc262fa035dcf7fc33910cdcc8cdaf`. Its original tracked files remained clean.

Graphify extraction succeeded on that clone. Three probes returned source citations and EXTRACTED edges:

- `filter_status_with_args`: `src/cmds/git/git_cmd.rs:2450`, with caller/test relationships.
- `src_lib_commands`: `Commands` at `src/lib.rs:182`, with command-type references. The plain name was ambiguous; using its returned node ID resolved it. Recognition of this derive-decorated enum does not establish coverage of generated macro bodies.
- `NoFilter`: `src/core/filter.rs:149`, including the `FilterStrategy` implementation and `.filter()` method.

The trusted baseline ran `cargo fetch --locked` before disabling network. Formatting passed. Offline workspace Clippy failed on a **pre-existing duplicated attribute** at `src/llm_proxy.rs:401`, also present at line 396:

```text
error: duplicated attribute
#[cfg(feature = "engine")]
-D clippy::duplicated-attributes implied by -D warnings
```

The subsequent baseline tests/docs were **not run**, since Clippy stopped preparation. See `state/recheck-readiness.log` and the evidence path recorded in `state/readiness-results.json`. The application treats this as an environment/baseline blocker and does not weaken the check or ask a model to repair an unrelated issue.

## Remaining live acceptance check

1. Set the existing provider/model ID, compatible context/output limits, fork and author in `.env`.
2. Put the NVIDIA key and GitHub publishing token into the private `.secrets/` files locally. They are currently empty. Host OpenCode/gh credentials are not implicitly imported.
3. Select an actionable real issue against an upstream contribution base that passes the profile. Historical evaluation can use an inspected earlier commit and cannot publish.
4. Run `./bugfix doctor`, then submit the real issue with draft publication enabled. Inspect the generated report, independent check evidence and the actual draft PR URL before treating the live acceptance test as passed.

## Reproduce developer checks

Normal application usage needs Docker, Git, Python 3 and a browser. The optional host integration scripts additionally need Node 24+ and a Docker CLI; the browser script needs Playwright and installed Chrome. Set `BUGFIX_DOCKER` if Docker is not on PATH. The browser script accepts `BUGFIX_PLAYWRIGHT_MODULE` for an existing external module installation.

```sh
./bugfix build
./bugfix up
./bugfix test
pnpm check
BUGFIX_E2E_GRAPH=1 node scripts/e2e.ts
node scripts/adapter-e2e.ts
node scripts/publisher-e2e.ts
node scripts/readiness.ts --baseline
node scripts/browser-e2e.mjs
```

The readiness command currently returns nonzero for the recorded RTK Clippy failure. The other integration commands distinguish their scripted/mocked components explicitly in their output.

## Latest recheck

18 October 2026, 16:27 IST: rebuilt all images, reran all 26 packaged tests, strict type checking and setup/launcher syntax checks. Repeated the Graphify/Docker/Cargo/Git repair, real OpenCode adapter, browser, and publisher checks. Added publisher test coverage for normal draft-response readback and rejecting a mismatched bundle before PR creation. All application checks passed. No production behavior was changed in this recheck.

Repeated the actual RTK baseline: formatting and all three graph probes passed; workspace Clippy still failed on the existing duplicate attributes, so subsequent baseline checks were not run. Credential/model/publishing configuration remains incomplete. Only the healthy dashboard container remains running. No live NVIDIA call or real GitHub write was made.

The consolidated machine-readable record is `state/recheck-results.json`; individual logs are `state/recheck-*.log`.
