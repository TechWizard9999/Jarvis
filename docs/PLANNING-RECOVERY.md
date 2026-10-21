# Acceptance planning and recovery

Initial acceptance planning runs read-only with the review phase's high-effort model settings. Its instructions distinguish planning from the later independent review of frozen regression tests. The controller does not permit edits, checks or formatting during either operation.

The controller validates every submitted row before freezing a plan: row count (2–12), unique IDs, substantive expected behavior, exact issue-body quotations, baseline, required flag and approved test target. At least one required reported-bug failure and one required passing control are necessary. Optional `required` and `target` fields retain the existing defaults of required and unit tests.

Citation normalization is unchanged: remove Markdown backticks/emphasis markers and collapse whitespace. The remaining quotation must be at least 12 characters and occur contiguously in the issue body. Paraphrases, invented punctuation, reordered passages and repository test data cannot substitute for an issue quotation. Controls cite the relevant issue rationale; source inspection can inform their expected behavior. Citation validation alone cannot establish that a proposed behavior is faithful or complete; independent coverage review and behavioral tests remain necessary.

Each returned plan is preserved privately under `planning/attempt-N/submitted-answer.json` before semantic validation. `validation.json` records all field errors and whether it was accepted. Attempt directories are reserved exclusively. A preservation failure stops the run before another planning turn. Invalid supplied operator matrices stop for review and are never silently rewritten by a model.

Model-derived plans receive the complete validation errors and can submit a complete replacement in the same read-only phase, for at most three submitted plans. Only a fully accepted plan becomes `acceptance-plan.json` and the manifest's frozen acceptance plan. No quotation, expected behavior or requirement is automatically rewritten by the controller.

Malformed JSON retains the existing three reply-only format retries. If all fail during initial planning, the unchanged final reply texts are preserved privately as `raw-replies.json` and the run stops; whole-turn recovery cannot restart that format failure indefinitely. Provider failures retain the separate policy in [PROVIDER-RECOVERY.md](PROVIDER-RECOVERY.md). Cancellation prevents further planning requests.

Exhausted or invalid planning ends as `needs_attention`, explicitly before reproduction. `cannot_reproduce` remains a result of attempted behavioral reproduction. Historical manifests are retained unchanged, including earlier runs with the misleading classification.

Regression tests cover exact-citation correction, all-row errors, wrong JSON shapes, unchanged submission artifacts, operator matrices, preservation failure, format exhaustion, cancellation, read-only tools and the separate frozen-test critic prompt. Local fixture tests do not establish that a live model will choose a correct repair.
