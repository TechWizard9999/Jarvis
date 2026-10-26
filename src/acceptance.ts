import type { AcceptanceRequirement, FrozenRegression, Regression } from './types.ts';
import { scenarioList, regressionPassed, reproductionFailure } from './policy.ts';
export { scenarioList, freezeRegressions, assertFrozenRegressions } from './policy.ts';

const normalized = (text: string) => text.replace(/\s+/g, ' ').trim();
const targetKey = (target: Regression['target']) => !target || target.kind === 'unit' ? 'unit' : `integration:${target.name}`;
export function validateScenarioCoverage(requirements: AcceptanceRequirement[], input: Regression | Regression[]): void {
  if (!Array.isArray(requirements) || !requirements.length) throw new Error('Acceptance requirements must be frozen before reproduction');
  const specs = scenarioList(input), ids = new Set<string>();
  for (const requirement of requirements) {
    if (!requirement || typeof requirement.id !== 'string' || ids.has(requirement.id)) throw new Error('Acceptance requirement IDs must be unique');
    ids.add(requirement.id);
    if (typeof requirement.expectedBehavior !== 'string' || requirement.expectedBehavior.trim().length < 12 || typeof requirement.citation !== 'string' || requirement.citation.trim().length < 12 || !['fail', 'pass'].includes(requirement.baseline)) throw new Error(`Invalid frozen requirement: ${requirement.id}`);
    const spec = specs.find(s => s.id === requirement.id);
    if (!spec) { if (requirement.required !== false) throw new Error(`Missing required acceptance scenario: ${requirement.id}`); continue; }
    if (normalized(spec.expectedBehavior) !== normalized(requirement.expectedBehavior) || normalized(spec.citation) !== normalized(requirement.citation)) throw new Error(`Scenario ${spec.id} weakened or changed its frozen requirement expected behavior/citation`);
    if ((spec.citationSource || 'body') !== (requirement.citationSource || 'body')) throw new Error(`Scenario ${spec.id} changed its frozen citation source`);
    if (spec.baseline !== requirement.baseline || spec.required !== (requirement.required ?? true) || targetKey(spec.target) !== targetKey(requirement.target)) throw new Error(`Scenario ${spec.id} changed its frozen baseline, required flag, or target requirement`);
  }
  for (const spec of specs) if (!ids.has(spec.id!)) throw new Error(`Scenario has no frozen acceptance requirement: ${spec.id}`);
  if (!requirements.some(r => r.required !== false && r.baseline === 'fail')) throw new Error('At least one required bug scenario must fail on the baseline');
}
export interface AcceptanceResult { scenarioId: string; output: string; exitCode: number; timedOut: boolean; }
export function assertAcceptanceResults(frozen: FrozenRegression[], results: AcceptanceResult[], stage: 'baseline' | 'candidate'): void {
  if (stage !== 'baseline' && stage !== 'candidate') throw new Error('Unknown acceptance verification stage');
  const specs = scenarioList(frozen.map(f => f.spec)), ids = new Set<string>();
  for (const result of results) {
    if (ids.has(result.scenarioId)) throw new Error(`Duplicate scenario result: ${result.scenarioId}`);
    ids.add(result.scenarioId);
    if (!specs.some(s => s.id === result.scenarioId)) throw new Error(`Unrelated scenario result: ${result.scenarioId}`);
  }
  let requiredFailures = 0;
  for (const spec of specs) {
    const result = results.find(r => r.scenarioId === spec.id);
    if (!result) { if (spec.required) throw new Error(`Missing required scenario result: ${spec.id}`); continue; }
    const expectsFailure = stage === 'baseline' && spec.baseline === 'fail';
    const valid = !result.timedOut && (expectsFailure
      ? result.exitCode !== 0 && !!spec.failureContains && reproductionFailure(result.output, spec.testName, spec.failureContains)
      : result.exitCode === 0 && regressionPassed(result.output, spec.testName));
    if (spec.required && !valid) throw new Error(`Required scenario ${spec.id} did not ${expectsFailure ? 'reproduce its assertion failure' : 'pass its exact named test'}; compile/setup failures and zero matches do not count`);
    if (spec.required && expectsFailure && valid) requiredFailures++;
  }
  if (stage === 'baseline' && requiredFailures === 0) throw new Error('At least one required scenario must fail on the baseline');
}
