/** Offline behavior matrices against actual saved and reviewed RTK source trees. No model or publication. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { exec, checked } from '../src/process.ts';
import { atomicJson } from '../src/store.ts';
import { fingerprint, hash, inventory, safeRelative } from '../src/files.ts';
import { summarizeCheck } from '../src/checks.ts';
import { Repository } from '../src/git.ts';
import { loadConfig } from '../src/config.ts';

const runs = [
  { issue: 3980, run: '20261019185115-134e064d', pr: 4666, corrected: '3c2b4d0a2ca8ffe04195f54459b7e3e681678e38' },
  { issue: 4662, run: '20261019204805-6784a5b4', pr: 4669, corrected: '7818b089bfb3e02f2e735755c1d719d6e2db1e6d' },
];
let archiveRoot = '';
for (const candidate of [process.env.BUGFIX_HISTORICAL_ROOT, process.cwd(), path.resolve(process.cwd(), '../..')].filter((value): value is string => !!value)) {
  if (await fs.stat(path.join(candidate, 'state/runs', runs[0].run, 'manifest.json')).catch(() => false)) { archiveRoot = candidate; break; }
}
if (!archiveRoot) throw new Error('Set BUGFIX_HISTORICAL_ROOT to the Jarvis directory containing the saved historical state/runs');
const evaluationRoot = path.join(archiveRoot, 'state/historical-evaluation-20261020', randomBytes(5).toString('hex'));
await fs.mkdir(evaluationRoot, { recursive: true });
const git = new Repository(loadConfig({ BUGFIX_PROJECT_DIR: process.cwd(), BUGFIX_STATE_DIR: evaluationRoot }));
const docker = process.env.BUGFIX_DOCKER || 'docker';

const lexerCases: [string, string, boolean][] = [
  ['spaced_devnull', 'git status << /dev/null', true], ['attached_devnull', 'git status <</dev/null', true],
  ['normal_delimiter', 'git status <<EOF', true], ['quoted_delimiter', "git status <<'EOF'", true],
  ['tabstrip_delimiter', 'git status <<-EOF', true], ['tabstrip_devnull', 'git status <<- /dev/null', true],
  ['fd_zero_spaced', 'git status 0<< /dev/null', true], ['fd_zero_attached', 'git status 0<</dev/null', true],
  ['fd_three_spaced', 'git status 3<< /dev/null', true], ['fd_three_attached', 'git status 3<</dev/null', true],
  ['fd_multidigit_tabstrip', 'git status 12<<- /dev/null', true], ['quoted_devnull', "git status << '/dev/null'", true],
  ['file_output', 'git status > out.txt', true], ['file_append', 'git status >> out.txt', true], ['file_input', 'git status < in.txt', true],
  ['devnull_output_control', 'git status > /dev/null', false], ['devnull_append_control', 'git status >> /dev/null', false],
  ['fd_devnull_control', 'git status 2> /dev/null', false], ['fd_dup_control', 'git status 2>&1', false],
  ['ordinary_control', 'git status', false],
];
const account = '123456789012', arn = 'arn:aws:iam::123456789012:user/example';
const identity = JSON.stringify({ UserId: 'AIDAEXAMPLE', Account: account, Arn: arn }) + '\n';
interface AwsCase { id: string; args: string[]; stdout: string; stderr: string; code: number; forwarded?: string[]; }
const awsCases: AwsCase[] = [
  { id: 'array_text', args: ['sts', 'get-caller-identity', '--query', '[Account,Arn]', '--output', 'text'], stdout: `${account}\t${arn}\n`, stderr: '', code: 0 },
  { id: 'scalar_query', args: ['sts', 'get-caller-identity', '--query', 'Account'], stdout: JSON.stringify(account) + '\n', stderr: '', code: 0 },
  { id: 'attached_query', args: ['sts', 'get-caller-identity', '--query=Arn'], stdout: JSON.stringify(arn) + '\n', stderr: '', code: 0 },
  { id: 'array_json', args: ['sts', 'get-caller-identity', '--query', '[Account,Arn]'], stdout: JSON.stringify([account, arn]) + '\n', stderr: '', code: 0 },
  { id: 'explicit_text', args: ['sts', 'get-caller-identity', '--output', 'text'], stdout: `${account}\t${arn}\tAIDAEXAMPLE\n`, stderr: '', code: 0 },
  { id: 'attached_text', args: ['sts', 'get-caller-identity', '--output=text'], stdout: `${account}\t${arn}\tAIDAEXAMPLE\n`, stderr: '', code: 0 },
  { id: 'explicit_json', args: ['sts', 'get-caller-identity', '--output', 'json'], stdout: identity, stderr: '', code: 0 },
  { id: 'attached_json', args: ['sts', 'get-caller-identity', '--output=json'], stdout: identity, stderr: '', code: 0 },
  { id: 'query_region_profile', args: ['sts', 'get-caller-identity', '--region', 'us-east-1', '--profile', 'fixture', '--query=Account', '--output=text'], stdout: account + '\n', stderr: '', code: 0 },
  { id: 'ordinary_summary_control', args: ['sts', 'get-caller-identity'], forwarded: ['sts', 'get-caller-identity', '--output', 'json'], stdout: `AWS: ${account} ${arn}\n`, stderr: '', code: 0 },
  { id: 'unrelated_service_control', args: ['ec2', 'describe-regions', '--query', 'Regions[0].RegionName', '--output', 'text'], stdout: 'us-east-1\n', stderr: '', code: 0 },
  { id: 'query_error', args: ['sts', 'get-caller-identity', '--query', 'Bad'], stdout: '', stderr: 'Invalid --query expression\n', code: 2 },
];
const rust = (value: string) => JSON.stringify(value);
const lexerOverlay = '\n#[cfg(test)]\nmod jarvis_historical_3980 {\n    use super::contains_unattestable_construct;\n' + lexerCases.map(([id, command, expected]) => `    #[test]\n    fn ${id}() {\n        assert_eq!(contains_unattestable_construct(${rust(command)}), ${expected}, ${rust(id)});\n    }\n`).join('') + '}\n';
const fakeAws = `#!/usr/bin/python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['JARVIS_AWS_ARGS'], 'w') as output:
    json.dump(args, output)
query, output_format = None, 'json'
for index, arg in enumerate(args):
    if arg == '--query': query = args[index + 1]
    elif arg.startswith('--query='): query = arg.split('=', 1)[1]
    elif arg == '--output': output_format = args[index + 1]
    elif arg.startswith('--output='): output_format = arg.split('=', 1)[1]
if query == 'Bad':
    sys.stderr.write('Invalid --query expression\\n')
    sys.exit(2)
if args[:2] == ['ec2', 'describe-regions']:
    sys.stdout.write('us-east-1\\n')
    sys.exit(0)
if args[:2] != ['sts', 'get-caller-identity']:
    sys.stderr.write('unexpected offline fixture operation\\n')
    sys.exit(99)
account, arn = '${account}', '${arn}'
if query == '[Account,Arn]': value = [account, arn]
elif query == 'Account': value = account
elif query == 'Arn': value = arn
else: value = {'UserId': 'AIDAEXAMPLE', 'Account': account, 'Arn': arn}
if output_format == 'text':
    if isinstance(value, list): text = '\\t'.join(value)
    elif isinstance(value, dict): text = account + '\\t' + arn + '\\tAIDAEXAMPLE'
    else: text = value
else: text = json.dumps(value, separators=(',', ':'))
sys.stdout.write(text + '\\n')
`;
const awsOverlay = `#![cfg(unix)]
use std::fs;
use std::os::unix::fs::PermissionsExt;
mod common;
fn assert_case(args: &[&str], expected_argv: &[&str], code: i32, stdout: &str, stderr: &str) {
    let directory = common::tempdir();
    let executable = directory.path().join("aws");
    fs::write(&executable, ${rust(fakeAws)}).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
    let recorded = directory.path().join("args.json");
    let output = common::rtk_command().arg("aws").args(args)
        .env("PATH", format!("{}:{}", directory.path().display(), std::env::var("PATH").unwrap_or_default()))
        .env("JARVIS_AWS_ARGS", &recorded).output().unwrap();
    assert_eq!(output.status.code(), Some(code), "exit status");
    assert_eq!(String::from_utf8(output.stdout).unwrap(), stdout, "stdout");
    assert_eq!(String::from_utf8(output.stderr).unwrap(), stderr, "stderr");
    let argv: Vec<String> = serde_json::from_str(&fs::read_to_string(recorded).unwrap()).unwrap();
    assert_eq!(argv, expected_argv, "forwarded AWS argv");
}
` + awsCases.map(test => `#[test]\nfn ${test.id}() {\n    assert_case(&[${test.args.map(rust).join(',')}], &[${(test.forwarded || test.args).map(rust).join(',')}], ${test.code}, ${rust(test.stdout)}, ${rust(test.stderr)});\n}\n`).join('');
await atomicJson(path.join(evaluationRoot, 'matrix.json'), { lexerCases, awsCases, lexerOverlaySha256: hash(lexerOverlay), awsOverlaySha256: hash(awsOverlay), fixedCorrectedCommits: runs });

interface CommitMetadata { sha: string; parents: { sha: string }[]; commit: { tree: { sha: string } }; files: { filename: string; status: string; sha: string }[]; }
async function githubJson(endpoint: string) {
  return JSON.parse(checked(await exec('gh', ['api', endpoint], { timeoutMs: 60000, maxBytes: 4 * 1024 * 1024 }), 'Read pinned corrected GitHub source'));
}
async function correctedMetadata(sha: string): Promise<CommitMetadata> {
  const file = path.join(evaluationRoot, `${sha}.json`), metadata = await githubJson(`repos/rtk-ai/rtk/commits/${sha}`) as CommitMetadata;
  assert.equal(metadata.sha, sha); await atomicJson(file, metadata); return metadata;
}
interface Result { issue: number; variant: string; sourceCommit: string; sourceTree: string; sourceHash: string; patchSha256?: string; overlaySha256: string; imageId: string; argv: string[]; code: number; timedOut: boolean; durationMs: number; status: string; matched?: number; passed?: number; failed?: number; failures: string[]; log: string; expectedVerdict: string; actualVerdict: string; }
const results: Result[] = [];
try {
  for (const historical of runs) {
    const runDir = path.join(archiveRoot, 'state/runs', historical.run);
    const manifest = JSON.parse(await fs.readFile(path.join(runDir, 'manifest.json'), 'utf8'));
    checked(await exec(docker, ['image', 'inspect', '--format', '{{.Id}}', manifest.imageId]), 'Require original immutable worker cache');
    const corrected = await correctedMetadata(historical.corrected);
    assert.deepEqual(corrected.parents.map(parent => parent.sha), [manifest.baseSha], 'Reviewed candidate must share the recorded base');
    for (const variant of ['baseline', 'original', 'corrected']) {
      const dir = path.join(evaluationRoot, `${historical.issue}-${variant}`), source = path.join(dir, 'source');
      await fs.mkdir(dir, { recursive: true }); await fs.cp(path.join(runDir, 'base'), source, { recursive: true });
      checked(await git.git(source, ['init', '--object-format=sha1']), 'Initialize isolated tree verifier');
      checked(await git.git(source, ['add', '-A', '-f', '.']), 'Stage exact baseline');
      assert.equal(checked(await git.git(source, ['write-tree']), 'Read baseline tree'), manifest.baseTree, 'Saved baseline differs from recorded Git tree');
      let sourceTree = manifest.baseTree, sourceCommit = manifest.baseSha, patchSha256: string | undefined;
      if (variant === 'original') {
        const patch = await fs.readFile(path.join(runDir, 'candidate.patch'), 'utf8'); patchSha256 = hash(patch);
        checked(await git.git(source, ['apply', '--index', '--binary', '-'], patch), 'Apply actual original candidate patch');
        sourceTree = checked(await git.git(source, ['write-tree']), 'Read original candidate tree');
        assert.equal(sourceTree, manifest.verifiedTree, 'Actual patch differs from original verified tree'); sourceCommit = manifest.verifiedCommit;
      } else if (variant === 'corrected') {
        for (const changed of corrected.files) {
          const relative = safeRelative(changed.filename); assert.ok(['modified', 'added'].includes(changed.status), 'Only pinned added/modified files are supported');
          const blob = await githubJson(`repos/rtk-ai/rtk/git/blobs/${changed.sha}`);
          assert.equal(blob.encoding, 'base64'); const content = Buffer.from(blob.content, 'base64');
          assert.equal(createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex'), changed.sha, 'Corrected source blob hash mismatch');
          await fs.mkdir(path.dirname(path.join(source, relative)), { recursive: true }); await fs.writeFile(path.join(source, relative), content);
        }
        checked(await git.git(source, ['add', '-A', '-f', '.']), 'Stage pinned corrected source');
        sourceTree = checked(await git.git(source, ['write-tree']), 'Read corrected candidate tree');
        assert.equal(sourceTree, corrected.commit.tree.sha, 'Corrected source overlay does not match the actual reviewed commit tree'); sourceCommit = corrected.sha;
      }
      const sourceHash = fingerprint(await inventory(source)); await fs.rm(path.join(source, '.git'), { recursive: true, force: true });
      const overlay = historical.issue === 3980 ? lexerOverlay : awsOverlay;
      if (historical.issue === 3980) await fs.appendFile(path.join(source, 'src/discover/lexer.rs'), overlay);
      else await fs.writeFile(path.join(source, 'tests/jarvis_historical_4662.rs'), overlay);
      const argv = historical.issue === 3980
        ? ['cargo', 'test', '-p', 'rtk', '--lib', '--locked', '--offline', 'jarvis_historical_3980::', '--', '--nocapture', '--test-threads=1']
        : ['cargo', 'test', '-p', 'rtk', '--test', 'jarvis_historical_4662', '--locked', '--offline', '--', '--nocapture', '--test-threads=1'];
      const name = `jarvis-historical-${historical.issue}-${variant}-${randomBytes(3).toString('hex')}`;
      console.log(`Running #${historical.issue} ${variant} (${sourceCommit.slice(0, 12)})`);
      let result: Awaited<ReturnType<typeof exec>>;
      try {
        checked(await exec(docker, ['run', '--detach', '--init', '--name', name, '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '4g', '--cpus', '2', '--env', 'CARGO_BUILD_JOBS=1', '--env', 'CARGO_NET_OFFLINE=true', '--env', 'RUST_TEST_THREADS=1', '--env', 'CARGO_TARGET_DIR=/build/target', '--mount', `type=bind,source=${source},target=/workspace,readonly`, '--workdir', '/workspace', manifest.imageId, 'sleep', 'infinity']), 'Start offline readonly historical worker');
        const clean = await exec(docker, ['exec', name, 'python3', '/opt/bugfix/prepare.py', 'invalidate-workspace'], { timeoutMs: 180000 });
        await fs.writeFile(path.join(dir, 'invalidate.log'), clean.stdout + clean.stderr); checked(clean, 'Invalidate workspace artifacts before actual candidate build');
        result = await exec(docker, ['exec', name, ...argv], { timeoutMs: 240000, maxBytes: 16 * 1024 * 1024 });
      } finally { await exec(docker, ['rm', '--force', name]).catch(() => {}); }
      const log = path.join(dir, 'matrix.log'), output = result.stdout + result.stderr; await fs.writeFile(log, output);
      const summary = summarizeCheck(output, result.code, result.timedOut, argv), count = historical.issue === 3980 ? lexerCases.length : awsCases.length;
      const failures = [...output.matchAll(/^test (\S+) \.\.\. FAILED$/gm)].map(match => match[1]);
      const executed = summary.matched === count && !result.timedOut && !/could not compile|error\[E\d+\]/.test(output);
      const actualVerdict = !executed ? 'harness_error' : result.code === 0 && summary.failed === 0 ? 'accepted' : 'rejected';
      const expectedVerdict = variant === 'corrected' ? 'accepted' : 'rejected';
      const record: Result = { issue: historical.issue, variant, sourceCommit, sourceTree, sourceHash, ...(patchSha256 ? { patchSha256 } : {}), overlaySha256: hash(overlay), imageId: manifest.imageId, argv, code: result.code, timedOut: result.timedOut, durationMs: result.durationMs, ...summary, failures, log, expectedVerdict, actualVerdict };
      results.push(record); await atomicJson(path.join(evaluationRoot, 'results.json'), results);
      console.log(`#${historical.issue} ${variant}: ${actualVerdict}; ${summary.passed}/${count} pass, ${summary.failed} fail`);
      assert.equal(actualVerdict, expectedVerdict, `Unexpected #${historical.issue} ${variant} verdict; inspect ${log}`);
    }
  }
} finally {
  const complete = results.length === 6 && results.every(result => result.expectedVerdict === result.actualVerdict);
  const report = `# Historical candidate behavior evaluation — 20 October 2026\n\nResult: **${complete ? 'passed' : 'incomplete or failed'}**. Actual saved patches and pinned corrected PR source trees were built and executed in network-disabled Docker containers using the original runs' immutable worker cache image. No model request or GitHub write occurred. Corrected source was retrieved read-only by immutable commit/blob IDs.\n\n| Issue | Source | Commit | Verdict | Passed | Failed | Matched | Log |\n| --- | --- | --- | --- | ---: | ---: | ---: | --- |\n${results.map(result => `| #${result.issue} | ${result.variant} | ${result.sourceCommit} | ${result.actualVerdict} | ${result.passed} | ${result.failed} | ${result.matched} | [matrix log](${result.log}) |`).join('\n')}\n\nMatrix: #3980 has ${lexerCases.length} direct lexer-predicate tests covering spaced/attached/quoted/tab-stripped and descriptor-prefixed heredocs, real file redirects, /dev/null exemptions, descriptor duplication, and ordinary-command controls. #4662 has ${awsCases.length} actual CLI integration tests with a local fake aws executable covering array/scalar queries, separated/attached query/output options, explicit text/JSON formats, region/profile forwarding, ordinary summary, another AWS service, and error status/stderr. Every CLI case asserts exact stdout, stderr, exit status, and forwarded argument vector.\n\nEach source tree was checked against its Git tree ID before adding the identical matrix overlay. Original candidate patches must reproduce the recorded verified tree; corrected overlays must reproduce the pinned PR commit tree. Workspace artifacts were invalidated before each build. Repository source mounts were read-only; test scratch files stayed inside the isolated container.\n\nThese are targeted behavior matrices, **not a rerun of the complete RTK suite or a model success-rate evaluation**. Unexpected compile/setup errors and zero matches are harness errors and cannot count as a rejected candidate.\n\nArtifacts: [results](${path.join(evaluationRoot, 'results.json')}), [fixed matrix and overlay hashes](${path.join(evaluationRoot, 'matrix.json')}).\n\nReproduce from the implementation directory: \`BUGFIX_HISTORICAL_ROOT=${archiveRoot} node scripts/historical-e2e.ts\`. Requires the original saved run directories, gh read access for pinned corrected sources, Docker, and the recorded cache image.\n`;
  const failedOriginalRows = results.filter(result => result.variant === 'original').map(result =>
    `- #${result.issue}: ${result.failures.map(name => `\`${name.split('::').at(-1)}\``).join(', ')}.`).join('\n');
  await fs.writeFile(path.join(archiveRoot, 'state/historical-evaluation-20261020.md'), report + `\nOriginal candidate failures:\n\n${failedOriginalRows}\n`);
}
console.log(`PASS: actual original candidates rejected; corrected candidates accepted. Report: ${path.join(archiveRoot, 'state/historical-evaluation-20261020.md')}`);
