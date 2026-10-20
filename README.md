# RTK Bugfix Agent

A local application for investigating a selected RTK issue, reproducing it in Docker, generating a small change through OpenCode + your NVIDIA model, independently verifying it, and publishing a draft PR. The original checkout's files are preserved. New branches/worktree metadata are application-managed.

For host requirements and step-by-step installation, configuration, startup, and troubleshooting, see [SETUP.md](SETUP.md).

## One command: issue → root cause → verified fix → draft PR

On a new machine (macOS + Docker Desktop running, Git, Python 3):

```sh
git clone https://github.com/TechWizard9999/Jarvis.git && cd Jarvis
./bugfix setup                 # creates .env (from .env.example), .secrets/, repos/, state/
./bugfix clone                 # clones rtk-ai/rtk (develop) into repos/rtk
# Put your own credentials into the private files (never commit or paste them):
#   .secrets/nvidia_api_key  — NVIDIA API key (build.nvidia.com), used only by the controller's gateway
#   .secrets/github_token    — GitHub token that can push to BUGFIX_FORK and open PRs on rtk-ai/rtk
#                              e.g. run in your own terminal: gh auth token > .secrets/github_token
chmod 600 .secrets/*
# Edit .env: BUGFIX_FORK=<your-user>/rtk, BUGFIX_GIT_NAME, BUGFIX_GIT_EMAIL
./bugfix build                 # builds the 4 images (first time takes a while)
./bugfix up                    # starts the controller and prints the private dashboard URL
./bugfix doctor                # every line must be PASS
./bugfix fix https://github.com/rtk-ai/rtk/issues/NUMBER
```

`fix` streams progress and ends by printing the outcome, the root-cause report path (`state/runs/RUN_ID/report.md`) and the **draft PR link**. Add `--no-publish` to stop at a verified local commit; publish it later with `./bugfix publish RUN_ID`.

Shipped defaults in `.env.example` (known working):

| Setting | Value | Why |
|---|---|---|
| `BUGFIX_MODEL` | `nim/nvidia/nemotron-3-ultra-550b-a55b` | NVIDIA Nemotron 3 Ultra; supports tool calls. The first segment (`nim`) is the OpenCode provider name; everything after the first `/` is sent to NVIDIA verbatim, so it must be the full NVIDIA model ID. |
| `BUGFIX_RUST_TOOLCHAIN` | `1.99.1` | Pinned compiler validated with the recorded Linux RTK baseline; upstream CI's `stable` channel can move. Readiness applies to the exact commit/profile/image checked, not every future `develop`. Rebuild the worker (`./bugfix build`) after changing it. |
| (none) | no total token, tool-call or run-time budget | Per-request context/output limits and per-command deadlines still apply. Verification, reproduction verdicts, cancellation, permanent errors and progress diagnoses can end a run as described below. |
| `BUGFIX_MODEL_MAX_OUTPUT` | `16384` | Room for the model's reasoning plus the final answer. |

NVIDIA requests explicitly record temperature `1`, top-p `0.95`, and Nemotron thinking enabled, matching the supplied examples. Lightning also sends `reasoning_budget=16384`. Override with `BUGFIX_MODEL_TEMPERATURE`, `BUGFIX_MODEL_TOP_P`, `BUGFIX_MODEL_THINKING`, and `BUGFIX_REASONING_BUDGET`; these are per-request generation settings, not a total run budget.

**What can stop a run.** Reproduction gets six attempts to establish all frozen requirements, then can end as `cannot_reproduce`. Cancellation, permanent provider/GitHub errors, unsupported scope and failed baseline preparation also stop clearly. Candidate rounds have no total token/tool/time budget. Repeated unchanged candidate failures or `cannot_fix` verdicts produce `needs_attention`. During agent recovery, the third recurrence of the same diagnosis on unchanged source and phase also produces `needs_attention`, even when unrelated checks or diagnoses intervene. Repeated identical check results, including successful formatting, trigger diagnosis. A valid phase answer proceeds to normal controller validation and supersedes pending recovery; source/phase changes reset recovery history. `BUGFIX_MAX_ATTEMPTS` is the number of candidates before a fresh-session round, not a run budget. A controller restart marks unfinished execution `interrupted`; publication failure preserves an already verified result as `verified_unpublished` for explicit retry.

