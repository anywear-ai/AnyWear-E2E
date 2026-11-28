import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { assertE2EExecution } from './execution-guard.mjs';
import { canonicalJson, byteHash, exactKeys, requireHash } from './evidence-contract.mjs';

// The environment a gate suite is embedded in: the identity of the workers serving Beta at
// suite start and suite end, and the verdict that attributes a red suite to the product or to
// the environment.
//
// A suite that runs across a deployment rotation can have its in-flight work killed
// underneath it. When that happens no terminal state is written for the case, the harness
// waits out its budget, and the run reports the platform's own recovery as a product
// failure. The evidence for that is issue #147 and gate run 38864061777: a worker
// rotation stopped the task holding an S1 VTO case, its provider call was killed by SIGTERM
// after 40.7 s, nothing was recorded for it, the case stayed in `Processing`, and the queue
// redelivered the work exactly at its 900 s visibility floor - after the 600 s wait had
// expired.
//
// #358: the module keeps only `capture` and `verdict`. Its blocking half - refusing a record
// for a passing suite measured across two worker task definitions - existed to seal the
// qualification ledger, and the ledger is removed. That window is now closed by the retained
// mutex (a deployment holds the tuple while its gate runs) and by the gate's own live
// identity re-read, which makes the run red when the deployment changed under it.
//
// The AWS reader is deliberately outside the Playwright spec: the gate workflow holds the
// scoped AWS credentials and the spec holds none, so the spec records what the run observed
// and the workflow records what the platform was.

export const BETA_ACCOUNT_ID = '650880818323';
export const BETA_REGION = 'ap-east-1';
export const BETA_CLUSTER = 'beta-anywear';
export const BETA_WORKER_SERVICE = 'beta-anywear-worker';
export const WORKER_IDENTITY_RECORD_TYPE = 'beta-worker-identity';
export const ENVIRONMENT_VERDICT_RECORD_TYPE = 'beta-environment-verdict';
export const ENVIRONMENT_SCHEMA_VERSION = 1;

export const ENVIRONMENT_IDENTITY_PATHS = Object.freeze({
  before: '.e2e-inputs/beta-environment-before.json',
  after: '.e2e-inputs/beta-environment-after.json',
});
export const ENVIRONMENT_VERDICT_PATH = 'test-results/beta-environment-verdict.json';

const TASK_ARN = /^arn:aws:ecs:[^:]+:\d+:task\/[^/]+\/[0-9a-f-]+$/;
const TASK_DEFINITION_ARN = /^arn:aws:ecs:[^:]+:\d+:task-definition\/[^/]+:\d+$/;
const IDENTITY_PHASES = Object.freeze(['before', 'after']);
const IDENTITY_FIELDS = Object.freeze(['schema_version', 'record_type', 'phase', 'observed_at', 'account_id', 'region',
  'cluster', 'service', 'task_definition_arn', 'desired_count', 'running_count', 'pending_count', 'deployment_ids',
  'rollout_states', 'task_arns', 'tasks', 'identity_sha256']);
const IDENTITY_TASK_FIELDS = Object.freeze(['task_arn', 'task_definition_arn', 'last_status', 'started_at']);

