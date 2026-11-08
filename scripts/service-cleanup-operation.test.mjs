import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanupExecutionArn, createCleanupOperationEnvelope, deterministicCleanupExecutionName, runCleanupOperation } from '../tests/support/service-cleanup-operation.ts';

const scope = `123456789-1-${'a'.repeat(16)}`;
const inputs = { action: 'cleanup', emails: '[]', cleanup_json: JSON.stringify({ runScope: scope,
  users: [{ sub: '10000000-0000-4000-8000-000000000001', email: 'e2e-beta-worker-0-chromium@anywear.local' }] }) };
const environment = { E2E_CLEANUP_SERVICE_SHA: 'a'.repeat(40), E2E_CLEANUP_SERVICE_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
  BETA_CLEANUP_STATE_MACHINE_VERSION_ARN: 'arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup:7', AWS_REGION: 'ap-east-1' };
const envelope = createCleanupOperationEnvelope(inputs, environment);
const name0 = deterministicCleanupExecutionName(envelope, 0);
const name1 = deterministicCleanupExecutionName(envelope, 1);
const arn0 = cleanupExecutionArn(environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN, name0);
const arn1 = cleanupExecutionArn(environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN, name1);
// The migration-only generation (#217): derived from the same envelope, so only the
// explicit allowance can reach it and the captured scope is never re-scoped.
const migrationName = deterministicCleanupExecutionName(envelope, 'migration1');
const migrationArn = cleanupExecutionArn(environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN, migrationName);
const migrationOptions = { migrationGeneration: true };
const cluster = 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear';
const task = kind => `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${(kind === 'verification' ? '1' : '2').repeat(32)}`;
const prefix = kind => kind === 'verification' ? 'beta-anywear-cleanup-verify' : 'beta-anywear-cleanup';
const definition = kind => `arn:aws:ecs:ap-east-1:650880818323:task-definition/${prefix(kind)}:7`;
const hash = text => createHash('sha256').update(text).digest('hex');

function output(input = envelope) {
  return { schema_version: 1, record_type: 'anywear_beta_cleanup_tasks', operation_mode: input.operation_mode, operation_id: input.operation_id,
    request_sha256: input.request_sha256, run_scope: scope, service_commit_sha: input.service_commit_sha,
    service_image_digest: input.service_image_digest, cluster_arn: cluster, log_group_name: '/anywear/beta/one-shot',
    ...Object.fromEntries(['verification', 'cleanup'].flatMap(kind => Object.entries({ task_arn: task(kind),
      task_definition_arn: definition(kind), task_status: 'STOPPED', exit_code: 0, log_stream_prefix: prefix(kind) }).map(([key, value]) => [`${kind}_${key}`, value]))) };
}
function description(currentName = name0, patch = {}, input = envelope, stateMachineVersionArn = environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN) {
  return { executionArn: cleanupExecutionArn(stateMachineVersionArn, currentName), name: currentName,
    stateMachineArn: stateMachineVersionArn.replace(/:[1-9][0-9]*$/, ''), stateMachineVersionArn,
    input: JSON.stringify(input), inputDetails: { included: true }, status: 'SUCCEEDED', output: JSON.stringify(output(input)), outputDetails: { included: true },
    startDate: new Date('2026-10-10T00:00:00Z'), stopDate: new Date('2026-10-10T00:00:01Z'), ...patch };
}
function committed(patch = {}, input = envelope) {
  return { schema_version: 1, record_type: 'anywear_beta_cleanup_result', source: 'beta-tester-cleanup', cleanup: 'beta-testers',
    operation_mode: input.operation_mode, operation_id: input.operation_id, request_sha256: input.request_sha256, run_scope: scope, transaction_committed: true,
    service_commit_sha: input.service_commit_sha, service_image_digest: input.service_image_digest, envelope_sha256: hash(JSON.stringify(input)),
    users: 1, missingUsers: 0, tasks: 0, outbox: 0, idempotency: 0, generations: 0, relations: 0, outfits: 0, items: 0, photos: 0, objects: 0, objectsMissing: 0,
    dlq: { deleted: 0, preserved: 0 }, ...patch };
}

/** One artifact witness source, in the shape the reconcile supplies and the record restates. */
function witnessSource(patch = {}) {
  return { artifact_id: 12527925184, artifact_name: 'beta-account-reconcile-40012312740-1',
    artifact_digest: `sha256:${'d'.repeat(64)}`, file: 'service-cleanup-1-38851867995-1-0000000000000000.json',
    record_sha256: 'e'.repeat(64), ...patch };
}

/** The two live-root task entries a verified record carries for one envelope. */
function liveTaskEntries(input = envelope) {
  return ['verification', 'cleanup'].map(kind => ({
    task_arn: task(kind), task_definition_arn: definition(kind), kind, status: 'STOPPED', exit_code: 0,
    image_digest: input.service_image_digest, service_commit_sha: input.service_commit_sha,
    log_group: '/anywear/beta/one-shot', log_stream: `${prefix(kind)}/OneShot/${task(kind).split('/').at(-1)}`,
    proof_origin: 'live', snapshot_sha256: 'f'.repeat(64),
    ...(kind === 'cleanup' ? { envelope_sha256: hash(JSON.stringify(input)) } : {}),
  }));
}

/** One complete v4 verified live-root operation record, bound to the fixture's execution instance. */
function operationRecord({ input = envelope, proofOrigin = 'live', tasks = liveTaskEntries(input), committedResult = committed({}, input),
  executionName = deterministicCleanupExecutionName(input, 0), startedAt = '2026-10-10T00:00:00.000Z',
  stoppedAt = '2026-10-10T00:00:01.000Z', patch = {} } = {}) {
  return { schema_version: 4, record_type: 'anywear_e2e_service_cleanup_operation', operation: {
    operation_mode: 'normal', state_machine_version_arn: environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN,
    execution_arn: cleanupExecutionArn(environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN, executionName),
    execution_name: executionName, started_at: startedAt, stopped_at: stoppedAt, status: 'SUCCEEDED',
    proof_status: 'verified', proof_origin: proofOrigin, input_sha256: hash(JSON.stringify(input)), input,
    output: output(input), tasks, committed_result: committedResult, ...patch } };
}