- Acceptance requires 2–12 issue-grounded scenarios, including a failing bug and a passing control. Every citation must match the issue. Use `--acceptance /absolute/path/to/requirements.json` to supply a reviewed matrix; otherwise the model plans it before editing.
- Baseline failures must be deterministic assertion failures three times. Observed assertion messages can be adopted on the first repeat; compile/setup errors and zero matches never count.
- Before freezing, the controller preserves the submitted reproduction source/answer, runs trusted guarded formatting, and checks the formatted revision. Only then are integration files frozen whole. Protected formatting changes are rejected; a later formatter cannot waive frozen bytes.
- Unit and Cargo integration scenarios are protected, then critiqued in a separate fresh model session before patching. This is a second coverage check with the same configured model, not independent human review.
- Candidates must cite existing, current source reads and a passing frozen scenario. Missing, duplicate, stale, unrelated or zero-match evidence is rejected. Final acceptance executes every required scenario and the full configured profile in fresh containers.
- Permanent credentials/model errors stop; true provider rate limits wait using retry information. Reported request usage can be unknown or partial and is never fabricated as zero.

The RTK baseline (fmt, Clippy, workspace tests, no-default-features Clippy/tests, docs) passes in the sandbox only with these worker-environment fixes, all in this repo:

- **git 2.56.0 built from source** in `docker/worker.Dockerfile` (checksum-pinned). RTK's integration tests assert real git output and are verified against current git; Debian's 2.39 fails `guard_integration_test` and 2.47 fails `git_log_cap_notice_test`. **jq** is installed for `hook_decision_protocol_test`.
- **`--init` on worker containers** (`src/docker.ts`). Newer git detaches background processes during RTK's tests; without an init process they become zombies under `sleep infinity` until the pids limit (256) is hit and unrelated tests fail with `Resource temporarily unavailable`.
- **`skipTests` in `profiles/rtk.json`**: one upstream test, `hooks::init::pi::tests::test_global_uninstall_detects_shared_pi_omp_extension`, creates `.omp/` in the crate root, which the read-only source mount forbids by design. It is skipped with a written reason that is printed in every report and PR body. Add entries only for tests that cannot run read-only, never to hide a real failure.

## Quick start

All project files belong in this directory. Host requirements: Docker Desktop/Engine + Compose, Git, Python 3 for setup, and a browser. The controller, Rust/Graphify worker, OpenCode and publisher run in Docker. A local GPU is unnecessary because inference uses your NVIDIA endpoint.

```sh
./bugfix setup
./bugfix clone                   # optional: an existing clone under BUGFIX_REPO_ROOT also works
```

Setup creates `.env`, `.secrets/`, `repos/`, and `state/` without overwriting an existing `.env`. On a Mac with Homebrew, `./bugfix setup --install-docker` installs Docker Desktop if the CLI is absent. Start Docker Desktop and finish its first-run prompts. Setup discovers the active Unix Docker socket; it does not assume `/var/run/docker.sock` exists on macOS.

Edit `.env`:

- `BUGFIX_MODEL`: your **existing** OpenCode `provider/model` ID (e.g. a selected `nvidia/...` ID, not a guessed model name).
- `BUGFIX_FORK`: a personal `YOUR_USER/rtk` fork for publication.
- `BUGFIX_GIT_NAME` / `BUGFIX_GIT_EMAIL`: the actual commit identity.
- `BUGFIX_REPO_ROOT`: parent directory of permitted local clones. This directory and the state directory are mounted at identical host/container paths for Git worktrees.
- `BUGFIX_RUST_TOOLCHAIN`: an explicitly pinned compiler compatible with the selected RTK commit; default `1.99.1`.

Create `.secrets/nvidia_api_key` and `.secrets/github_token` using a local editor or password manager. Each file contains only its token. Set permissions to `600`. Never commit credentials, put them in issue text, or paste them into chat. Host `gh auth login` does not automatically authenticate the controller or publisher containers. The controller uses the GitHub token, when present, to fetch issue data without anonymous API rate limits; draft publication additionally requires fork push and PR permissions. The NVIDIA credential is used only by the trusted model gateway. OpenCode receives a run-scoped gateway token instead of the actual NVIDIA key.

