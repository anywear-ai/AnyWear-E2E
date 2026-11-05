import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireCommit, requireString } from './evidence-contract.mjs';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));

// #163: the protected operations all run from the single `qualify` entry. The old
// workflow-file allow-list is replaced by an operation → entry map: an operation must be
// stated explicitly instead of being inferred from whichever file happened to dispatch,
// and every operation names the one entry that may serve it. Adding an operation to a
// different file therefore means changing this map, which is the reviewable point the
// allow-list used to be.
//
// #217: `reconcile` runs as a job of every qualification (before its suite) and as its own
// dispatched operation from the daily schedule. Both go through the same entry, so both
// carry `workflow_dispatch` and the exact protected workflow ref this guard requires. The
// manual `recover` operation was removed with the same change.
export const E2E_OPERATIONS = Object.freeze(['full', 'smoke', 'reconcile']);
const operationEntries = Object.freeze({
  full: 'beta-qualification',
  smoke: 'beta-qualification',
  reconcile: 'beta-qualification',
});

/**
 * The credential session name every protected step must set (#217).
 *
 * Attribution in `reconcile` follows the creator, and the creator is named by this session: an
 * `AdminCreateUser` CloudTrail event records `role-session-name: e2e-<run>-<attempt>`, so the
 * creating run is written by AWS before the identity exists. A step that created an identity
 * under any other session would leave an unattributable leftover, so the guard refuses it.
 */
export function qualificationSessionName(environment = process.env) {
  return `e2e-${requireString(environment.GITHUB_RUN_ID, 'GITHUB_RUN_ID')}-${requireString(environment.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT')}`;
}

export function assertE2EExecution(environment = process.env, { sourceOnly = false, sourceSha } = {}) {
  // #266: the repository is identified by its numeric id alone. The repository keeps its id
  // through the transfer while the owner login and owner id in these variables change, so an
  // owner-name clause would refuse either the run before the transfer or the run after it.
  if (environment.GITHUB_REPOSITORY_ID !== '1317091305'
    || environment.GITHUB_REF !== 'refs/heads/main' || environment.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || environment.E2E_STAGE !== 'beta') throw new Error('E2E operations require the protected main Beta repository/owner dispatch');
  if (environment.ENABLE_BETA_MUTATION !== 'true') throw new Error('Beta mutation activation gate is closed');
  const operation = environment.E2E_OPERATION;
  if (!E2E_OPERATIONS.includes(operation)) throw new Error('E2E execution requires an explicit qualification operation');
  const entry = operationEntries[operation];
  const sha = requireCommit(environment.GITHUB_SHA, 'Current E2E revision');
  if (environment.GITHUB_WORKFLOW_SHA !== sha
    || environment.GITHUB_WORKFLOW_REF !== `${environment.GITHUB_REPOSITORY}/.github/workflows/${entry}.yml@refs/heads/main`) {
    throw new Error('E2E execution requires an exact protected workflow/source');
  }
  const actual = sourceSha ?? execFileSync('git', ['--no-replace-objects', '-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (actual !== sha) throw new Error('E2E checkout does not match the dispatched workflow source');
  for (const name of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) {
    if (!/^[1-9]\d*$/.test(requireString(environment[name], name)) || !Number.isSafeInteger(Number(environment[name]))) throw new Error('Invalid E2E run/attempt identity');
  }
  if (environment.AWS_ACCOUNT_ID !== '650880818323' || environment.AWS_REGION !== 'ap-east-1') throw new Error('Unexpected E2E account/region');
  requireCommit(environment.E2E_CLEANUP_SERVICE_SHA, 'Reviewed Service cleanup operator source');
  // Captured from STS immediately after the protected workflow assumes its
  // dedicated role. Source-only checks run before AWS credentials. The session name is the
  // run-scoped one the credential step set, so an identity can never be created under a
  // session the reconciler cannot attribute.
  if (!sourceOnly) {
    const session = qualificationSessionName(environment);
    const principal = environment.E2E_AWS_PRINCIPAL_ARN ?? '';
    const expected = `arn:aws:sts::650880818323:assumed-role/beta-e2e-qualification-role/${session}`;
    if (environment.E2E_AWS_ACCOUNT !== '650880818323' || principal !== expected) {
      throw new Error(`Authenticated dedicated E2E principal required (expected the ${session} role session)`);
    }
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).some(argument => argument !== '--source-only') || process.argv.length > 3) throw new Error('Unknown E2E execution guard option');
  assertE2EExecution(process.env, { sourceOnly: process.argv.includes('--source-only') });
  console.log('Verified protected E2E Beta execution and exact source identity.');
}