// The recorded #217 execution and the operation record a previous run verified into artifact
// `beta-account-reconcile-40012312740-1` (expires 2027-01-21). It is schema 3, so it is accepted
// only through the legacy reader, and it names the state-machine version `:9` from a deleted
// stack lifetime while its execution ARN stays the unqualified one this dispatch re-derives.
const RECORDED_CLEANUP_REQUEST = '{"runScope":"38851867995-1-0000000000000000","users":[{"sub":"d4021cae-30e1-7050-32a1-d44b23a32f56","email":"e2e-beta-38851867995-1-0000000000000000-1-f94e6900@anywear.local"}]}';
const RECORDED_SOURCE = '320ba6a4b3533773f05665291107995dc0ea20e9';
const RECORDED_IMAGE = 'sha256:02828a7611faa82a108c37f436dbcc73f8c6fa5149255fc8d1d14d8f43866510';
const RECORDED_INPUT_SHA256 = '9ffea293028445e5d287bcab0691751bfc240f33b750f1ca105da16736d0bd7c';
const RECORDED_NAME = 'beta-cleanup-38851867995-1-0000000000000000-8e12aa9ab79b504a';
const recordedInputs = { ...inputs, cleanup_json: RECORDED_CLEANUP_REQUEST };
const recordedEnvironment = { ...environment, E2E_CLEANUP_SERVICE_SHA: RECORDED_SOURCE, E2E_CLEANUP_SERVICE_IMAGE_DIGEST: RECORDED_IMAGE };
const recordedEnvelope = createCleanupOperationEnvelope(recordedInputs, recordedEnvironment);
const recordedRecord = {
  schema_version: 3,
  record_type: 'anywear_e2e_service_cleanup_operation',
  operation: {
    operation_mode: 'normal',
    state_machine_version_arn: 'arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup:9',
    execution_arn: `arn:aws:states:ap-east-1:650880818323:execution:beta-anywear-tester-cleanup:${RECORDED_NAME}`,
    execution_name: RECORDED_NAME,
    status: 'SUCCEEDED',
    proof_status: 'verified',
    input_sha256: RECORDED_INPUT_SHA256,
    input: {
      schema_version: 1,
      operation_mode: 'normal',
      operation_id: 'beta-tester-cleanup:38851867995-1-0000000000000000',
      run_scope: '38851867995-1-0000000000000000',
      request_sha256: '8e12aa9ab79b504a211e72763fa6ad15b32619148488196b03e398b1c0317589',
      service_commit_sha: RECORDED_SOURCE,
      service_image_digest: RECORDED_IMAGE,
      cleanup_request: RECORDED_CLEANUP_REQUEST,
    },
    started_at: '2026-10-23T19:39:42.419Z',
    stopped_at: '2026-10-23T19:41:46.829Z',
    output: {
      schema_version: 1,
      record_type: 'anywear_beta_cleanup_tasks',
      service_commit_sha: RECORDED_SOURCE,
      service_image_digest: RECORDED_IMAGE,
      cluster_arn: 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear',
      log_group_name: '/anywear/beta/one-shot',
      verification_log_stream_prefix: 'beta-anywear-cleanup-verify',
      cleanup_log_stream_prefix: 'beta-anywear-cleanup',
      run_scope: '38851867995-1-0000000000000000',
      verification_exit_code: 0,
      verification_task_definition_arn: 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-cleanup-verify:38',
      verification_task_arn: 'arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/baed47d109214ef799eee0b38a64109e',
      verification_task_status: 'STOPPED',
      cleanup_task_definition_arn: 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-cleanup:40',
      operation_id: 'beta-tester-cleanup:38851867995-1-0000000000000000',
      cleanup_task_status: 'STOPPED',
      cleanup_exit_code: 0,
      cleanup_task_arn: 'arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/c98f9eff853d406a8097d3c1c7436fec',
      request_sha256: '8e12aa9ab79b504a211e72763fa6ad15b32619148488196b03e398b1c0317589',
    },
    tasks: [
      { task_arn: 'arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/baed47d109214ef799eee0b38a64109e',
        task_definition_arn: 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-cleanup-verify:38',
        kind: 'verification', status: 'STOPPED', exit_code: 0, image_digest: RECORDED_IMAGE, service_commit_sha: RECORDED_SOURCE,
        log_group: '/anywear/beta/one-shot', log_stream: 'beta-anywear-cleanup-verify/OneShot/baed47d109214ef799eee0b38a64109e',
        proof_origin: 'live', snapshot_sha256: 'bb9104e074da029b476591e8f5b6d5f21db0d2cc8d7523e99e760d7c3764b93e' },
      { task_arn: 'arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/c98f9eff853d406a8097d3c1c7436fec',
        task_definition_arn: 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-cleanup:40',
        kind: 'cleanup', status: 'STOPPED', exit_code: 0, image_digest: RECORDED_IMAGE, service_commit_sha: RECORDED_SOURCE,
        log_group: '/anywear/beta/one-shot', log_stream: 'beta-anywear-cleanup/OneShot/c98f9eff853d406a8097d3c1c7436fec',
        proof_origin: 'live', snapshot_sha256: '266d6f576ef8a2c763aa5e80ae8249b24e071230481aa97edabd21e0be6edecf',
        envelope_sha256: RECORDED_INPUT_SHA256 },
    ],
    committed_result: {
      schema_version: 1, source: 'beta-tester-cleanup', cleanup: 'beta-testers',
      operation_id: 'beta-tester-cleanup:38851867995-1-0000000000000000',
      request_sha256: '8e12aa9ab79b504a211e72763fa6ad15b32619148488196b03e398b1c0317589',
      operation_mode: 'normal', run_scope: '38851867995-1-0000000000000000', transaction_committed: true,
      users: 0, missingUsers: 1, tasks: 0, outbox: 0, idempotency: 0, generations: 0, relations: 0, outfits: 0, items: 0,
      photos: 0, objects: 0, objectsMissing: 0, dlq: { deleted: 0, preserved: 0 },
      record_type: 'anywear_beta_cleanup_result', service_commit_sha: RECORDED_SOURCE, service_image_digest: RECORDED_IMAGE,
      envelope_sha256: RECORDED_INPUT_SHA256,
    },
  },
};

/**
 * A stateful two-generation mock. Generation 0 is absent unless seeded, and a
 * start inserts the generation it names; describe reports the current status of
 * that exact execution under the envelope and version it was seeded with.
 * Nothing here models Step Functions execution history: the verifier reads the
 * cleanup marker and, once ECS has forgotten a stopped task, the caller's
 * artifact witness — it never reads execution history.
 */
