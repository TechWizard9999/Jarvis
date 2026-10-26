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

### Ask the model directly

The controller also exposes the configured model (`BUGFIX_MODEL`, Nemotron by default) for a plain prompt, outside any repair run. It uses the same NVIDIA key, waits out rate limits (429) and retries transient failures like the run gateway, and stores nothing.

```sh
./bugfix ask "Explain what rtk hook claude does in two sentences"
./bugfix ask "Summarise this diff" --system "You are a code reviewer" --reasoning   # also print the model's reasoning
git diff | ./bugfix ask -                                                          # read the prompt from stdin
./bugfix ask "Hello" --json                                                        # full response: answer, reasoning, usage
```

HTTP API (authenticated with the dashboard token in `state/ui-token`):

```sh
curl -s http://localhost:3210/api/chat \
  -H "Authorization: Bearer $(cat state/ui-token)" -H 'content-type: application/json' \
  -d '{"prompt":"What does git push do?","system":"Answer briefly."}'
# → {"model":"nvidia/nemotron-3-ultra-550b-a55b","answer":"…","reasoning":"…","finishReason":"stop","usage":{…}}
```

Body fields: `prompt` (and optional `system`), or `messages` (`[{"role":"system|user|assistant","content":"…"}]`) for a conversation; optional `model` (another NVIDIA model ID), `max_tokens` (capped at `BUGFIX_MODEL_MAX_OUTPUT`) and `temperature`. A provider error (for example an unknown or retired model) returns HTTP 502 with `providerStatus`.

Shipped defaults in `.env.example` (known working):

| Setting | Value | Why |
|---|---|---|
| `BUGFIX_MODEL` | `nim/nvidia/nemotron-3-ultra-550b-a55b` | NVIDIA Nemotron 3 Ultra; supports tool calls. The first segment (`nim`) is the OpenCode provider name; everything after the first `/` is sent to NVIDIA verbatim, so it must be the full NVIDIA model ID. |
| `BUGFIX_RUST_TOOLCHAIN` | `1.99.1` | Matches RTK's CI (`stable`). With 1.91.0, Clippy rejects the current `develop` (`duplicated_attributes` in `src/llm_proxy.rs`) and every run ends `environment_blocked`. Rebuild the worker (`./bugfix build`) after changing it. |
| (none) | no token, tool-call or run-time cap | Runs continue until verified, `cannot_reproduce`, or `./bugfix cancel RUN_ID`. Rate-limited (HTTP 429) model requests are retried until answered. Token usage is reported, not capped. |
| `BUGFIX_MODEL_MAX_OUTPUT` | `16384` | Room for the model's reasoning plus the final answer. |

**What can stop a run.** Only a reproduction the agent cannot establish in 6 attempts (`cannot_reproduce`), a cancel, a provider that rejects the key or model (HTTP 401/403/404), a broken environment (Docker, baseline checks), or 5 consecutive harness faults during verification. There is no token, tool-call or time limit. Everything else is fed back to the model or retried:

- the GitHub issue fetch: anonymous first; when GitHub's shared anonymous quota (60 requests/hour per IP) is used up, the issue is read with `.secrets/github_token` inside the publisher container; network errors retry with backoff;
- provider rate limits (HTTP 429) retry until answered; 5xx/network errors retry 5 times per request; a provider request silent for 5 minutes is abandoned and retried;
- a reply that is not the requested JSON shape: re-asked up to 3 times with the exact shape; a failed turn (network, OpenCode, provider) is retried without limit, interrupting OpenCode each time and restarting it every third failure;
- `apply_patch` edits sent as a JSON string (some models do this, sometimes closing the last object with `]`) are parsed and the brackets repaired; each edit is still an exact unique replacement;
- a citation that is not a verbatim excerpt of the issue title or body: flagged for human review in the report, not rejected;
- a test that fails with a different message than the model predicted: the observed assertion message is adopted (it must still be a deterministic assertion failure, not a compile/setup error, and a test that passes is never a reproduction);
- a frozen test the agent shows can never pass under a correct fix (`test_defective`): the run returns to reproduction for a new test, at most 3 times;
- `cannot_fix`, rejected candidates and missing evidence IDs: retried up to `BUGFIX_MAX_ATTEMPTS` per round; evidence IDs are filled from the real tool results;
- a candidate that fails independent verification (full workspace tests, Clippy, docs): returned to patching with the failure output in a fresh agent session, round after round until one passes.

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
- `BUGFIX_RUST_TOOLCHAIN`: an explicitly pinned compiler compatible with the selected RTK commit; initial default `1.91.0`.

