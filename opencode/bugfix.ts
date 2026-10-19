import { tool } from '@opencode-ai/plugin';
import { readFileSync } from 'node:fs';

async function call(name: string, args: unknown, context: any) {
  const token = readFileSync('/run/bugfix-secrets/bridge_token', 'utf8').trim();
  const response = await fetch(`${process.env.BUGFIX_CONTROLLER_URL}/internal/${process.env.BUGFIX_RUN_ID}/tools/${name}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(args), signal: context.abort,
  });
  const text = await response.text(); if (!response.ok) throw new Error(text); return text;
}
export const graph_query = tool({ description: 'First-choice discovery: scoped Graphify query against the original snapshot.', args: { question: tool.schema.string() }, execute: (args, context) => call('graph_query', args, context) });
export const graph_explain = tool({ description: 'Explain one Graphify symbol and its cited relationships.', args: { symbol: tool.schema.string() }, execute: (args, context) => call('graph_explain', args, context) });
export const graph_path = tool({ description: 'Trace Graphify relationships between two symbols.', args: { source: tool.schema.string(), target: tool.schema.string() }, execute: (args, context) => call('graph_path', args, context) });
export const read_source = tool({ description: 'Read a scoped source/document file, with line numbers and an evidence ID. Does not expose Git metadata.', args: { path: tool.schema.string(), start: tool.schema.number().optional(), end: tool.schema.number().optional() }, execute: (args, context) => call('read_source', args, context) });
export const search_text = tool({ description: 'Scoped literal ripgrep fallback; explain why graph discovery was insufficient. Also lists files when pattern is empty.', args: { path: tool.schema.string(), pattern: tool.schema.string(), reason: tool.schema.string() }, execute: (args, context) => call('search_text', args, context) });
export const apply_patch = tool({ description: 'Apply exact unique source replacements. before is empty ONLY for a new file. No arbitrary shell or Git writes.', args: { edits: tool.schema.array(tool.schema.object({ path: tool.schema.string(), before: tool.schema.string(), after: tool.schema.string() })) }, execute: (args, context) => call('apply_patch', args, context) });
export const run_check = tool({ description: 'Execute an approved repository-profile check ID supplied in the system instructions, or test-focused/test-module. test-focused/test-module run ONLY the library\'s inline #[cfg(test)] unit tests (cargo test --lib), named by crate path as cargo prints it, e.g. hooks::hook_cmd::tests::name or hooks::hook_cmd::tests. Integration tests in tests/*.rs cannot be run; a name that matches nothing passes with 0 tests.', args: { check: tool.schema.string(), test: tool.schema.string().optional() }, execute: (args, context) => call('run_check', args, context) });