function fixture(options = {}) {
  const calls = [];
  const executions = new Map();
  let logCalls = 0;
  const currentVersionArn = options.currentVersionArn ?? environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN;
  const seed = (generation, value) => {
    const record = typeof value === 'string' ? { status: value } : value;
    const executionName = deterministicCleanupExecutionName(record.envelope ?? envelope, generation);
    executions.set(executionName, { status: record.status, patch: record.patch ?? {},
      envelope: record.envelope ?? envelope, versionArn: record.versionArn ?? currentVersionArn });
    return executionName;
  };
  const insert = (executionName, status) => {
    executions.set(executionName, { status, patch: {}, envelope, versionArn: currentVersionArn });
    return executionName;
  };
  for (const [generation, value] of Object.entries(options.existing ?? {})) {
    if (value) seed(generation === 'migration1' ? 'migration1' : Number(generation), value);
  }
  const proofEnvelope = options.proofEnvelope ?? envelope;
  const io = { calls, executions,
    async start(input, executionName) {
      calls.push({ start: executionName, input });
      if (options.startError) {
        if (['ExecutionAlreadyExists', 'TimeoutError', 'RequestTimeout', 'NetworkingError', 'InternalServerError', 'ServiceUnavailable'].includes(options.startError)) {
          insert(executionName, options.newStatus ?? 'SUCCEEDED');
        }
        throw Object.assign(new Error('simulated'), { name: options.startError });
      }
      insert(executionName, options.newStatus ?? 'SUCCEEDED');
      return { executionArn: cleanupExecutionArn(currentVersionArn, executionName) };
    },
    async describe(executionArn) {
      calls.push({ describe: executionArn });
      const executionName = executionArn.split(':').at(-1);
      const record = executions.get(executionName);
      if (!record) throw Object.assign(new Error('Execution does not exist'), { name: 'ExecutionDoesNotExist' });
      const patch = { ...record.patch, ...(options.description?.(record.status, executionName) ?? {}) };
      return description(executionName, { status: record.status, ...patch }, record.envelope, record.versionArn);
    },
    async aws(args) {
      calls.push({ aws: args });
      if (args[0] === 'stepfunctions') throw new Error('The single rule never reads execution history');
      if (args[1] === 'list-tasks') return options.inventory?.(args, calls) ?? { taskArns: [] };
      if (args[1] === 'describe-tasks') {
        // The requested ARN is echoed back, so a recorded execution's real task identities can be
        // answered as MISSING exactly as ECS answers them once the stopped task has aged out.
        const requested = args.at(-1);
        const kind = requested === task('verification') ? 'verification' : 'cleanup';
        if (options.missing?.includes(kind)) return { failures: [{ arn: requested, reason: 'MISSING' }], tasks: [] };
        if (options.missingMalformed?.includes(kind)) return { failures: [{ arn: requested, reason: 'MISSING', detail: 'unexpected' }], tasks: [] };
        const value = { taskArn: task(kind), clusterArn: cluster, taskDefinitionArn: definition(kind), lastStatus: 'STOPPED',
          desiredStatus: 'STOPPED', startedBy: 'AWS Step Functions',
          containers: [{ name: 'OneShot', lastStatus: 'STOPPED', exitCode: 0, imageDigest: proofEnvelope.service_image_digest }],
          overrides: { containerOverrides: kind === 'verification' ? [] : [{ name: 'OneShot', command: ['node', 'dist/ops/beta-cleanup-operation.js', JSON.stringify(proofEnvelope)] }], inferenceAcceleratorOverrides: [] } };
        return { failures: [], tasks: [options.task?.(value, kind) ?? value] };
      }
      if (args[1] === 'describe-task-definition') {
        const kind = args.at(-1) === definition('verification') ? 'verification' : 'cleanup';
        const value = { taskDefinitionArn: definition(kind), cpu: '512', memory: '1024', networkMode: 'awsvpc', requiresCompatibilities: ['FARGATE'], containerDefinitions: [{ name: 'OneShot',
          image: `650880818323.dkr.ecr.ap-east-1.amazonaws.com/anywear@${proofEnvelope.service_image_digest}`,
          command: kind === 'verification' ? ['node', 'dist/verify.js'] : ['node', 'dist/ops/beta-cleanup-operation.js'],
          environment: [{ name: 'SERVICE_COMMIT_SHA', value: proofEnvelope.service_commit_sha }, { name: 'IMAGE_DIGEST', value: proofEnvelope.service_image_digest }],
          logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': '/anywear/beta/one-shot', 'awslogs-region': 'ap-east-1', 'awslogs-stream-prefix': prefix(kind) } } }] };
        return { taskDefinition: options.definition?.(value, kind) ?? value };
      }
      const token = args.includes('--next-token') ? args.at(-1) : undefined;
      logCalls += 1;
      return options.logs?.(token, logCalls) ?? { events: token ? [] : [{ message: `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed({}, proofEnvelope))}` }], nextForwardToken: 'end' };
    },
    async sleep() {
      calls.push({ sleep: 1 });
      if (options.completeRunning) for (const record of executions.values()) if (record.status === 'RUNNING') record.status = 'SUCCEEDED';
    },
  };
  return io;
}
async function run(options = {}, environmentPatch = {}, before, operationOptions) {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-cleanup-proof-'));
  const evidencePath = join(directory, 'operation.json');
  const effective = { ...environment, ...environmentPatch };
  const cleanupInputs = options.inputs ?? inputs;
  const io = fixture({ currentVersionArn: effective.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN, ...options });
  try {
    const extra = await before?.(directory);
    const execution = () => runCleanupOperation(cleanupInputs, { ...effective, E2E_SERVICE_CLEANUP_EVIDENCE_PATH: evidencePath, ...extra }, io, operationOptions);
    return await options.verify(execution, io, evidencePath);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('the envelope always emits normal mode with no attempt, and a Service attempt echo is refused', async () => {
  assert.deepEqual(Object.keys(envelope).sort(), ['cleanup_request', 'operation_id', 'operation_mode', 'request_sha256', 'run_scope',
    'schema_version', 'service_commit_sha', 'service_image_digest'].sort());
  assert.equal(envelope.operation_mode, 'normal');
  assert.equal(Object.hasOwn(envelope, 'recovery_attempt'), false);
  assert.equal(envelope.operation_id, `beta-tester-cleanup:${scope}`);
  assert.equal(JSON.stringify(envelope).includes('recovery_attempt'), false);
  // Drive the production committed-result proof with an attempt echo. The
  // regression is non-vacuous: `validateCommitted` (through `readCommitted`)
  // must refuse the marker even though E2E never emits an attempt.
  await run({ existing: { 0: 'SUCCEEDED' },
    logs: token => ({ events: token ? [] : [{ message: `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed({ recovery_attempt: 1 }))}` }], nextForwardToken: 'end' }),
    verify: async (execute, _io, path) => {
      await assert.rejects(execute(), /identities retained/);
      const operation = JSON.parse(await readFile(path, 'utf8')).operation;
      assert.equal(operation.refusal_phase, 'completion_proof');
      assert.equal(operation.refusal_category, 'completion_proof_unavailable');
    } });
});

test('the captured scope derives exactly two ordinary names and one migration-only name', () => {
  assert.equal(name0, `beta-cleanup-${scope}-${envelope.request_sha256.slice(0, 16)}`);
  assert.equal(name1, `${name0}-retry1`);
  // The migration name is derived only from the envelope and the migration generation: it
  // carries no recovery identity, attempt number, reconcile run or re-scoped address.
  assert.equal(migrationName, `${name0}-migration1`);
  assert.equal(deterministicCleanupExecutionName(envelope, 'migration1'), migrationName);
  assert.ok(cleanupExecutionArn(environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN, migrationName));
  assert.throws(() => deterministicCleanupExecutionName(envelope, 2));
  assert.throws(() => deterministicCleanupExecutionName(envelope, -1));
  assert.throws(() => deterministicCleanupExecutionName(envelope, 1.5));
  // Only the accepted generations are nameable: a near-miss suffix is refused, not coerced.
  for (const unknown of ['migration2', 'migration0', 'retry1', 'Migration1', '']) {
    assert.throws(() => deterministicCleanupExecutionName(envelope, unknown), String(unknown));
  }
  // A different captured request is a different operation and therefore a different name,
  // while the same envelope always derives the same one.
  const otherScope = `987654321-1-${'e'.repeat(16)}`;
  const otherEnvelope = createCleanupOperationEnvelope({ ...inputs, cleanup_json: JSON.stringify({ runScope: otherScope,
    users: [{ sub: '10000000-0000-4000-8000-000000000001', email: `e2e-beta-${otherScope}-0-a1b2c3d4@anywear.local` }] }) }, environment);
  assert.notEqual(deterministicCleanupExecutionName(otherEnvelope, 'migration1'), migrationName);
  // The production surface no longer derives a recovery-shaped execution name.
  const source = readFileSync(new URL('../tests/support/service-cleanup-operation.ts', import.meta.url), 'utf8');
  assert.equal(source.includes('beta-cleanup-recovery-'), false);
});

test('a maximum-length run scope still has a startable, in-limit retry and migration name', () => {
  const maxScope = `12345678901234567890-999999-${'a'.repeat(16)}`;
  const maxInputs = { ...inputs, cleanup_json: JSON.stringify({ runScope: maxScope,
    users: [{ sub: '10000000-0000-4000-8000-000000000001', email: `e2e-beta-${maxScope}-0-a1b2c3d4@anywear.local` }] }) };
  const maxEnvelope = createCleanupOperationEnvelope(maxInputs, environment);
  const base = deterministicCleanupExecutionName(maxEnvelope, 0);
  const retry = deterministicCleanupExecutionName(maxEnvelope, 1);
  const migration = deterministicCleanupExecutionName(maxEnvelope, 'migration1');
  assert.equal(base.length, 74);
  assert.equal(retry, `${base.slice(0, 72)}-retry1`);
  assert.equal(retry.length, 79);
  // The migration suffix is longer than `-retry1`, so the same 72-character base bound is
  // applied to a shorter prefix: the name is exactly the execution-name limit, never over it.
  assert.equal(migration, `${base.slice(0, 69)}-migration1`);
  assert.equal(migration.length, 80);
  assert.ok(cleanupExecutionArn(environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN, migration));
  assert.ok(cleanupExecutionArn(environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN, retry));
});

test('bounded canonical worker envelope and execution identity reject malformed source, scope and foreign versions', () => {
  for (const json of [` ${inputs.cleanup_json}`, inputs.cleanup_json.replace(scope, `${scope}x`), inputs.cleanup_json.replace('"users":', '"runScope":"duplicate","users":')]) {
    assert.throws(() => createCleanupOperationEnvelope({ ...inputs, cleanup_json: json }, environment));
  }
  assert.throws(() => cleanupExecutionArn(environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN.replace(':7', ''), name0));
  assert.throws(() => createCleanupOperationEnvelope(inputs, { ...environment, E2E_CLEANUP_SERVICE_IMAGE_DIGEST: 'latest' }));
});

test('the scoped Beta worker address is accepted for its own run scope and never for another', () => {
  // Issue #129: attempt addresses are `e2e-beta-{runScope}-{slot}-{8hex}`, which
  // is the family the Service's own cleanup parser matches. This run's address
  // is a valid envelope input; a foreign, malformed or stable-row address is
  // either re-scoped (refused) or kept only as a historical capture.
  const scoped = `e2e-beta-${scope}-0-a1b2c3d4@anywear.local`;
  const withUser = (email) => ({ ...inputs, cleanup_json: JSON.stringify({ runScope: scope, users: [{ sub: '10000000-0000-4000-8000-000000000001', email }] }) });
  assert.equal(JSON.parse(createCleanupOperationEnvelope(withUser(scoped), environment).cleanup_request).users[0].email, scoped);
  // The retained stable row a pre-#129 manifest captured stays cleanable.
  const stable = withUser('e2e-beta-worker-0-chromium@anywear.local');
  assert.equal(JSON.parse(createCleanupOperationEnvelope(stable, environment).cleanup_request).users[0].email,
    'e2e-beta-worker-0-chromium@anywear.local');
  for (const foreign of [
    `e2e-beta-123456790-1-${'a'.repeat(16)}-0-a1b2c3d4@anywear.local`,
    `e2e-beta-${scope}-0-a1b2c3d4e@anywear.local`,
    `e2e-beta-${scope}-0-A1B2C3D4@anywear.local`,
    `e2e-beta-${scope}-0-a1b2c3d4@example.com`,
    `e2e-beta-allowlist-${scope}-primary@anywear.local`,
  ]) assert.throws(() => createCleanupOperationEnvelope(withUser(foreign), environment), /exact captured worker subjects/, foreign);
});

test('normal cleanup persists pending evidence and requires actual tasks and a unique committed marker', async () => {
  await run({ verify: async (execute, io, path) => {
    const originalStart = io.start;
    io.start = async (...args) => {
      assert.equal(JSON.parse(await readFile(path, 'utf8')).operation.proof_status, 'pending');
      return originalStart(...args);
    };
    const result = await execute();
    assert.equal(result.operation.proof_status, 'verified');
    assert.equal(result.operation.proof_origin, 'live');
    assert.equal(result.operation.committed_result.transaction_committed, true);
    assert.equal(result.operation.tasks.length, 2);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), result);
    assert.equal(io.calls.filter(call => call.aws?.[0] === 'ecs' && call.aws[1] !== 'list-tasks').length, 4);
  } });
});

test('a SUCCEEDED execution whose two ECS tasks are MISSING verifies from the completion marker', async () => {
  // (A) The first mandated regression: the observed #217 shape — both stopped tasks aged out while
  // the Service's own completion bytes survive — is a marker-tier verification, not a refusal.
  await run({ existing: { 0: 'SUCCEEDED' }, missing: ['verification', 'cleanup'], verify: async (execute, io) => {
    const result = await execute();
    assert.equal(result.operation.proof_status, 'verified');
    assert.equal(result.operation.proof_origin, 'marker');
    assert.equal(result.operation.committed_result.transaction_committed, true);
    assert.equal(Object.hasOwn(result.operation, 'tasks'), false, 'a marker proof never presents half a task pair');
    assert.equal(Object.hasOwn(result.operation, 'artifact_source'), false);
    // Two describe-tasks reads answer MISSING; no definition is read and no marker wait is retried.
    assert.equal(io.calls.filter(call => call.aws?.[1] === 'describe-tasks').length, 2);
    assert.equal(io.calls.filter(call => call.aws?.[1] === 'describe-task-definition').length, 0);
    assert.equal(io.calls.filter(call => call.aws?.[0] === 'logs').length, 2);
    assert.equal(io.calls.some(call => call.aws?.[0] === 'stepfunctions'), false);
  } });
});

test('an aged-out execution with no marker refuses at task_proof and keeps the identity unresolved', async () => {
  // (B) The second mandated regression: when no durable proof survives, the operator sees exactly
  // today's refusal — the same phase, category and failure sentence — and no committed result.
  await run({ existing: { 0: 'SUCCEEDED' }, missing: ['verification', 'cleanup'],
    logs: () => ({ events: [], nextForwardToken: 'end' }), verify: async (execute, _io, path) => {
      await assert.rejects(execute(), /identities retained/);
      const operation = JSON.parse(await readFile(path, 'utf8')).operation;
      assert.equal(operation.proof_status, 'refused');
      assert.equal(operation.refusal_phase, 'task_proof');
      assert.equal(operation.refusal_category, 'task_proof_unavailable');
      assert.equal(operation.failure, 'Exact execution/task/committed-result proof unavailable; Cognito identities retained');
      assert.equal(Object.hasOwn(operation, 'committed_result'), false);
      assert.equal(Object.hasOwn(operation, 'tasks'), false);
    } });
});

test('one MISSING leg with a surviving marker verifies as marker and never consults the artifact lookup', async () => {
  // (C) The boundary is asymmetric: one clean absence opens the marker tier, and the observed leg
  // is still validated in full. Nothing calls the witness lookup.
  let recoveryCalls = 0;
  const recovery = () => { recoveryCalls += 1; return { record: operationRecord(), source: witnessSource() }; };
  await run({ existing: { 0: 'SUCCEEDED' }, missing: ['verification'], verify: async (execute, io) => {
    const result = await execute();
    assert.equal(result.operation.proof_status, 'verified');
    assert.equal(result.operation.proof_origin, 'marker');
    assert.equal(Object.hasOwn(result.operation, 'tasks'), false);
    assert.equal(io.calls.filter(call => call.aws?.[1] === 'describe-task-definition').length, 1);
    assert.equal(recoveryCalls, 0, 'the marker tier does not consult an archived record');
  } }, {}, undefined, { recovery });
});

test('one MISSING leg with no marker refuses rather than accepting a record for the observable task', async () => {
  // (D) An archived record never stands in for a task ECS can still show.
  let recoveryCalls = 0;
  const recovery = () => { recoveryCalls += 1; return { record: operationRecord(), source: witnessSource() }; };
  await run({ existing: { 0: 'SUCCEEDED' }, missing: ['verification'],
    logs: () => ({ events: [], nextForwardToken: 'end' }), verify: async (execute, _io, path) => {
      await assert.rejects(execute(), /identities retained/);
      const operation = JSON.parse(await readFile(path, 'utf8')).operation;
      assert.equal(operation.refusal_phase, 'task_proof');
      assert.equal(operation.refusal_category, 'task_proof_unavailable');
      assert.equal(recoveryCalls, 0, 'the artifact tier is closed while a task is observable');
    } }, {}, undefined, { recovery });
});

test('both MISSING with no marker verifies from a verified operation record as an artifact proof', async () => {
  // (E) The artifact tier: every binding re-proved, the record's source restated, and both task
  // entries stamped `artifact` so a copy is never laundered as a live read.
  const witness = { record: operationRecord(), source: witnessSource() };
  await run({ existing: { 0: 'SUCCEEDED' }, missing: ['verification', 'cleanup'],
    logs: () => ({ events: [], nextForwardToken: 'end' }), verify: async (execute, io, path) => {
      const result = await execute();
      assert.equal(result.operation.proof_status, 'verified');
      assert.equal(result.operation.proof_origin, 'artifact');
      assert.deepEqual(result.operation.artifact_source, witnessSource());
      assert.deepEqual(result.operation.tasks.map(entry => entry.proof_origin), ['artifact', 'artifact']);
      assert.equal(result.operation.tasks[1].envelope_sha256, hash(JSON.stringify(envelope)));
      assert.equal(result.operation.committed_result.transaction_committed, true);
      assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), result);
      assert.equal(io.calls.filter(call => call.aws?.[1] === 'describe-task-definition').length, 0);
      assert.equal(io.calls.some(call => call.aws?.[0] === 'stepfunctions'), false);
    } }, {}, undefined, { recovery: async () => witness });
});

test('the recorded #217 execution is accepted from its own artifact record through the legacy reader', async () => {
  // (F) The recorded replay. The envelope is rebuilt from the artifact's own `cleanup_request`
  // bytes with the recorded Service source/image, and its hash must be the recorded one. The
  // record names state-machine version `:9` while this environment's is `:7`, which pins that the
  // version ARN is deliberately not compared; the execution ARN is unqualified and matches.
  assert.equal(hash(JSON.stringify(recordedEnvelope)), RECORDED_INPUT_SHA256);
  assert.equal(deterministicCleanupExecutionName(recordedEnvelope, 0), RECORDED_NAME);
  assert.equal(recordedRecord.operation.state_machine_version_arn.endsWith(':9'), true);
  assert.equal(environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN.endsWith(':7'), true);
  const witness = { record: recordedRecord, source: witnessSource({ artifact_id: 12527925184,
    artifact_name: 'beta-account-reconcile-40012312740-1', file: 'service-cleanup-1-38851867995-1-0000000000000000.json' }) };
  await run({ inputs: recordedInputs, proofEnvelope: recordedEnvelope,
    existing: { 0: { status: 'SUCCEEDED', envelope: recordedEnvelope } },
    // Seed the live description from the recorded record: the fixture's fixed dates and
    // synthesized task ARNs would fail the Execution-output and Instance bindings otherwise.
    description: () => ({ output: JSON.stringify(recordedRecord.operation.output),
      startDate: new Date(recordedRecord.operation.started_at), stopDate: new Date(recordedRecord.operation.stopped_at) }),
    missing: ['verification', 'cleanup'], logs: () => ({ events: [], nextForwardToken: 'end' }),
    verify: async (execute, io, path) => {
      const result = await execute();
      assert.equal(result.operation.proof_status, 'verified');
      assert.equal(result.operation.proof_origin, 'artifact');
      assert.equal(result.operation.execution_name, RECORDED_NAME);
      assert.equal(result.operation.execution_arn, recordedRecord.operation.execution_arn);
      assert.equal(result.operation.committed_result.users, 0);
      assert.equal(result.operation.committed_result.missingUsers, 1);
      assert.equal(result.operation.committed_result.objects, 0);
      assert.equal(result.operation.committed_result.objectsMissing, 0);
      assert.equal(result.operation.committed_result.transaction_committed, true);
      assert.deepEqual(result.operation.tasks.map(entry => entry.proof_origin), ['artifact', 'artifact']);
      // The descent hash of the bytes the original run read is preserved; only the provenance
      // changes, so a copy is never laundered as a live read.
      assert.equal(result.operation.tasks[1].snapshot_sha256, recordedRecord.operation.tasks[1].snapshot_sha256);
      assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), result);
      assert.equal(io.calls.filter(call => call.aws?.[1] === 'describe-task-definition').length, 0);
      assert.equal(io.calls.some(call => call.aws?.[0] === 'stepfunctions'), false);
    } }, recordedEnvironment, undefined, { recovery: async () => witness });
});