Create `.secrets/nvidia_api_key` and `.secrets/github_token` using a local editor or password manager. Each file contains only its token. Set permissions to `600`. Never commit credentials, put them in issue text, or paste them into chat. Host `gh auth login` does not automatically authenticate the publisher container. The GitHub credential must support both fork push and upstream PR creation; verify those account capabilities. It is mounted only into the short-lived publisher container, which also reads the issue when GitHub's anonymous API quota (60 requests/hour per IP, often used up on office networks) is exhausted. The NVIDIA credential is used only by the trusted model gateway. OpenCode receives a run-scoped gateway token instead of the actual NVIDIA key.

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
5. Add a new self-contained ordinary inline Rust `#[test]` inside an existing test module. No production/import/helper edits are allowed in the accepted reproduction overlay; during reproduction `apply_patch` refuses on the spot any edit that changes or removes original text (only insertions pass), and a rejected attempt tells the agent the source was reset so it re-adds its test. New fixtures must be in `tests/fixtures/`. The issue quote should be literal (from the title or body); a non-literal quote is flagged for review. The named test must execute and fail at the intended assertion three times; zero tests/compile/setup failures are rejected.
6. Freeze the test syntax, attributes, enclosing module gating and new fixture contents. Try up to `BUGFIX_MAX_ATTEMPTS` candidates per round, using warm-cache formatting, default Clippy, focused regression and nearby module tests; rounds repeat until a candidate passes independent verification.
7. Stop the worker. Reconstruct two independent read-only trees: **base + identical regression overlay**, and **base + overlay + fix**. Never compare against a bare base lacking the new test. Start fresh verifier containers from the trusted cache, invalidate workspace outputs, demonstrate fail-to-pass, and run the configured full profile once. Never import agent-produced compiled artifacts.
8. Confirm final content/tree hashes, export a patch including added files, and create a commit with an empty trusted hooks directory. The agent is shown the final verified diff and writes the commit/PR title (a conventional subject such as `fix(hook): …`) and the root-cause description from that diff alone, so edits it tried and reverted are not described; if that step fails, the patching explanation and a generic title are used. With `--publish`, push that verified commit to the configured fork and create/read back a draft PR against `develop`.

Full local profile: `cargo fmt --all -- --check`, workspace/all-targets Clippy, workspace tests, no-default-features Clippy/tests, and docs. Cargo resolution commands use `--locked --offline`. This covers the configured Linux build, **not** all upstream platforms, `proxy/`, ignored integrations, security scanning or benchmark jobs. Initial issue scope excludes platform-specific, proxy/daemon, dependency, CI and external-service bugs. Baseline failures are blockers, not silently waived. The profile should be reviewed when changing the pinned RTK version. The actual checkout tested here is currently blocked by a pre-existing Clippy error; see [TESTING.md](TESTING.md).

Snapshot exceptions are narrow: declared, module-owned external snapshots or one inline `assert_snapshot!(..., @"expected")` literal change. All such changes are report/PR review flags. Existing fixture edits, arbitrary test changes, deleted/ignored tests, manifests and CI edits are rejected. The new frozen regression expectations can never change.

### OpenCode isolation

Seven custom tools: `graph_query`, `graph_explain`, `graph_path`, `read_source`, `search_text`, `apply_patch`, `run_check`. Text control mode exposes only the last four. Native tools are deny-by-default in a controller-owned config directory with no repository mounts. The controller's NVIDIA gateway also filters the **actual outbound model tool definitions** to this allowlist and logs the resulting names, rather than trusting instructions alone. It rejects an incompatible tool catalog. There are no tool-call, token or time limits; token usage reported by the provider is recorded per run.

### Progress and recovery

The dashboard replays sequenced durable events after reconnect. It displays model messages, provider-exposed reasoning only, command output, graph fallbacks, attempt/check results, diff and publication state. A quiet command shows elapsed activity rather than invented progress. Run artifacts are under `state/runs/RUN_ID/`. Each run has `manifest.json`, `events.jsonl`, reproduction/candidate/verification logs, `report.md`, and a patch if produced. Secret/config folders are excluded from artifact downloads.