const isoOrNull = (value) => {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const sortedUnique = (values) => [...new Set(values.filter(value => typeof value === 'string' && value))].sort();

// The identity of the workers serving Beta is the worker service's task ARN set
// together with the task definition those tasks run. A change in either means the
// platform replaced the workers underneath the suite. Nothing else decides the
// verdict, so a case that fails while this identity is unchanged still fails the
// run as a product failure.
export function workerIdentitySha256(identity) {
  return byteHash(canonicalJson({
    service: identity?.service,
    task_definition_arn: identity?.task_definition_arn,
    task_arns: identity?.task_arns,
  }));
}

// Deliberately lenient about the rollout: a rotation may still be in flight at
// suite end, which is the condition this record exists to capture. It asserts
// only what the identity needs: the reviewed Beta account, one named worker
// service, and a task listing that describes exactly the tasks it lists.
export function workerIdentitySnapshot(aws, { phase, cluster = BETA_CLUSTER, service = BETA_WORKER_SERVICE } = {}) {
  if (!IDENTITY_PHASES.includes(phase)) throw new Error('A worker identity capture needs an explicit before or after phase');
  const caller = aws(['sts', 'get-caller-identity']);
  if (caller.Account !== BETA_ACCOUNT_ID) throw new Error('Worker identity capture requires the reviewed Beta account');
  const described = aws(['ecs', 'describe-services', '--cluster', cluster, '--services', service]);
  if (described.failures?.length || described.services?.length !== 1 || described.services[0].serviceName !== service) {
    throw new Error(`${service} is unavailable for worker identity capture`);
  }
  const listed = aws(['ecs', 'list-tasks', '--cluster', cluster, '--service-name', service]);
  const taskArns = sortedUnique(listed.taskArns ?? []);
  let tasks = [];
  if (taskArns.length) {
    const observed = aws(['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', ...taskArns]);
    if (observed.failures?.length || (observed.tasks ?? []).length !== taskArns.length) {
      throw new Error('Active worker task observation failed');
    }
    tasks = observed.tasks.map(task => ({
      task_arn: task.taskArn ?? null,
      task_definition_arn: task.taskDefinitionArn ?? null,
      last_status: typeof task.lastStatus === 'string' ? task.lastStatus : null,
      started_at: isoOrNull(task.startedAt),
    })).sort((left, right) => String(left.task_arn).localeCompare(String(right.task_arn)));
  }
  const record = {
    schema_version: ENVIRONMENT_SCHEMA_VERSION,
    record_type: WORKER_IDENTITY_RECORD_TYPE,
    phase,
    observed_at: new Date().toISOString(),
    account_id: caller.Account,
    region: BETA_REGION,
    cluster,
    service,
    task_definition_arn: described.services[0].taskDefinition ?? null,
    desired_count: Number.isInteger(described.services[0].desiredCount) ? described.services[0].desiredCount : null,
    running_count: Number.isInteger(described.services[0].runningCount) ? described.services[0].runningCount : null,
    pending_count: Number.isInteger(described.services[0].pendingCount) ? described.services[0].pendingCount : null,
    deployment_ids: sortedUnique((described.services[0].deployments ?? []).map(deployment => deployment.id)),
    rollout_states: sortedUnique((described.services[0].deployments ?? []).map(deployment => deployment.rolloutState)),
    task_arns: taskArns,
    tasks,
  };
  record.identity_sha256 = workerIdentitySha256(record);
  return record;
}

export function validateWorkerIdentity(record, { phase } = {}) {
  exactKeys(record, [...IDENTITY_FIELDS], 'Worker identity');
  if (record.schema_version !== ENVIRONMENT_SCHEMA_VERSION || record.record_type !== WORKER_IDENTITY_RECORD_TYPE) {
    throw new Error('Worker identity record type or schema version changed');
  }
  if (phase !== undefined && record.phase !== phase) throw new Error(`Worker identity is the ${record.phase} capture, not the ${phase} one`);
  if (!IDENTITY_PHASES.includes(record.phase)) throw new Error('Worker identity phase must be before or after');
  if (record.account_id !== BETA_ACCOUNT_ID || record.region !== BETA_REGION
    || record.cluster !== BETA_CLUSTER || record.service !== BETA_WORKER_SERVICE) {
    throw new Error('Worker identity was captured outside the reviewed Beta environment');
  }
  if (!Number.isFinite(Date.parse(record.observed_at))) throw new Error('Worker identity needs a valid observation time');
  if (record.task_definition_arn !== null && !TASK_DEFINITION_ARN.test(record.task_definition_arn ?? '')) {
    throw new Error('Worker identity task definition ARN is malformed');
  }
  for (const count of ['desired_count', 'running_count', 'pending_count']) {
    if (!Number.isInteger(record[count]) || record[count] < 0) throw new Error(`Worker identity ${count} is malformed`);
  }
  if (!Array.isArray(record.deployment_ids) || !Array.isArray(record.rollout_states)
    || record.deployment_ids.some(id => typeof id !== 'string') || record.rollout_states.some(state => typeof state !== 'string')) {
    throw new Error('Worker identity deployment observation is malformed');
  }
  if (!Array.isArray(record.task_arns) || record.task_arns.some(arn => !TASK_ARN.test(arn ?? ''))
    || new Set(record.task_arns).size !== record.task_arns.length
    || JSON.stringify(record.task_arns) !== JSON.stringify(sortedUnique(record.task_arns))) {
    throw new Error('Worker identity task ARNs must be unique, canonical ARNs in canonical order');
  }
  if (!Array.isArray(record.tasks) || record.tasks.length !== record.task_arns.length) {
    throw new Error('Worker identity must describe exactly the worker tasks it lists');
  }
  for (const task of record.tasks) {
    exactKeys(task, [...IDENTITY_TASK_FIELDS], 'Worker identity task');
    if (!record.task_arns.includes(task.task_arn)) throw new Error('Worker identity task is not in its own task set');
    if (task.task_definition_arn !== null && !TASK_DEFINITION_ARN.test(task.task_definition_arn ?? '')) {
      throw new Error('Worker identity task definition ARN is malformed');
    }
    if (task.started_at !== null && !Number.isFinite(Date.parse(task.started_at))) {
      throw new Error('Worker identity task start time is malformed');
    }
  }
  requireHash(record.identity_sha256, 'Worker identity digest');
  if (workerIdentitySha256(record) !== record.identity_sha256) {
    throw new Error('Worker identity digest does not match its worker task set and task definition');
  }
  return record;
}

export function unavailableWorkerIdentityComparison(reason) {
  return {
    verdict: 'unavailable',
    reason: String(reason),
    before_observed_at: null,
    after_observed_at: null,
    before_identity_sha256: null,
    after_identity_sha256: null,
    before_task_arns: [],
    after_task_arns: [],
    added_task_arns: [],
    removed_task_arns: [],
    task_definition_changed: false,
  };
}

export function compareWorkerIdentity(before, after, { problem } = {}) {
  if (problem) return unavailableWorkerIdentityComparison(problem);
  try {
    validateWorkerIdentity(before, { phase: 'before' });
    validateWorkerIdentity(after, { phase: 'after' });
  } catch (error) {
    return unavailableWorkerIdentityComparison(`Worker identity is unusable: ${error.message}`);
  }
  const beforeAt = Date.parse(before.observed_at);
  const afterAt = Date.parse(after.observed_at);
  if (afterAt <= beforeAt) {
    return unavailableWorkerIdentityComparison('Worker identity captures are not in suite order; the pair cannot bracket the run');
  }
  const added = after.task_arns.filter(arn => !before.task_arns.includes(arn));
  const removed = before.task_arns.filter(arn => !after.task_arns.includes(arn));
  const taskDefinitionChanged = before.task_definition_arn !== after.task_definition_arn;
  const changed = added.length > 0 || removed.length > 0 || taskDefinitionChanged;
  // Findings keep the fixed order definition, disappeared, appeared, so the same
  // observation always reads the same way. The definition change is not emitted as a
  // finding at all: it is the one condition whose own prefix already names it.
  const findings = [];
  if (removed.length) findings.push(`${removed.length} worker task(s) disappeared`);
  if (added.length) findings.push(`${added.length} worker task(s) appeared`);
  // The prefix classifies the change, and the classification is what keeps the reason
  // honest: "replaced" is only true when a worker that was serving Beta left the set. A
  // change that only added tasks describes the same set scaled out, and a change of the
  // definition under a byte-identical set is neither a replacement nor a scale-out.
  const prefix = taskDefinitionChanged
    ? 'The worker task definition serving Beta changed during the suite'
    : removed.length
      ? 'The workers serving Beta were replaced during the suite'
      : 'The worker set serving Beta scaled out during the suite';
  return {
    verdict: changed ? 'changed' : 'unchanged',
    reason: changed
      ? `${prefix}${findings.length ? `: ${findings.join(' and ')}` : ''}`
      : 'The worker task set and the worker task definition are unchanged across the suite window',
    before_observed_at: before.observed_at,
    after_observed_at: after.observed_at,
    before_identity_sha256: before.identity_sha256,
    after_identity_sha256: after.identity_sha256,
    before_task_arns: before.task_arns,
    after_task_arns: after.task_arns,
    added_task_arns: added,
    removed_task_arns: removed,
    task_definition_changed: taskDefinitionChanged,
  };
}

// The verdict is the machine-readable answer to "was the platform redeployed
// under us?" It is attribution evidence for a reader; it never turns a red run green,
// because a run the platform was redeployed under measured neither state.
//
// `suiteOutcome` is 'success', 'failure', or 'incomplete' for a suite that neither
// passed nor produced a product failure - a cancelled run, or one the job timeout
// ended. An incomplete suite asserts no product failure, because no product failure
// was established; its red run comes from the cancelled step itself.
export function environmentVerdict({ comparison, suiteOutcome }) {
  if (!['success', 'failure', 'incomplete'].includes(suiteOutcome)) {
    throw new Error('A verdict needs the suite outcome: success, failure or incomplete');
  }
  if (!comparison || !['changed', 'unchanged', 'unavailable'].includes(comparison.verdict)) {
    throw new Error('A verdict needs a worker identity comparison');
  }
  const changed = comparison.verdict === 'changed';
  const coverageEstablished = comparison.verdict !== 'unavailable';
  const productFailureAsserted = suiteOutcome === 'failure' && !changed;
  const attribution = changed ? 'environment' : suiteOutcome === 'failure' ? 'product'
    : suiteOutcome === 'incomplete' ? 'undetermined' : 'none';
  const verdict = changed ? 'environment-changed' : coverageEstablished ? 'unchanged' : 'unavailable';
  const reason = changed
    ? `${comparison.reason}; the suite outcome is attributed to the environment, not to a product failure`
    : coverageEstablished
      ? comparison.reason
      : `${comparison.reason}; the environment-change check is not established, so a failure still stands as a product failure`;
  return {
    schema_version: ENVIRONMENT_SCHEMA_VERSION,
    record_type: ENVIRONMENT_VERDICT_RECORD_TYPE,
    recorded_at: new Date().toISOString(),
    suite_outcome: suiteOutcome,
    verdict,
    attribution,
    product_failure_asserted: productFailureAsserted,
    identity_coverage: coverageEstablished ? 'established' : 'unavailable',
    reason,
    comparison: {
      before_observed_at: comparison.before_observed_at,
      after_observed_at: comparison.after_observed_at,
      before_identity_sha256: comparison.before_identity_sha256,
      after_identity_sha256: comparison.after_identity_sha256,
      before_task_arns: comparison.before_task_arns,
      after_task_arns: comparison.after_task_arns,
      added_task_arns: comparison.added_task_arns,
      removed_task_arns: comparison.removed_task_arns,
      task_definition_changed: comparison.task_definition_changed,
    },
  };
}

// Missing and malformed inputs are evidence, not an error: the verdict records
// that the comparison could not be established instead of failing the step and
// leaving the failure unattributed.
export async function readOptionalEnvironmentJson(path) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    return { record: null, problem: `${path} is missing` };
  }
  try {
    return { record: JSON.parse(bytes.toString()), problem: null };
  } catch {
    return { record: null, problem: `${path} is not valid JSON` };
  }
}

