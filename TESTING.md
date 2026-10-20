# Latest local verification — 20 October 2026, 13:05 UTC

Planned release tag: `evaluation/harness-20261020-prefreeze-format`. The complete seven-step local gate passed: strict TypeScript, **185 tests**, Activity and Monitoring browser fixtures, real offline Cargo fail-to-pass, real OpenCode with a local scripted endpoint, and local mocked publisher/reconciliation. All seven exit codes are zero in `state/implementation-20261020/state/verification/2026-10-20T13-05-20.149Z/results.json` in the primary project workspace. Production dependency audit found no known vulnerabilities. Deployment tests and doctor checks for this release are **pending**, so the local gate does not establish deployment readiness.

The controller now preserves the exact submitted reproduction source/answer/inventory, runs trusted guarded formatting and requires canonical `cargo fmt --check` success **before** computing frozen test hashes or running baseline repetitions. New integration files freeze the formatted whole-file bytes. The real Cargo fixture deliberately submits unformatted integration Rust without an agent format call and verifies preserved raw submission, formatted freeze, three baseline repetitions and final formatting success. Eight added pipeline cases cover hash binding, protected/failed/nonconverging formatting, snapshot and initial-inventory read failures, and unchanged postfreeze protection. A failed evidence capture stops without resetting the submitted draft; later formatting cannot waive frozen hashes.

## Previous recorded deployment — 20 October 2026, 11:12 UTC

Implementation commit: `df16d12cf6606a066d2f8aefbf78e00f42d17daf`. The complete seven-step local gate passed: strict TypeScript, **177 tests**, Activity and Monitoring browser fixtures, real offline Cargo fail-to-pass, real OpenCode with a local scripted endpoint, and local mocked publisher/reconciliation. All seven exit codes are zero in `state/implementation-20261020/state/verification/2026-10-20T11-09-42.465Z/results.json` in the primary project workspace. The deployed controller separately passed 177/177 (`state/recovery-history-deployed-tests.log`) and doctor checks (`state/recovery-history-deployed-doctor.log`). These are dated results, not a claim that the moving upstream branch or every platform is ready.

The selected live baseline is RTK `6c1af5fbc7729fd56288f1dc811e509b2fa6ae99`, tree `6bd6188f8ca745b9faef6600500f4614f99f705b`. Readiness is checked for the exact fetched commit, recorded toolchain/image and profile; a previous successful run or doctor result does not waive baseline preparation. Current default Rust 1.99.1 matches `.env.example` and `src/config.ts`; earlier Rust/default/readiness observations below retain their original dates.

## Evaluation scope and remaining work

- Historical fixed-source evaluation ran 32 distinct cases on baseline/original/corrected variants, totaling 96 executions: 66 passes and 30 expected assertion failures. Original incomplete #3980/#4662 candidates fail their matrices; corrected trees pass. Evidence: `state/historical-evaluation-20261020/b7f0236d78/results.json` and `state/historical-evaluation-20261020.md` in the primary workspace. This is targeted behavior validation, not a full-suite or model-success-rate measurement.
- Scripted text and graph Cargo workflows and the real OpenCode/local-provider adapter validate harness paths without live model inference. They are not end-to-end model/retrieval comparisons.
- Four separate Ultra/Lightning critique calls have n=1 per model/fixture. The stronger supplied fixture was later shown to have a weak timing positive control; the corrected local oracle was not submitted. No ranking, specificity or clean positive/negative discriminator is established. Evidence: `state/live-evaluation-20261020/critique-comparison/report.md`.
- The approved identical-task/environment/gate **end-to-end Ultra/Lightning and graph/text repair comparison is still unperformed**. All four prepared cell IDs remain unassigned; runtime/image pins must be revised before the first cell after this new release. At the 20 October 2026, 13:05 UTC snapshot, harder #4618 had not started. All 14 plan items and all three live evaluations were not complete. Censored diagnostics remain separate from incorrect fixes and completed workflows.
- Medium Ultra `20261020111217-b44f6be5` was operator-cancelled at **12:56:39 UTC**, after 429 tools and 21,615,264 reported tokens, with no verified tree/commit or PR. Its third baseline established two expected bug failures and one passing control three times. The critic approved coverage despite missing invocation-count/usability assertions. A later candidate passed generated tests and had valid named proof, but formatting required changing frozen unformatted integration bytes. The controller correctly rejected that postfreeze edit; allowing the earlier unformatted freeze was the harness defect addressed by this release. Preserve the cancelled original and raw rejected candidate as a censored diagnostic, not an autonomous failure or retrospectively repaired result. Evidence: `state/live-evaluation-20261020/medium-4596-format-conflict-20261020111217-b44f6be5/` and `state/live-evaluation-20261020/medium-4596-diagnostic-20261020111217-b44f6be5.md`.
- Original easy PR #4682 passed its configured local checks, but independent review found two introduced timing regressions. Its saved upstream CI observation is unknown because the only job was skipped. Passing local gates does not mean all issue behavior is correct or that upstream CI ran. Evidence: `state/live-evaluation-20261020/easy-3530-proof-retry/review.md`.

There is no total tool/token/run-time budget. Per-command and per-request limits, six reproduction attempts, permanent error handling, unchanged-candidate verdicts and recurring recovery diagnoses still produce terminal outcomes. The original records and earlier counts below are preserved as history; use the latest dated record above for the current release.

## Earlier release checkpoint — 20 October 2026, 07:31 UTC

At this earlier checkpoint the full release gate passed with 97 tests after the controller boundary regression for discovery/path/test-field diagnostics; the deployed controller also passed 97/97. Evidence: `state/implementation-20261020/state/verification/2026-10-20T07-31-12.563Z/` and root `state/deployed-tests-final-20261020.log`. The restarted easy run was `20261020073241-dc61a92c`. Its supplied acceptance matrix was unchanged; explicit NVIDIA sampling/thinking and corrected discovery distinguished it from the cancelled pilot, so their timing was not a controlled single-variable comparison.

# Follow-up verification — 20 October 2026

The complete release gate passes with 96 tests after live-pilot feedback: filtered canonical test discovery and no-match suggestions, stable independent-verdict diagnosis, explicit NVIDIA sampling/thinking settings, and honoring provider Retry-After values. Artifact: `state/implementation-20261020/state/verification/2026-10-20T07-26-55.418Z/`. The first live pilot is preserved as cancelled after a confirmed discovery-catalog truncation defect; it produced no repair or PR. Primary live runs are restarted on this corrected version.

# Verification record — 20 October 2026

The complete local `pnpm verify` release gate passed after the reliability improvements: strict TypeScript, 91 automated tests, Activity scroll and 100,000-event history browser fixtures, real Cargo unit/CLI fail-to-pass in fresh containers, real OpenCode against a local scripted provider, and publisher bundle/push/reconciliation against a mocked GitHub CLI and a local bare remote. The publisher fixture updates mock state inside the VM to avoid host/9p rename-cache artifacts. No live provider or GitHub write occurs in this gate.

Evidence: `state/implementation-20261020/state/verification/2026-10-20T07-08-15.868Z/results.json`. Text and graph Docker workflows both passed. `pnpm audit --prod` found no known vulnerabilities. Historical records below describe their original dates and must not be read as current configuration or readiness. Actual historical matrices also rejected the two original incomplete candidates and accepted their corrected commits: heredocs16/20 versus20/20, AWS2/12 versus12/12. These targeted results are not a fullsuite rerun. Live three-issue evaluation is recorded separately after deployment.

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