```sh
./bugfix build
./bugfix up
./bugfix doctor
```

Open the authenticated dashboard URL printed by `up`. It includes a private local token; keep it private. `./bugfix demo` runs a **labelled UI simulation**, with no model, repair, verification, or GitHub writes.

```sh
./bugfix run --repo '/absolute/path/to/rtk' \
  --issue 'https://github.com/rtk-ai/rtk/issues/NUMBER' --publish
./bugfix list
./bugfix tail RUN_ID
./bugfix cancel RUN_ID
./bugfix publish RUN_ID            # retry an already verified unpublished commit
./bugfix inspect-pr RUN_ID         # read current remote head, reviews, CI and explicit CLA jobs
./bugfix logs
./bugfix down
```

Live runs fetch the profile's current upstream base (`develop` for RTK) into the existing clone's Git metadata and creates a dedicated branch/worktree there. A supplied live base must match that tip, including runs whose draft is published later. Evaluation mode is explicit, disables publication, and accepts an inspected pre-fix SHA:

```sh
./bugfix run --repo '/absolute/path/to/rtk' --issue 'https://github.com/rtk-ai/rtk/issues/NUMBER' \
  --mode evaluation --base PRE_FIX_SHA --retrieval graph --no-publish
```

Use `--retrieval text` for the comparison control. Historical source copies expose no original `.git`, later history, or model web tools. Use the issue body and approved source documentation; known fixing PRs/comments are not supplied to the model. Training contamination cannot be ruled out by these measures.

## Execution and verification

1. Validate the issue URL, clean local repository, allowed directory and exact base/tree. Reject symlinks/submodules in source for this first implementation.
2. Create a host-visible worktree, then export source files after comparing their Git blob IDs. Only the controller touches shared Git metadata. Worktree separation is not itself sandbox isolation.
3. Fetch locked dependencies with network enabled in a credential-free container. Builds/tests then run with `--network none`. A controller-created baseline image warms the configured check profile once. Cache identity includes the base, lockfile, worker image/toolchain and profile recipe. Every run's image ID is recorded.
4. Build the pinned Graphify code-only index. Use graph query/explain/path first, scoped text fallback second. Preserve extracted/inferred labels. Freeze graph use after the first edit. Execution containers mount source read-only; only the controller's validated edit tool writes it. Cargo output and temporary files use separate writable directories.
5. Freeze the issue acceptance matrix. Add multiple inline unit tests or new `tests/<target>.rs` integration targets. Existing implementation/imports/helpers cannot change during reproduction. Add fixtures only under the configured fixture directory. The controller preserves the submitted draft, applies guarded trusted formatting and requires a passing formatting check before freezing. Every bug scenario must then fail at its intended assertion three times; controls must already pass.
6. Freeze the scenario syntax, attributes, enclosing module gating and fixture contents; new integration files are frozen whole. Preserve existing test-root files, test helpers and macro attributes. Use test discovery, exact replacements with optional content hashes, and trusted offline formatting. Check all acceptance scenarios and fast profile checks before independent verification.
7. Stop the worker. Reconstruct two independent read-only trees: **base + identical regression overlay**, and **base + overlay + fix**. Never compare against a bare base lacking the new test. Start fresh verifier containers from the trusted cache, invalidate workspace outputs, demonstrate fail-to-pass, and run the configured full profile once. Never import agent-produced compiled artifacts.
8. Confirm final content/tree hashes, export a patch including added files, and create a signed-off commit with an empty trusted hooks directory. With `--publish`, push that verified commit to the configured fork and create/read back a draft PR against `develop`.

Full local profile: `cargo fmt --all -- --check`, workspace/all-targets Clippy, workspace tests, no-default-features Clippy/tests, and docs. Cargo resolution commands use `--locked --offline`. This covers the configured Linux build, **not** all upstream platforms, `proxy/`, ignored integrations, security scanning or benchmark jobs. Initial issue scope excludes platform-specific, proxy/daemon, dependency, CI and external-service bugs. Baseline failures are blockers, not silently waived. The profile should be reviewed when changing the pinned RTK version. Baseline readiness is checked for the exact fetched commit; historical failures and later successful environments are recorded separately in [TESTING.md](TESTING.md).