test('a malformed ECS failure object refuses at task_proof and never consults a witness', async () => {
  // (G) `detail: 'unexpected'` throws in `exactObject` before the MISSING test: absence and
  // contradiction are different answers.
  let recoveryCalls = 0;
  const recovery = () => { recoveryCalls += 1; return { record: operationRecord(), source: witnessSource() }; };
  await run({ existing: { 0: 'SUCCEEDED' }, missingMalformed: ['cleanup'], verify: async (execute, _io, path) => {
    await assert.rejects(execute(), /identities retained/);
    const operation = JSON.parse(await readFile(path, 'utf8')).operation;
    assert.equal(operation.refusal_phase, 'task_proof');
    assert.equal(operation.refusal_category, 'task_proof_unavailable');
    assert.equal(Object.hasOwn(operation, 'committed_result'), false);
    assert.equal(recoveryCalls, 0);
  } }, {}, undefined, { recovery });
});

test('a witness that fails any binding is refused, never partially accepted', async () => {
  // The binding table is the whole proof: an envelope, execution, instance, task or committed
  // mismatch is a refusal at `task_proof`, and a source record that is not itself a live read is
  // not a source at all.
  const base = operationRecord();
  const live = liveTaskEntries();
  const variants = [
    ['envelope hash', { ...base, operation: { ...base.operation, input_sha256: 'c'.repeat(64) } }],
    ['envelope bytes', { ...base, operation: { ...base.operation, input: { ...envelope, service_commit_sha: 'c'.repeat(40) } } }],
    ['execution name', { ...base, operation: { ...base.operation, execution_name: `${name0}x` } }],
    ['execution arn', { ...base, operation: { ...base.operation, execution_arn: `${arn0}x` } }],
    ['output', { ...base, operation: { ...base.operation, output: { ...output(), request_sha256: 'f'.repeat(64) } } }],
    ['instance', { ...base, operation: { ...base.operation, stopped_at: '2026-10-10T00:00:09.000Z' } }],
    ['task identity', { ...base, operation: { ...base.operation, tasks: [live[1], live[0]] } }],
    ['committed counters', { ...base, operation: { ...base.operation, committed_result: committed({ transaction_committed: false }) } }],
    ['artifact-stamped tasks', { ...base, operation: { ...base.operation, tasks: live.map(entry => ({ ...entry, proof_origin: 'artifact' })) } }],
    ['foreign schema', { ...base, schema_version: 5 }],
    ['refused source', { ...base, operation: { ...base.operation, proof_status: 'refused' } }],
  ];
  for (const [label, record] of variants) {
    await run({ existing: { 0: 'SUCCEEDED' }, missing: ['verification', 'cleanup'],
      logs: () => ({ events: [], nextForwardToken: 'end' }), verify: async (execute, _io, path) => {
        await assert.rejects(execute(), /identities retained/, label);
        const operation = JSON.parse(await readFile(path, 'utf8')).operation;
        assert.equal(operation.refusal_phase, 'task_proof', label);
        assert.equal(operation.refusal_category, 'task_proof_unavailable', label);
        assert.equal(Object.hasOwn(operation, 'committed_result'), false, label);
        assert.equal(Object.hasOwn(operation, 'artifact_source'), false, label);
      } }, {}, undefined, { recovery: async () => ({ record, source: witnessSource() }) });
  }
});