async function emitGithubOutputs(record) {
  const target = process.env.GITHUB_OUTPUT;
  if (!target) return;
  await appendFile(target, [`verdict=${record.verdict}`, `product_failure_asserted=${record.product_failure_asserted}`,
    `reason=${record.reason}`].map(line => `${line}\n`).join(''));
}

async function emitStepSummary(record) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  const lines = [
    `### Beta environment verdict: ${record.verdict}`,
    '',
    `- suite outcome: ${record.suite_outcome}`,
    `- worker identity compared across the suite: ${record.identity_coverage === 'established' ? 'yes' : 'no'}`,
    `- product failure asserted: ${record.product_failure_asserted ? 'yes' : 'no'}`,
    `- ${record.reason}`,
  ];
  if (record.comparison.added_task_arns.length || record.comparison.removed_task_arns.length) {
    lines.push(`- worker tasks added: ${record.comparison.added_task_arns.join(', ') || 'none'}`);
    lines.push(`- worker tasks removed: ${record.comparison.removed_task_arns.join(', ') || 'none'}`);
  }
  await appendFile(target, `${lines.join('\n')}\n`);
}

// The private AWS reader for the CLI: the gate workflow holds the scoped Beta credentials
// and no Playwright spec creates an AWS client, so the reader stays inside the module the
// workflow invokes instead of being shared with the suite.
function environmentAwsReader(profile) {
  return args => JSON.parse(execFileSync('aws', [...args, '--region', BETA_REGION,
    ...(profile ? ['--profile', profile] : []), '--output', 'json'], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, AWS_PAGER: '' },
  }));
}