Outcomes: `verified_patch`, `draft_created`, `verified_unpublished`, `cannot_reproduce`, `environment_blocked`, `verification_failed`, `cancelled`, `interrupted`. A UI demonstration uses `demo_complete` and cannot publish. A restarted controller stops orphan execution containers, marks unfinished runs interrupted, preserves evidence, and permits publication retry only for an already verified commit. It does not silently replay model actions. Publication reconciliation checks for an existing matching PR after uncertain requests, and surfaces linked competing open PRs. CLA signing, upstream CI and merge remain separate human/upstream steps.

## Development and tests

Node 24+ executes the TypeScript directly; only the type checker needs development dependencies.

```sh
pnpm install --ignore-scripts
pnpm check
pnpm test
node scripts/e2e.ts
BUGFIX_E2E_GRAPH=1 node scripts/e2e.ts
node scripts/adapter-e2e.ts
node scripts/publisher-e2e.ts
node scripts/readiness.ts --baseline
```

Unit/integration tests exercise real Git worktrees, new-file patches, protected regressions, path and symlink boundaries, tool filtering, HTTP authentication, cross-origin rejection, event replay and the labelled demo. The Docker E2E uses a **scripted repair driver** with a small Rust fixture, real Cargo fail-to-pass and independent containers. It does not measure NVIDIA performance or claim an actual RTK issue is fixed. `state/integration-results.json` records results when that test completes. A live model/fork run requires configured credentials and a real issue.

If Docker reports a missing `docker-credential-desktop`, the launcher adds Docker Desktop's bundled CLI directory to PATH. For memory pressure lower `BUGFIX_CPUS`, keep one build job/run, or adjust Docker Desktop's allocation. Cache and build timings must be measured locally; no RAM or completion-time guarantee is implied.

## Configuration and extension points

RTK rules live in `profiles/rtk.json`. To support another Cargo workspace, copy it to `profiles/your-project.json`, change the profile identity, upstream/base branch, package/manifest, editable source/test roots, fixture directory, change limits, focused test arguments and check commands. Set `BUGFIX_PROFILE_NAME=your-project` in `.env`, configure the fork and compiler, then restart with `./bugfix up`. Profiles are mounted read-only into the controller. Each run records a copy so a later profile edit cannot silently change that run's publication identity. Direct Node development uses `BUGFIX_PROFILE=/absolute/path/to/profile.json` instead.

The repository root must contain the Cargo workspace's `Cargo.toml` and `Cargo.lock`. The profile's `manifest` identifies the target package; it can name a workspace member manifest. Focused checks must target that package's library tests. Baseline/final commands are trusted local configuration expressed as argument arrays, never shell strings. Review a profile yourself; do not accept one from issue text or model output.

`.env` controls the provider/model, model context and output limits, provider base URL, fork/author, allowed clone directory, port, Docker network and image names, Rust toolchain, memory/CPU limits, the per-command timeout and candidate attempts. The context/output defaults are examples and must fit your chosen model. The provider gateway supports the OpenAI-compatible chat-completions protocol used here by NVIDIA. A different wire protocol needs an adapter change.

The existing `RepairAgent` interface and factory separate agent orchestration from verification; tests use a scripted implementation. Cargo commands sit in profiles; Rust test extraction/freezing stays in the Rust adapter. Other languages need a new verifier/test adapter and worker image. They are rejected explicitly in this release. This avoids claiming that changing a JSON field makes a Python or JavaScript repository supported.

Authentication, no-network repository execution, immutable regression checks, protected paths and the ban on publishing historical evaluations remain explicit safety rules. Product branding and shipped defaults are ordinary defaults; repository identities are not embedded in the repair or publishing logic.

## What you still configure locally

Credentials stay on your machine: `.secrets/nvidia_api_key` (NVIDIA key) and `.secrets/github_token` (for the draft PR). `.env` holds the model, fork and commit identity. Run `./bugfix doctor` after editing; every line should be PASS. With the worker fixes above, the current RTK `develop` passes the full baseline, so `./bugfix fix ISSUE_URL` goes straight to the model. Do not run `./bugfix up` while a run is active: recreating the controller interrupts it.