test('an absent generation 0 starts exactly once and verifies the committed result', async () => {
  await run({ verify: async (execute, io) => {
    const result = await execute();
    assert.equal(result.operation.execution_name, name0);
    assert.equal(result.operation.execution_arn, arn0);
    assert.equal(result.operation.proof_status, 'verified');
    assert.equal(io.calls.filter(call => call.start).length, 1);
    assert.equal(io.calls.filter(call => call.start)[0].start, name0);
    assert.deepEqual(JSON.parse(JSON.stringify(io.calls.filter(call => call.start)[0].input)), envelope);
    // One absent-name resolution and one observation of the started execution.
    assert.equal(io.calls.filter(call => call.describe).length, 2);
  } });
});

test('an already running execution is resumed and verified without a new start', async () => {
  await run({ existing: { 0: 'RUNNING' }, completeRunning: true, verify: async (execute, io) => {
    const result = await execute();
    assert.equal(result.operation.proof_status, 'verified');
    assert.equal(result.operation.execution_name, name0);
    assert.equal(io.calls.filter(call => call.start).length, 0);
    assert.deepEqual(io.calls.filter(call => call.describe).map(call => call.describe), [arn0, arn0]);
  } });
});

test('an already succeeded execution is verified from one describe without a start', async () => {
  await run({ existing: { 0: 'SUCCEEDED' }, verify: async (execute, io) => {
    const result = await execute();
    assert.equal(result.operation.proof_status, 'verified');
    assert.equal(result.operation.execution_name, name0);
    assert.equal(result.operation.status, 'SUCCEEDED');
    assert.equal(io.calls.filter(call => call.start).length, 0);
    assert.equal(io.calls.filter(call => call.describe).length, 1);
  } });
});