async function capture({ phase, output }) {
  assertE2EExecution();
  const identity = workerIdentitySnapshot(environmentAwsReader(), { phase });
  validateWorkerIdentity(identity, { phase });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(identity, null, 2)}\n`);
  console.log(`Captured ${phase} Beta worker identity: ${identity.task_arns.join(', ') || 'no active worker task'} `
    + `(${identity.identity_sha256}).`);
}

async function verdict({ suiteOutcome, beforePath, afterPath, output }) {
  const before = await readOptionalEnvironmentJson(beforePath);
  const after = await readOptionalEnvironmentJson(afterPath);
  const comparison = compareWorkerIdentity(before.record, after.record,
    { problem: before.problem ?? after.problem ?? undefined });
  const record = environmentVerdict({ comparison, suiteOutcome });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(record, null, 2)}\n`);
  await emitGithubOutputs(record);
  await emitStepSummary(record);
  console.log(`${record.verdict}: ${record.reason}`);
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseArgs({
    options: {
      phase: { type: 'string' },
      output: { type: 'string' },
      'suite-outcome': { type: 'string' },
      before: { type: 'string' },
      after: { type: 'string' },
    },
    allowPositionals: true,
  });
  const [mode] = positionals;
  if (mode === 'capture') {
    if (positionals.length !== 1) throw new Error('Capture takes no positional arguments beyond its mode');
    const phase = values.phase;
    if (!IDENTITY_PHASES.includes(phase)) throw new Error('Capture requires --phase before or --phase after');
    await capture({ phase, output: values.output ?? ENVIRONMENT_IDENTITY_PATHS[phase] });
  } else if (mode === 'verdict') {
    if (positionals.length !== 1) throw new Error('Verdict takes no positional arguments beyond its mode');
    await verdict({
      suiteOutcome: values['suite-outcome'],
      beforePath: values.before ?? ENVIRONMENT_IDENTITY_PATHS.before,
      afterPath: values.after ?? ENVIRONMENT_IDENTITY_PATHS.after,
      output: values.output ?? ENVIRONMENT_VERDICT_PATH,
    });
  } else {
    throw new Error('The E2E environment supports the capture and verdict modes');
  }
}
