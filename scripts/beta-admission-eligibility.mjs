import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { leaseableWorkerAddresses } from './worker-slots.mjs';
import { parseStrictJson } from './evidence-contract.mjs';
import { assertE2EExecution } from './execution-guard.mjs';

// Beta registration admits exactly the addresses on this one allowlist (issue #213), so
// the qualification pre-flight has to prove two things before the first account is
// created: the list is in the writer's canonical shape, and it lists every stable pool
// address this run can lease. The shapes are the Infra writer's
// (`normalizeTesterEmails`): a compact JSON array of sorted, trimmed, lowercase exact
// emails, at most 50, within the SSM value size.
const TESTER_ALLOWLIST_PARAMETER = '/anywear/beta/tester_allowlist';
// #266: owner-relative, so the same protected entry is recognised on either side of the
// repository transfer. The repository half of the workflow ref is derived from the run's
// own GITHUB_REPOSITORY when it is compared below.
const qualificationWorkflow = (repository) => `${repository}/.github/workflows/beta-qualification.yml@refs/heads/main`;
// #163: operation `full` runs exactly two workers, and that width is part of the
// operation's shape. The pre-flight checks the same width the suite will use.
const QUALIFICATION_WORKERS = 2;
const MAX_TESTERS = 50;
const MAX_PARAMETER_BYTES = 4096;
const MAX_EMAIL_LENGTH = 254;
// Match the Infra tester producer's accepted email syntax and normalization.
const emailPattern = /^[a-z0-9.!#$%&'+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Validate one `ssm:GetParameter` read of the tester allowlist.
 *
 * `requiredAddresses` is every pool address the run can lease, derived from the same
 * slot arithmetic the worker fixture uses. A list that is valid but misses one of them
 * would let the suite create an account the registration gate refuses, so the refusal
 * names the missing address here instead.
 */
export function validateBetaAdmissionPolicy(response, requiredAddresses) {
  const parameter = response?.Parameter;
  if (!parameter || parameter.Name !== TESTER_ALLOWLIST_PARAMETER || parameter.Type !== 'String'
    || typeof parameter.Value !== 'string'
    || Buffer.byteLength(parameter.Value, 'utf8') > MAX_PARAMETER_BYTES
    || !Number.isSafeInteger(parameter.Version) || parameter.Version < 1) {
    throw new Error('Beta admission eligibility received a malformed tester allowlist parameter');
  }
  let testers;
  try { testers = parseStrictJson(parameter.Value); }
  catch { throw new Error('Beta admission eligibility received malformed tester allowlist JSON'); }
  if (!Array.isArray(testers) || testers.length > MAX_TESTERS || testers.some(email => typeof email !== 'string')) {
    throw new Error('Beta admission eligibility requires a valid tester email list');
  }
  // Canonical and normalized: the writer trims, lowercases, de-duplicates and sorts, and
  // emits `JSON.stringify`, so an entry that would mean something else here than it does
  // to the Service reader is refused rather than repaired.
  if (testers.some(email => email !== email.trim().toLowerCase()
      || email.length > MAX_EMAIL_LENGTH || !emailPattern.test(email))
    || new Set(testers).size !== testers.length) {
    throw new Error('Beta admission eligibility requires canonical unique tester emails');
  }
  if (JSON.stringify(testers) !== parameter.Value) {
    throw new Error('Beta admission eligibility requires the canonical tester list bytes');
  }
  if (!Array.isArray(requiredAddresses) || requiredAddresses.length === 0) {
    throw new Error('Beta admission eligibility requires at least one leaseable worker-pool address');
  }
  const missing = requiredAddresses.filter((address) => !testers.includes(address));
  if (missing.length > 0) {
    throw new Error(`Beta admission eligibility requires every leaseable worker-pool address in the tester allowlist: missing ${missing.join(', ')}`);
  }
  // Return only the parameter version; the membership itself is never logged.
  return { versions: { tester_allowlist: parameter.Version } };
}

export function verifyBetaAdmissionEligibility(environment = process.env, { execute = execFileSync, sourceSha } = {}) {
  assertE2EExecution(environment, { sourceSha });
  // #163: operation `full` qualifies with two workers and is the only caller of this
  // check. The worker count is part of the operation's shape.
  if (environment.GITHUB_WORKFLOW_REF !== qualificationWorkflow(environment.GITHUB_REPOSITORY) || environment.E2E_WORKERS !== '2') {
    throw new Error(`Beta admission eligibility requires the exact qualification workflow with exactly 2 workers for operation ${environment.E2E_OPERATION}`);
  }
  // The slot offset is validated before the read: an out-of-range offset must never
  // become an address outside the pool, and validation costs no cloud call.
  const requiredAddresses = leaseableWorkerAddresses(environment, QUALIFICATION_WORKERS);
  let response;
  try {
    response = parseStrictJson(execute('aws', ['ssm', 'get-parameter', '--name', TESTER_ALLOWLIST_PARAMETER,
      '--region', environment.AWS_REGION, '--output', 'json', '--no-cli-pager'], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], env: environment,
    }));
  } catch {
    // CLI failures may include raw values or credentials; keep the diagnostic bounded.
    throw new Error('Beta admission eligibility could not read valid SSM policy; qualification refused');
  }
  return validateBetaAdmissionPolicy(response, requiredAddresses);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw new Error('Unknown Beta admission eligibility option');
  verifyBetaAdmissionEligibility();
  console.log('Verified the Beta tester allowlist admits every worker-pool address this run can lease.');
}