test('one retry after a terminal failure uses one describe, one cleanup-family inventory and one start', async () => {
  await run({ existing: { 0: 'FAILED' }, verify: async (execute, io, path) => {
    const result = await execute();
    assert.equal(result.operation.execution_name, name1);
    assert.equal(result.operation.execution_arn, arn1);
    assert.equal(result.operation.proof_status, 'verified');
    assert.deepEqual(result.operation.preceding_execution, { execution_arn: arn0, status: 'FAILED',
      stopped_at: '2026-10-10T00:00:01.000Z', cleanup_families: ['beta-anywear-cleanup', 'beta-anywear-cleanup-verify', 'beta-anywear-cleanup-acceptance'] });
    assert.equal(io.calls.filter(call => call.start).length, 1);
    assert.equal(io.calls.filter(call => call.start)[0].start, name1);
    assert.deepEqual(JSON.parse(JSON.stringify(io.calls.filter(call => call.start)[0].input)), envelope);
    // Exactly the predecessor describe, the retry-name resolution and the
    // observation of the execution this dispatch started. An extra speculative
    // describe would change this sequence.
    assert.deepEqual(io.calls.filter(call => call.describe).map(call => call.describe), [arn0, arn1, arn1]);
    assert.deepEqual(io.calls.filter(call => call.aws?.[1] === 'list-tasks').map(call => call.aws[call.aws.indexOf('--desired-status') + 1]),
      ['RUNNING', 'RUNNING', 'RUNNING']);
    assert.deepEqual(io.calls.filter(call => call.aws?.[1] === 'list-tasks').map(call => call.aws[call.aws.indexOf('--family') + 1]),
      ['beta-anywear-cleanup', 'beta-anywear-cleanup-verify', 'beta-anywear-cleanup-acceptance']);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), result);
  } });
});

test('a repeated dispatch onto the existing -retry1 neither starts a duplicate nor re-runs the completed cleanup', async () => {
  await run({ existing: { 0: 'FAILED' }, verify: async (execute, io) => {
    const first = await execute();
    assert.equal(first.operation.execution_name, name1);
    assert.equal(io.calls.filter(call => call.start).length, 1);
    const second = await execute();
    assert.equal(second.operation.proof_status, 'verified');
    assert.equal(second.operation.execution_name, name1);
    assert.equal(io.calls.filter(call => call.start).length, 1);
    assert.equal(second.operation.preceding_execution.execution_arn, arn0);
  } });
});

test('a dispatch that finds -retry1 already terminal non-success refuses and starts no third execution', async () => {
  await run({ existing: { 0: 'FAILED', 1: 'FAILED' }, verify: async (execute, io, path) => {
    await assert.rejects(execute(), /identities retained/);
    assert.equal(io.calls.filter(call => call.start).length, 0);
    const operation = JSON.parse(await readFile(path, 'utf8')).operation;
    assert.equal(operation.execution_name, name1);
    assert.equal(operation.refusal_phase, 'retry_eligibility');
    assert.equal(operation.refusal_category, 'retry_not_authorized');
    assert.equal(operation.preceding_execution.execution_arn, arn0);
  } });
});

test('an ordinary dispatch refuses the migration name and still refuses a third generation', async () => {
  // The allowance is absent, so neither an absent nor an already-succeeded `-migration1` is
  // observed and the unchanged two-name rule refuses with `retry_not_authorized`.
  for (const seeded of [undefined, 'SUCCEEDED']) {
    await run({ existing: { 0: 'FAILED', 1: 'FAILED', migration1: seeded }, verify: async (execute, io, path) => {
      await assert.rejects(execute(), /identities retained/);
      assert.equal(io.calls.filter(call => call.start).length, 0);
      assert.equal(io.calls.some(call => typeof call.describe === 'string' && call.describe.endsWith('-migration1')), false,
        'an ordinary dispatch never resolves the migration name');
      const operation = JSON.parse(await readFile(path, 'utf8')).operation;
      assert.equal(operation.execution_name, name1);
      assert.equal(operation.refusal_phase, 'retry_eligibility');
      assert.equal(operation.refusal_category, 'retry_not_authorized');
    } });
  }
});

test('the migration allowance is explicit: absent or false keeps the two-name rule, a non-boolean fails closed', async () => {
  for (const migrationGeneration of ['true', 1, {}, null]) {
    await run({ existing: { 0: 'FAILED', 1: 'FAILED' }, verify: async (execute, io) => {
      await assert.rejects(execute(), /explicit boolean/);
      // The allowance is rejected before the first read, so nothing can be started under it.
      assert.equal(io.calls.length, 0);
    } }, {}, undefined, { migrationGeneration });
  }
  await run({ existing: { 0: 'FAILED', 1: 'FAILED' }, verify: async (execute, io) => {
    await assert.rejects(execute(), /identities retained/);
    assert.equal(io.calls.filter(call => call.start).length, 0);
    assert.equal(io.calls.some(call => typeof call.describe === 'string' && call.describe.endsWith('-migration1')), false);
  } }, {}, undefined, { migrationGeneration: false });
});

test('the migration dispatch starts -migration1 exactly once after both ordinary generations are exhausted', async () => {
  await run({ existing: { 0: 'FAILED', 1: 'FAILED' }, verify: async (execute, io, path) => {
    const result = await execute();
    assert.equal(result.operation.proof_status, 'verified');
    assert.equal(result.operation.execution_name, migrationName);
    assert.equal(result.operation.execution_arn, migrationArn);
    // The captured scope is preserved: the started input is the same envelope bytes, so the
    // operation identity, run scope and request hash are not re-scoped by the extra generation.
    const starts = io.calls.filter(call => call.start);
    assert.equal(starts.length, 1);
    assert.equal(starts[0].start, migrationName);
    assert.deepEqual(JSON.parse(JSON.stringify(starts[0].input)), envelope);
    assert.equal(starts[0].input.run_scope, scope);
    // Retry 1 is the predecessor this generation's single bounded check proved stopped, and
    // the migration name was not resolved before both ordinary generations were seen terminal
    // non-success.
    assert.deepEqual(result.operation.preceding_execution, { execution_arn: arn1, status: 'FAILED',
      stopped_at: '2026-10-10T00:00:01.000Z', cleanup_families: ['beta-anywear-cleanup', 'beta-anywear-cleanup-verify', 'beta-anywear-cleanup-acceptance'] });
    assert.deepEqual(io.calls.filter(call => call.describe).map(call => call.describe), [arn0, arn1, migrationArn, migrationArn]);
    // One inventory pass gated the ordinary retry and one gated the migration generation.
    assert.equal(io.calls.filter(call => call.aws?.[1] === 'list-tasks').length, 6);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), result);
  } }, {}, undefined, migrationOptions);
});

test('a repeated migration dispatch verifies the existing migration execution without a duplicate start', async () => {
  await run({ existing: { 0: 'FAILED', 1: 'FAILED' }, verify: async (execute, io) => {
    assert.equal((await execute()).operation.proof_status, 'verified');
    assert.equal(io.calls.filter(call => call.start).length, 1);
    const second = await execute();
    assert.equal(second.operation.proof_status, 'verified');
    assert.equal(second.operation.execution_name, migrationName);
    assert.equal(io.calls.filter(call => call.start).length, 1);
    // Exactly three inventory passes: the ordinary retry gate in each dispatch plus the one
    // migration gate. The migration generation started at most once.
    assert.equal(io.calls.filter(call => call.aws?.[1] === 'list-tasks').length, 9);
  } }, {}, undefined, migrationOptions);
});

