import type { AcceptanceRequirement, Issue } from './types.ts';

export interface AcceptancePlanError { path: string; message: string; }
export interface AcceptancePlanValidation { errors: AcceptancePlanError[]; requirements?: AcceptanceRequirement[]; }

// Keep the established citation policy: Markdown emphasis/code markers and whitespace
// may differ, but the remaining quotation must occur verbatim in the issue body.
const normalizeCitation = (text: string) => text.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();

export function validateAcceptancePlan(input: unknown, issue: Issue): AcceptancePlanValidation {
  const errors: AcceptancePlanError[] = [];
  const reject = (path: string, message: string) => { errors.push({ path, message }); };
  if (!Array.isArray(input)) return { errors: [{ path: 'requirements', message: 'Provide an array of 2–12 acceptance requirements.' }] };
  if (input.length < 2 || input.length > 12) reject('requirements', 'Provide 2–12 scenarios including a required reported failure and a required existing-behavior control.');
  const issueBody = normalizeCitation(issue.body), ids = new Set<string>();
  let requiredBug = false, requiredControl = false;
  for (const [index, row] of input.entries()) {
    const field = `requirements[${index}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) { reject(field, 'Each requirement must be an object.'); continue; }
    if (typeof row.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(row.id)) reject(`${field}.id`, 'Use a unique ID beginning with a letter and containing at most 80 letters, digits, underscores or hyphens.');
    else if (ids.has(row.id)) reject(`${field}.id`, 'Requirement IDs must be unique.');
    else ids.add(row.id);
    if (typeof row.expectedBehavior !== 'string' || row.expectedBehavior.trim().length < 12) reject(`${field}.expectedBehavior`, 'Describe the expected behavior in at least 12 characters.');
    if (typeof row.citation !== 'string' || normalizeCitation(row.citation).length < 12 || !issueBody.includes(normalizeCitation(row.citation))) reject(`${field}.citation`, 'Copy an exact contiguous quotation of at least 12 characters from the issue body; do not paraphrase or combine separated excerpts.');
    if (row.required !== undefined && typeof row.required !== 'boolean') reject(`${field}.required`, 'Use a boolean required flag, or omit it to require the scenario.');
    if (row.baseline !== 'fail' && row.baseline !== 'pass') reject(`${field}.baseline`, 'Use "fail" for the reported bug or "pass" for an existing-behavior control.');
    else if (row.required === undefined || row.required === true) {
      if (row.baseline === 'fail') requiredBug = true;
      else requiredControl = true;
    }
    if (row.target !== undefined) {
      if (!row.target || typeof row.target !== 'object' || Array.isArray(row.target)) reject(`${field}.target`, 'Use {kind:"unit"} or {kind:"integration",name:"test_file_stem"}, or omit it for unit tests.');
      else if (row.target.kind !== 'unit' && row.target.kind !== 'integration') reject(`${field}.target.kind`, 'Target kind must be "unit" or "integration".');
      else if (row.target.kind === 'integration' && (typeof row.target.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(row.target.name))) reject(`${field}.target.name`, 'Use a canonical Cargo integration target stem beginning with a letter or underscore; no path or .rs extension.');
    }
  }
  if (!requiredBug) reject('requirements', 'Include at least one required reported-bug scenario with baseline:"fail".');
  if (!requiredControl) reject('requirements', 'Include at least one required existing-behavior control with baseline:"pass".');
  if (errors.length) return { errors };
  return { errors, requirements: structuredClone(input) as AcceptanceRequirement[] };
}