Snapshot exceptions are narrow: declared, module-owned external snapshots or one inline `assert_snapshot!(..., @"expected")` literal change. All such changes are report/PR review flags. Existing fixture edits, arbitrary test changes, deleted/ignored tests, manifests and CI edits are rejected. The new frozen regression expectations can never change.

### OpenCode isolation

Eight custom tools: `graph_query`, `graph_explain`, `graph_path`, `read_source`, `search_text`, `apply_patch`, `replace_source`, `run_check`. Text control mode exposes only the last five. Native tools are deny-by-default in a controller-owned config directory with no repository mounts. The controller's NVIDIA gateway also filters the **actual outbound model tool definitions** to this allowlist and logs the resulting names, rather than trusting instructions alone. It rejects an incompatible tool catalog. Per-command execution timeouts are enforced. There is no total run token/tool/time budget. Request context/output settings still limit each individual model request; provider usage is reported only when supplied.

### Progress and recovery

The dashboard replays sequenced durable events after reconnect. It displays model messages, provider-exposed reasoning only, command output, graph fallbacks, attempt/check results, diff and publication state. A quiet command shows elapsed activity rather than invented progress. Run artifacts are under `state/runs/RUN_ID/`. Each run has `manifest.json`, `events.jsonl`, reproduction/candidate/verification logs, `report.md`, and a patch if produced. Secret/config folders are excluded from artifact downloads.

Outcomes: `verified_patch`, `draft_created`, `verified_unpublished`, `cannot_reproduce`, `environment_blocked`, `verification_failed`, `cancelled`, `interrupted`, `needs_attention`. A UI demonstration uses `demo_complete` and cannot publish. A restarted controller stops orphan execution containers, marks unfinished runs interrupted, preserves evidence, and permits publication retry only for an already verified commit. It does not silently replay model actions. Publication reconciliation checks for an existing matching PR after uncertain requests. Live preflight discloses linked open PRs before model work and requires `--allow-competing` for an alternative run. `inspect-pr` records current remote head/review/CI/CLA observations separately from original verification; unavailable evidence stays unknown. CLA signing, upstream CI and merge remain separate human/upstream steps.

## Development and tests

Node 24+ executes the TypeScript directly. The verification command also needs Docker, Google Chrome, and the declared TypeScript/Playwright development dependencies. Browser tests use the installed Chrome by default; `BUGFIX_BROWSER_CHANNEL` can select another installed Playwright channel. `BUGFIX_PLAYWRIGHT_MODULE` can optionally point to an existing Playwright module.

```sh
pnpm install --ignore-scripts
pnpm verify                    # typecheck, unit, browser, Docker, adapter and publisher contracts
node scripts/e2e.ts
BUGFIX_E2E_GRAPH=1 node scripts/e2e.ts
node scripts/adapter-e2e.ts
node scripts/publisher-e2e.ts
BUGFIX_HISTORICAL_ROOT=/absolute/path/to/Jarvis node scripts/historical-e2e.ts
node scripts/readiness.ts --baseline
```

Unit/integration tests exercise real Git worktrees, new-file patches, protected regressions, path and symlink boundaries, tool filtering, HTTP authentication, cross-origin rejection, event replay and the labelled demo. The Docker E2E uses a **scripted repair driver** with a small Rust fixture, real Cargo fail-to-pass and independent containers. It does not measure NVIDIA performance or claim an actual RTK issue is fixed. `state/integration-results.json` records results when that test completes. A live model/fork run requires configured credentials and a real issue.

The local verification for planned release tag `evaluation/harness-20261020-prefreeze-format` passed all seven gates, including **185 tests**, on 20 October 2026 at `state/implementation-20261020/state/verification/2026-10-20T13-05-20.149Z/results.json` in the primary project workspace. The real Cargo fixture deliberately omits agent formatting and verifies controller normalization before freeze. Deployment tests and doctor checks for this release are pending; the previous deployed release separately passed 177 tests and doctor checks. See [TESTING.md](TESTING.md) for dated evidence and scope.

### Evaluation coverage