test('an existing migration execution is resumed when RUNNING and verified when SUCCEEDED', async () => {
  await run({ existing: { 0: 'FAILED', 1: 'FAILED', migration1: 'RUNNING' }, completeRunning: true, verify: async (execute, io) => {
    const result = await execute();
    assert.equal(result.operation.proof_status, 'verified');
    assert.equal(result.operation.execution_name, migrationName);
    assert.equal(io.calls.filter(call => call.start).length, 0);
    assert.deepEqual(io.calls.filter(call => call.describe).map(call => call.describe), [arn0, arn1, migrationArn, migrationArn]);
  } }, {}, undefined, migrationOptions);
  await run({ existing: { 0: 'FAILED', 1: 'FAILED', migration1: 'SUCCEEDED' }, verify: async (execute, io) => {
    const result = await execute();
    assert.equal(result.operation.proof_status, 'verified');
    assert.equal(result.operation.execution_name, migrationName);
    assert.equal(result.operation.execution_arn, migrationArn);
    assert.equal(io.calls.filter(call => call.start).length, 0);
    assert.equal(io.calls.filter(call => call.describe).length, 3);
  } }, {}, undefined, migrationOptions);
});

test('the migration dispatch refuses a running predecessor, a missing retry and an exhausted migration run', async () => {
  let inventoryPasses = 0;
  const cases = [
    // The ordinary retry's check passes but the cleanup families are still working when the
    // migration generation would start: its own single bounded check refuses.
    [{ existing: { 0: 'FAILED', 1: 'FAILED' }, inventory: () => {
      inventoryPasses += 1;
      return inventoryPasses <= 3 ? { taskArns: [] } : { taskArns: [task('cleanup')] };
    } }, 'retry_proof', 'retry_proof_unavailable', migrationName],
    // The captured scope is not exhausted. The extra generation is not a second retry, so
    // the dispatch refuses instead of starting generation 1.
    [{ existing: { 0: 'FAILED' } }, 'retry_eligibility', 'retry_not_authorized', name1],
    // The migration generation is itself terminal non-success: no fourth execution.
    [{ existing: { 0: 'FAILED', 1: 'FAILED', migration1: 'FAILED' } }, 'retry_eligibility', 'retry_not_authorized', migrationName],
  ];
  for (const [options, phase, category, executionName] of cases) {
    await run({ ...options, verify: async (execute, io, path) => {
      await assert.rejects(execute(), /identities retained/);
      assert.equal(io.calls.filter(call => call.start).length, 0);
      const operation = JSON.parse(await readFile(path, 'utf8')).operation;
      assert.equal(operation.execution_name, executionName);
      assert.equal(operation.refusal_phase, phase);
      assert.equal(operation.refusal_category, category);
    } }, {}, undefined, migrationOptions);
  }
});

test('a dispatch refuses to start the retry when the predecessor cannot be shown stopped', async () => {
  const cases = [
    // A RUNNING-desired task returned by any cleanup family.
    args => ({ taskArns: args.includes('beta-anywear-cleanup-verify') ? [task('cleanup')] : [] }),
    // Incomplete or repeated inventory pagination cannot show cessation.
    () => ({ taskArns: [], nextToken: 'loop' }),
    // A returned task outside the fixed cleanup families is not a bound inventory.
    () => ({ taskArns: ['arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/foreign'] }),
  ];
  for (const inventory of cases) {
    await run({ existing: { 0: 'FAILED' }, inventory, verify: async (execute, io, path) => {
      await assert.rejects(execute(), /identities retained/);
      assert.equal(io.calls.filter(call => call.start).length, 0);
      const operation = JSON.parse(await readFile(path, 'utf8')).operation;
      assert.equal(operation.execution_name, name0);
      assert.equal(operation.refusal_phase, 'retry_proof');
      assert.equal(operation.refusal_category, 'retry_proof_unavailable');
      assert.equal(operation.preceding_execution, undefined);
    } });
  }
});

for (const startError of ['ExecutionAlreadyExists', 'TimeoutError', 'NetworkingError']) {
  test(`${startError} without an execution ARN resumes only the exact deterministic existing execution`, async () => {
    await run({ startError, verify: async (execute, io) => {
      assert.equal((await execute()).operation.proof_status, 'verified');
      assert.equal(io.calls.find(call => call.describe).describe, arn0);
      assert.equal(io.calls.filter(call => call.start).length, 1);
    } });
  });
}

test('unrelated start failures never permit identity cleanup', async () => {
  await run({ startError: 'AccessDeniedException', verify: async (execute, io, path) => {
    await assert.rejects(execute(), /identities retained/);
    assert.equal(io.calls.some(call => call.aws), false);
    assert.equal(io.calls.filter(call => call.start).length, 1);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).operation.proof_status, 'refused');
  } });
});

test('mismatched execution input, version, name, output and truncation all retain identities', async () => {
  for (const patch of [{ input: '{}' }, { stateMachineVersionArn: environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN.replace(':7', ':8') },
    { executionArn: `${arn0}x` }, { name: `${name0}x` }, { inputDetails: { included: false } }, { outputDetails: { included: false } },
    { output: JSON.stringify({ ...output(), request_sha256: 'f'.repeat(64) }) }]) {
    await run({ description: () => patch, verify: async (execute, io) => {
      await assert.rejects(execute(), /identities retained/);
      assert.equal(io.calls.some(call => call.aws), false);
    } });
  }
});

test('actual nonterminal, failed, foreign image, task definition and command observations refuse proof', async () => {
  for (const transform of [value => ({ ...value, lastStatus: 'RUNNING' }), value => ({ ...value, containers: [{ ...value.containers[0], exitCode: 1 }] }),
    value => ({ ...value, containers: [{ ...value.containers[0], imageDigest: `sha256:${'f'.repeat(64)}` }] }),
    value => ({ ...value, taskDefinitionArn: definition('cleanup').replace(':7', ':8') }),
    value => ({ ...value, overrides: { containerOverrides: [{ name: 'OneShot', command: ['sh', '-c', 'anything'] }] } })]) {
    await run({ existing: { 0: 'SUCCEEDED' }, task: (value, kind) => kind === 'cleanup' ? transform(value) : value,
      verify: async execute => { await assert.rejects(execute(), /identities retained/); } });
  }
  await run({ existing: { 0: 'SUCCEEDED' }, definition: value => ({ ...value, containerDefinitions: [{ ...value.containerDefinitions[0], environment: [] }] }),
    verify: async execute => { await assert.rejects(execute(), /identities retained/); } });
  await run({ existing: { 0: 'SUCCEEDED' }, task: (value, kind) => kind === 'cleanup' ? { ...value, taskArn: task('verification') } : value,
    verify: async execute => { await assert.rejects(execute(), /identities retained/); } });
});

test('duplicate, truncated, foreign, and unassigned diagnostic message markers fail closed', async () => {
  const record = `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed())}`;
  for (const events of [[{ message: record }, { message: record }], [{ message: 'ANYWEAR_BETA_CLEANUP_RESULT={' }],
    [{ message: `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed({ transaction_committed: false }))}` }],
    [{ message: `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed({ envelope_sha256: 'f'.repeat(64) }))}` }],
    [{ message: `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed({ dlq: { deleted: -1, preserved: 0 } }))}` }],
    [{ message: `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed({ dlq: { deleted: 1, preserved: 0, known_message: { message_id: 'foreign' } } }))}` }]]) {
    await run({ existing: { 0: 'SUCCEEDED' }, logs: token => ({ events: token ? [] : events, nextForwardToken: 'end' }),
      verify: async execute => { await assert.rejects(execute(), /identities retained/); } });
  }
});

test('a trusted Service may report owned terminal-task DLQ deletions without diagnostic message authority', async () => {
  await run({ existing: { 0: 'SUCCEEDED' }, logs: token => ({ events: token ? [] : [{ message: `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed({ dlq: { deleted: 2, preserved: 3 } }))}` }], nextForwardToken: 'end' }),
    verify: async execute => { assert.equal((await execute()).operation.committed_result.dlq.deleted, 2); } });
});

test('bounded log visibility waits and pagination limits preserve incomplete proof', async () => {
  await run({ existing: { 0: 'SUCCEEDED' }, logs: () => ({ events: [], nextForwardToken: 'end' }), verify: async (execute, io) => {
    await assert.rejects(execute(), /identities retained/);
    assert.equal(io.calls.filter(call => call.sleep).length, 14);
  } });
  await run({ existing: { 0: 'SUCCEEDED' }, logs: (_token, count) => ({ events: [], nextForwardToken: String(count) }), verify: async (execute, io) => {
    await assert.rejects(execute(), /identities retained/);
    assert.equal(io.calls.filter(call => call.aws?.[0] === 'logs').length, 20);
  } });
});

test('refusal diagnostics use only finite phase/category values', async () => {
  const refused = async (options, environmentPatch = {}) => run({ ...options, verify: async (execute, _io, path) => {
    await assert.rejects(execute(), /identities retained/);
    return JSON.parse(await readFile(path, 'utf8')).operation;
  } }, environmentPatch);
  const cases = [
    [{ startError: 'AccessDeniedException' }, 'operation_start', 'operation_start_unavailable'],
    [{ description: () => ({ input: '{}' }) }, 'execution_observation', 'execution_observation_unavailable'],
    [{ existing: { 0: 'FAILED' }, inventory: () => ({ taskArns: [task('cleanup')] }) }, 'retry_proof', 'retry_proof_unavailable'],
    [{ existing: { 0: 'FAILED', 1: 'FAILED' } }, 'retry_eligibility', 'retry_not_authorized'],
    [{ existing: { 0: 'RUNNING' } }, 'execution_observation', 'execution_not_succeeded'],
    [{ existing: { 0: 'SUCCEEDED' }, description: () => ({ output: '{}' }) }, 'result_proof', 'result_proof_unavailable'],
    [{ existing: { 0: 'SUCCEEDED' }, task: value => ({ ...value, lastStatus: 'RUNNING' }) }, 'task_proof', 'task_proof_unavailable'],
    [{ existing: { 0: 'SUCCEEDED' }, logs: token => ({ events: token ? [] : [], nextForwardToken: 'end' }) }, 'completion_proof', 'completion_proof_unavailable'],
  ];
  for (const [options, phase, category] of cases) {
    const operation = await refused(options);
    assert.equal(operation.proof_status, 'refused');
    assert.equal(operation.refusal_phase, phase);
    assert.equal(operation.refusal_category, category);
    assert.equal(operation.failure, 'Exact execution/task/committed-result proof unavailable; Cognito identities retained');
  }
});

test('verification name-only override is allowed while environment overrides remain refused', async () => {
  await run({ existing: { 0: 'SUCCEEDED' }, task: (value, kind) => kind === 'verification' ? { ...value, overrides: { containerOverrides: [{ name: 'OneShot' }] } } : value,
    verify: async execute => { assert.equal((await execute()).operation.proof_status, 'verified'); } });
  await run({ existing: { 0: 'SUCCEEDED' }, task: (value, kind) => kind === 'verification' ? { ...value, overrides: { containerOverrides: [{ name: 'OneShot', environment: [] }] } } : value,
    verify: async execute => { await assert.rejects(execute(), /identities retained/); } });
});

test('a pending execution remains bounded and retains its recoverable execution identity on timeout', async () => {
  await run({ existing: { 0: 'RUNNING' }, verify: async (execute, io, path) => {
    await assert.rejects(execute(), /identities retained/);
    assert.equal(io.calls.filter(call => call.describe).length, 900);
    const record = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(record.operation.status, 'RUNNING');
    assert.equal(record.operation.execution_arn, arn0);
  } });
});

test('an absolute deadline stops the wait with its own error, which the caller can distinguish from a refusal', async () => {
  let written;
  await run({ existing: { 0: 'RUNNING' }, verify: async (execute, io, path) => {
    await assert.rejects(execute(), error => error instanceof Error && error.name === 'CleanupDeadlineExceeded');
    // The deadline stop is not the unbounded 900-observation wait, and the refusal evidence is
    // still written so the caller keeps a diagnostic of what it did.
    assert.equal(io.calls.filter(call => call.describe).length, 1);
    written = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(written.operation.proof_status, 'refused');
    assert.equal(written.operation.execution_arn, arn0);
  } }, undefined, undefined, { deadline: Date.now() - 1 });
  assert.ok(written, 'the refusal evidence is written before the deadline error propagates');
});

test('the removed original-evidence compatibility read is no longer consulted', async () => {
  // The environment variable survived the `recover` removal as a dead read. A supplied path must
  // now be ignored: the operation reads only the current captured request.
  await run({ existing: { 0: 'SUCCEEDED' }, verify: async (execute) => {
    assert.equal((await execute()).operation.proof_status, 'verified');
  } }, { E2E_CLEANUP_ORIGINAL_EVIDENCE_PATH: join(tmpdir(), 'removed-owner-evidence.json') });
});

test('the dispatch surface no longer declares the manual recovery entry', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(packageJson.scripts['test:core'].includes('scripts/service-cleanup-operation.test.mjs'));
  const workflow = await readFile(new URL('../.github/workflows/beta-qualification.yml', import.meta.url), 'utf8');
  // #217: the manual `recover` operation, its captured-identity inputs and its original-
  // evidence replay are removed; only `full`, `smoke` and `reconcile` remain.
  assert.doesNotMatch(workflow, /^ {2}recover:$/m, 'the qualify entry must not declare a recover job');
  for (const removed of ['source_run_id', 'source_run_attempt', 'operation_mode', 'recovery_attempt',
    'previous_recovery_run_id', 'previous_recovery_run_attempt', 'retry_failed_execution']) {
    assert.doesNotMatch(workflow, new RegExp(`^ {6}${removed}:$`, 'm'), `${removed} must not remain a dispatch input`);
  }
  assert.doesNotMatch(workflow, /E2E_CLEANUP_(?:OPERATION_MODE|RECOVERY_ATTEMPT|RETRY_FAILED|PREVIOUS_RECOVERY_EVIDENCE_PATH)/);
  assert.doesNotMatch(workflow, /RECOVERY_PREVIOUS_RUN_|E2E_CLEANUP_ORIGINAL_EVIDENCE_PATH/);
  assert.match(workflow, /worker_slot_offset:/);
  assert.match(workflow, /E2E_WORKER_SLOT_OFFSET:.*inputs.worker_slot_offset/);
});

test('the replay chain leaves no tracked production reference or callerless entry behind', () => {
  const production = ['tests/support/service-cleanup-operation.ts', 'scripts/cleanup-worker-accounts.mjs',
    '.github/workflows/beta-qualification.yml'];
  for (const file of production) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const removed of ['beta-cleanup-recovery-', 'assertPreviousRecovery', 'assertRecoveryOperationEvidence',
      'runRecoveryCleanupOperation', 'prepareCleanupRetryIntent', 'submitCleanupRetryIntent',
      'observeFailedCleanupOperation', 'observeSubmittedCleanupOperation', 'recoveryPreflight', 'cessationSnapshot',
      'previous-recovery-operation', 'previous-recovery-owner', 'recovery-selection.json',
      'E2E_CLEANUP_ORIGINAL_EVIDENCE_PATH', 'OriginalEvidence', 'originalOperation', 'assertCleanupOwnerEvidence']) {
      assert.equal(source.includes(removed), false, `${file} still references ${removed}`);
    }
  }
  assert.equal(existsSync(new URL('../scripts/delete-recovered-identities.mjs', import.meta.url)), false,
    'the callerless delete-recovered-identities entry point is removed');
  assert.equal(existsSync(new URL('../scripts/account-recovery-inputs.mjs', import.meta.url)), false,
    'the manual recovery input validator is removed');
});