Historical evaluation executed 32 fixed behavior cases against baseline, original incomplete and corrected source trees: **96 case executions**, with 66 passes and 30 expected assertion failures. Those targeted offline matrices reject the known incomplete candidates and accept the corrected variants; they are not a full RTK-suite or model-quality comparison. Scripted graph/text Docker workflows exercise retrieval plumbing, not a live retrieval comparison. Four separate Ultra/Lightning acceptance-critique calls used one call per model/fixture; their stronger fixture had an admitted weak positive control, so they do not establish specificity or a model ranking.

The approved same-task, fixed-environment **end-to-end Ultra/Lightning and graph/text repair comparisons remain unperformed**; all four prepared cell IDs are unassigned. Their prestart protocol must be repinned after the formatting release is deployed. Live issue attempts with changing harnesses, operator assistance and cancellations cannot substitute for that comparison. At the 20 October 2026, 13:05 UTC snapshot, medium Ultra `20261020111217-b44f6be5` had been operator-cancelled at 12:56:39 UTC after a confirmed unformatted-frozen-test blocker; it produced no verified commit or PR. This is a censored harness diagnostic, not an autonomous repair verdict. Harder #4618 and the live evaluation plan remain incomplete. Original easy PR #4682 retains two independently found timing regressions and unknown upstream CI.

If Docker reports a missing `docker-credential-desktop`, the launcher adds Docker Desktop's bundled CLI directory to PATH. For memory pressure lower `BUGFIX_CPUS`, keep one build job/run, or adjust Docker Desktop's allocation. Cache and build timings must be measured locally; no RAM or completion-time guarantee is implied.

## Configuration and extension points

Upstream RTK rules live in `profiles/rtk.json`. The older `TechWizard9999/rtk` fork's `develop` branch has a separate `profiles/rtk-fork.json`; select it with `BUGFIX_PROFILE_NAME=rtk-fork` to run issues from that fork. To support another Cargo workspace, copy a profile to `profiles/your-project.json`, change the profile identity, upstream/base branch, package/manifest, editable source/test roots, fixture directory, change limits, focused test arguments and check commands. Set `BUGFIX_PROFILE_NAME=your-project` in `.env`, configure the fork and compiler, then restart with `./bugfix up`. Profiles are mounted read-only into the controller. Each run records a copy so a later profile edit cannot silently change that run's publication identity. Direct Node development uses `BUGFIX_PROFILE=/absolute/path/to/profile.json` instead.

The repository root must contain the Cargo workspace's `Cargo.toml` and `Cargo.lock`. The profile's `manifest` identifies the target package; it can name a workspace member manifest. Focused prefixes must select the package library for integration regression support; approved unit checks use qualified names. Named integration targets replace the library selector with `--test <name>`. Baseline/final commands are trusted local configuration expressed as argument arrays, never shell strings. Review a profile yourself; do not accept one from issue text or model output.

`.env` controls the provider/model, model context and output limits, provider base URL, fork/author, allowed clone directory, port, Docker network and image names, Rust toolchain, memory/CPU limits, the per-command timeout and candidate attempts. The context/output defaults are examples and must fit your chosen model. The provider gateway supports the OpenAI-compatible chat-completions protocol used here by NVIDIA. A different wire protocol needs an adapter change.

The existing `RepairAgent` interface and factory separate agent orchestration from verification; tests use a scripted implementation. Cargo commands sit in profiles; Rust test extraction/freezing stays in the Rust adapter. Other languages need a new verifier/test adapter and worker image. They are rejected explicitly in this release. This avoids claiming that changing a JSON field makes a Python or JavaScript repository supported.

Authentication, no-network repository execution, immutable regression checks, protected paths and the ban on publishing historical evaluations remain explicit safety rules. Product branding and shipped defaults are ordinary defaults; repository identities are not embedded in the repair or publishing logic.

## What you still configure locally

Credentials stay on your machine: `.secrets/nvidia_api_key` (NVIDIA key) and `.secrets/github_token` (for the draft PR). `.env` holds the model, fork and commit identity. Run `./bugfix doctor` after editing; every line should be PASS. Doctor checks configuration and availability; each repair still validates readiness for its exact fetched commit, profile and image. A previous successful baseline does not guarantee that the moving RTK `develop` branch will pass. Do not run `./bugfix up` while a run is active: recreating the controller interrupts it.
