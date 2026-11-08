import { DescribeExecutionCommand, SFNClient, StartExecutionCommand, type DescribeExecutionOutput } from '@aws-sdk/client-sfn';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { parseStrictJson } from '../../scripts/evidence-contract.mjs';
import { isBetaWorkerEmailForScope } from './beta-address.ts';
import type { ServiceCleanupInputs } from './worker-cleanup.js';

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RUN_SCOPE = /^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-[a-f0-9]{16}$/;
const VERSION_ARN = /^arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup:([1-9][0-9]*)$/;
const TASK_ARN = /^arn:aws:ecs:ap-east-1:650880818323:task\/beta-anywear\/([a-f0-9]{32})$/;
const DEFINITION_ARN = /^arn:aws:ecs:ap-east-1:650880818323:task-definition\/(beta-anywear-cleanup(?:-verify)?):[1-9][0-9]*$/;
const CLUSTER = 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear';
const LOG_GROUP = '/anywear/beta/one-shot';
const MARKER = 'ANYWEAR_BETA_CLEANUP_RESULT=';
const TERMINAL_FAILURE = ['FAILED', 'TIMED_OUT', 'ABORTED'];
const CLEANUP_FAMILIES = ['beta-anywear-cleanup', 'beta-anywear-cleanup-verify', 'beta-anywear-cleanup-acceptance'] as const;
/** The ordinary generation bound: the base name plus exactly one retry. */
const MAX_GENERATIONS = 1;
/**
 * The execution-name limit of a Step Functions execution (#217).
 */
const MAX_EXECUTION_NAME = 80;
/**
 * The one extra generation the 90-day migration reconcile may start (#217). It is a distinct
 * name, never a second retry, and it exists because the ordinary pair of a historical captured
 * scope may already be spent: the request is unchanged, so the scope keeps its cleanup
 * operation identity and evidence while one more exact cleanup can run.
 */
const MIGRATION_GENERATION = 'migration1';
const MIGRATION_SUFFIX = '-migration1';
const execute = promisify(execFile);

type CleanupRefusalPhase = 'operation_start' | 'execution_observation' | 'retry_eligibility' | 'retry_proof'
  | 'result_proof' | 'task_proof' | 'completion_proof';
type CleanupRefusalCategory = 'operation_start_unavailable' | 'execution_observation_unavailable' | 'retry_not_authorized'
  | 'retry_proof_unavailable' | 'execution_not_succeeded' | 'result_proof_unavailable' | 'task_proof_unavailable'
  | 'completion_proof_unavailable';

export interface CleanupOperationEnvelope {
  schema_version: 1;
  operation_mode: 'normal';
  recovery_attempt?: number;
  operation_id: string;
  run_scope: string;
  request_sha256: string;
  service_commit_sha: string;
  service_image_digest: string;
  cleanup_request: string;
}

export interface CleanupOperationResult {
  schema_version: 1;
  record_type: 'anywear_beta_cleanup_tasks';
  operation_id: string;
  request_sha256: string;
  run_scope: string;
  service_commit_sha: string;
  service_image_digest: string;
  cluster_arn: string;
  log_group_name: string;
  verification_task_arn: string;
  verification_task_definition_arn: string;
  verification_task_status: 'STOPPED';
  verification_exit_code: 0;
  verification_log_stream_prefix: string;
  cleanup_task_arn: string;
  cleanup_task_definition_arn: string;
  cleanup_task_status: 'STOPPED';
  cleanup_exit_code: 0;
  cleanup_log_stream_prefix: string;
}

/** Where the proof of a verified cleanup came from (#224). */
export type CleanupProofOrigin = 'live' | 'marker' | 'artifact';

/**
 * The provenance of an artifact-tier proof: which uploaded record was read, and the digest of the
 * bytes that named it. Diagnostics only; the decision never uses it.
 */
export interface CleanupArtifactSource {
  artifact_id: number;
  artifact_name: string;
  artifact_digest: string;
  file: string;
  record_sha256: string;
}

/** One verified operation record, supplied by the caller as a durable proof of an execution. */
export interface ArtifactWitness {
  record: unknown;
  source: CleanupArtifactSource;
}

export interface CleanupOperationEvidence {
  schema_version: 4;
  record_type: 'anywear_e2e_service_cleanup_operation';
  operation: {
    operation_mode: 'normal';
    recovery_attempt?: number;
    state_machine_version_arn: string;
    execution_arn: string;
    execution_name: string;
    started_at?: string;
    stopped_at?: string;
    status: string;
    proof_status: 'pending' | 'verified' | 'refused';
    /** Present only on a verified record; names the tier that produced the proof. */
    proof_origin?: CleanupProofOrigin;
    /** Present only on an artifact-tier record; names the record it was read from. */
    artifact_source?: CleanupArtifactSource;
    input_sha256: string;
    input: CleanupOperationEnvelope;
    output?: CleanupOperationResult;
    tasks?: Record<string, unknown>[];
    committed_result?: Record<string, unknown>;
    preceding_execution?: { execution_arn: string; status: string; stopped_at?: string; cleanup_families: string[] };
    failure?: string;
    refusal_phase?: CleanupRefusalPhase;
    refusal_category?: CleanupRefusalCategory;
  };
}

export interface CleanupOperationIo {
  start(input: CleanupOperationEnvelope, executionName: string): Promise<{ executionArn?: string }>;
  describe(executionArn: string): Promise<DescribeExecutionOutput>;
  aws(args: string[]): Promise<unknown>;
  sleep(milliseconds: number): Promise<void>;
}

export interface CleanupOperationOptions {
  /**
   * The absolute instant the caller's job must be done by (#217). A wait that reaches it stops
   * with `CleanupDeadlineExceededError`, so the caller can still record what it did instead of
   * losing the record when the job is cancelled.
   */
  deadline?: number;
  /**
   * The explicit migration allowance (#217). Only the 90-day migration reconcile sets it, and
   * it permits the one `-migration1` generation once the captured scope's ordinary pair is
   * already exhausted. Every other caller — the ordinary reconcile, `full`, `smoke` and the
   * teardown — leaves it unset and keeps the unchanged two-name rule: a generation 1 that is
   * already terminal non-success refuses, and no third name is derived.
   */
  migrationGeneration?: boolean;
  /**
   * The durable witness lookup (#224). Only the reconcile supplies it, and it is called only
   * when the cleanup marker is absent and ECS can show neither stopped task. Its answer is one
   * previously verified operation record for the exact execution, or `undefined`; every binding
   * is re-proved here before a record can stand in for the live task read.
   */
  recovery?: (executionName: string, stoppedAt: string) => Promise<ArtifactWitness | undefined> | ArtifactWitness | undefined;
}

interface CanonicalTask {
  taskArn: string;
  clusterArn: string;
  taskDefinitionArn: string;
  lastStatus: string;
  desiredStatus: string;
  startedBy: string;
  containers: Record<string, unknown>[];
  overrides: Record<string, unknown>;
}

interface TaskProofOptions {
  expectedDefinition?: string;
  requireSuccess: boolean;
  snapshotText?: string;
}

function hash(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function exactObject(value: unknown, label: string, allowed: string[]): Record<string, unknown> {
  const result = object(value, label);
  if (Object.keys(result).some(key => !allowed.includes(key))) throw new Error(`${label} contains an unknown field`);
  return result;
}

function optionalArray(value: unknown, label: string): unknown[] {
  if (value === undefined) return [];
  return array(value, label);
}

function mapLiveTask(value: unknown): CanonicalTask {
  const task = object(value, 'Live ECS task');
  for (const key of ['taskArn', 'clusterArn', 'taskDefinitionArn', 'lastStatus', 'desiredStatus', 'startedBy']) {
    if (typeof task[key] !== 'string' || task[key] === '') throw new Error(`Live ECS task field ${key} is malformed`);
  }
  const containers = array(task.containers, 'Live ECS containers').map(entry => object(entry, 'Live ECS container'));
  return { taskArn: task.taskArn as string, clusterArn: task.clusterArn as string, taskDefinitionArn: task.taskDefinitionArn as string,
    lastStatus: task.lastStatus as string, desiredStatus: task.desiredStatus as string, startedBy: task.startedBy as string, containers,
    overrides: object(task.overrides === undefined ? {} : task.overrides, 'Live ECS overrides') };
}

function validateCanonicalTask(task: CanonicalTask, envelope: CleanupOperationEnvelope, io: CleanupOperationIo,
  options: TaskProofOptions): Promise<Record<string, unknown>> {
  return (async () => {
    if (!TASK_ARN.test(task.taskArn) || task.clusterArn !== CLUSTER || task.lastStatus !== 'STOPPED' || task.desiredStatus !== 'STOPPED'
      || task.startedBy !== 'AWS Step Functions' || !DEFINITION_ARN.test(task.taskDefinitionArn)
      || (options.expectedDefinition && task.taskDefinitionArn !== options.expectedDefinition)) throw new Error('Cleanup task has not stopped under the exact definition');
    if (task.containers.length !== 1) throw new Error('Cleanup task must have exactly one container');
    const container = task.containers[0];
    if (container.name !== 'OneShot' || container.lastStatus !== 'STOPPED' || !Number.isInteger(container.exitCode)
      || (options.requireSuccess && container.exitCode !== 0) || container.imageDigest !== envelope.service_image_digest) {
      throw new Error('OneShot task image/status/exit proof failed');
    }
    const definitionResponse = object(await io.aws(['ecs', 'describe-task-definition', '--task-definition', task.taskDefinitionArn]), 'Task definition response');
    const definition = object(definitionResponse.taskDefinition, 'Task definition');
    const definitions = array(definition.containerDefinitions, 'Definition containers');
    if (definitions.length !== 1 || definition.taskDefinitionArn !== task.taskDefinitionArn || definition.cpu !== '512' || definition.memory !== '1024'
      || definition.networkMode !== 'awsvpc' || !isDeepStrictEqual(definition.requiresCompatibilities, ['FARGATE'])) throw new Error('Immutable cleanup definition changed');
    const fixed = object(definitions[0], 'Fixed OneShot definition');
    if (fixed.name !== 'OneShot' || typeof fixed.image !== 'string' || !fixed.image.startsWith('650880818323.dkr.ecr.ap-east-1.amazonaws.com/')
      || fixed.image.split('@')[1] !== envelope.service_image_digest) throw new Error('Task definition image binding failed');
    if (fixed.entryPoint !== undefined && (!Array.isArray(fixed.entryPoint) || fixed.entryPoint.length !== 0)) throw new Error('Task definition entrypoint was overridden');
    for (const field of ['environmentFiles', 'resourceRequirements']) {
      if (fixed[field] !== undefined && (!Array.isArray(fixed[field]) || (fixed[field] as unknown[]).length !== 0)) throw new Error('Task definition inert defaults changed');
    }
    const variables = array(fixed.environment, 'Definition environment').map(value => object(value, 'Environment value'));
    const variable = (name: string) => {
      const matches = variables.filter(entry => entry.name === name);
      if (matches.length !== 1 || typeof matches[0].value !== 'string' || !matches[0].value) throw new Error('Task source environment is absent or duplicated');
      return matches[0].value;
    };
    const command = array(fixed.command, 'Fixed command');
    const verification = isDeepStrictEqual(command, ['node', 'dist/verify.js']);
    if (!verification && !isDeepStrictEqual(command, ['node', 'dist/ops/beta-cleanup-operation.js'])) throw new Error('Task definition command is not the fixed cleanup capability');
    const prefix = verification ? 'beta-anywear-cleanup-verify' : 'beta-anywear-cleanup';
    const logs = object(fixed.logConfiguration, 'Task logs');
    const logOptions = object(logs.options, 'Task log options');
    if (DEFINITION_ARN.exec(task.taskDefinitionArn)?.[1] !== prefix
      || variable('SERVICE_COMMIT_SHA') !== envelope.service_commit_sha || variable('IMAGE_DIGEST') !== envelope.service_image_digest
      || logs.logDriver !== 'awslogs' || logOptions['awslogs-group'] !== LOG_GROUP || logOptions['awslogs-region'] !== 'ap-east-1'
      || logOptions['awslogs-stream-prefix'] !== prefix) throw new Error('Task definition source/fixed log binding failed');
    const overrides = exactObject(task.overrides, 'Task overrides', ['containerOverrides', 'inferenceAcceleratorOverrides', 'taskRoleArn', 'executionRoleArn', 'cpu', 'memory']);
    const accelerator = optionalArray(overrides.inferenceAcceleratorOverrides, 'Inference accelerator overrides');
    if (accelerator.length !== 0 || overrides.taskRoleArn !== undefined || overrides.executionRoleArn !== undefined
      || overrides.cpu !== undefined || overrides.memory !== undefined) throw new Error('Cleanup executable role/cpu/memory was overridden');
    const containerOverrides = optionalArray(overrides.containerOverrides, 'Container overrides');
    if (containerOverrides.length > 1) throw new Error('Cleanup has multiple container overrides');
    let envelopeHash: string | undefined;
    if (verification) {
      if (containerOverrides.length === 1) {
        const override = exactObject(containerOverrides[0], 'Verifier container override', ['name', 'command', 'environment', 'environmentFiles', 'resourceRequirements']);
        if (override.name !== 'OneShot' || override.environment !== undefined || override.environmentFiles !== undefined
          || override.resourceRequirements !== undefined || override.command !== undefined) throw new Error('Verifier executable override changed');
      }
    } else {
      if (containerOverrides.length !== 1) throw new Error('Cleanup command override is missing');
      const override = exactObject(containerOverrides[0], 'Cleanup container override', ['name', 'command', 'environment', 'environmentFiles', 'resourceRequirements']);
      const actual = array(override.command, 'Cleanup command');
      if (override.name !== 'OneShot' || actual.length !== 3 || actual[0] !== 'node' || actual[1] !== 'dist/ops/beta-cleanup-operation.js'
        || actual[2] !== JSON.stringify(envelope) || !isDeepStrictEqual(parseStrictJson(actual[2]), envelope)
        || optionalArray(override.environment, 'Cleanup environment').length !== 0
        || optionalArray(override.environmentFiles, 'Cleanup environment files').length !== 0
        || optionalArray(override.resourceRequirements, 'Cleanup resource requirements').length !== 0) throw new Error('Cleanup task override does not bind the original envelope');
      envelopeHash = hash(actual[2]);
    }
    return { task_arn: task.taskArn, task_definition_arn: task.taskDefinitionArn, kind: verification ? 'verification' : 'cleanup',
      status: 'STOPPED', exit_code: container.exitCode, image_digest: container.imageDigest, service_commit_sha: variable('SERVICE_COMMIT_SHA'),
      log_group: LOG_GROUP, log_stream: `${prefix}/OneShot/${TASK_ARN.exec(task.taskArn)![1]}`,
      proof_origin: 'live', snapshot_sha256: hash(options.snapshotText ?? JSON.stringify(task)),
      ...(envelopeHash ? { envelope_sha256: envelopeHash } : {}) };
  })();
}

export function createCleanupOperationEnvelope(inputs: ServiceCleanupInputs, environment: NodeJS.ProcessEnv = process.env): CleanupOperationEnvelope {
  if (inputs.action !== 'cleanup' || inputs.emails !== '[]') throw new Error('Unsupported Service cleanup action');
  if (Buffer.byteLength(inputs.cleanup_json, 'utf8') > 16_384) throw new Error('Cleanup request exceeds the Service limit');
  const request = object(parseStrictJson(inputs.cleanup_json), 'Cleanup request');
  if (JSON.stringify(request) !== inputs.cleanup_json) throw new Error('Cleanup request must preserve canonical producer JSON bytes');
  const users = array(request.users, 'Captured workers');
  if (Object.keys(request).sort().join(',') !== 'runScope,users'
    || typeof request.runScope !== 'string' || !RUN_SCOPE.test(request.runScope) || users.length < 1 || users.length > 8) {
    throw new Error('Cleanup request run scope or worker bound is invalid');
  }
  // Captured once, because the identity check below runs inside a callback and
  // the address must be bound to this request's own scope.
  const runScope = request.runScope;
  const identities = users.map(value => {
    const user = object(value, 'Captured worker');
    // This run's scoped Beta worker address, or a stable allowlist row a
    // pre-#129 manifest still captures. The Service's parser accepts the same
    // two families, so the reviewed request and the capability agree.
    if (Object.keys(user).sort().join(',') !== 'email,sub'
      || typeof user.email !== 'string' || !isBetaWorkerEmailForScope(user.email, runScope)
      || typeof user.sub !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(user.sub)) {
      throw new Error('Cleanup request requires exact captured worker subjects');
    }
    return user;
  });
  if (new Set(identities.map(user => user.email)).size !== users.length || new Set(identities.map(user => user.sub)).size !== users.length) {
    throw new Error('Cleanup request contains duplicate identities');
  }
  const source = environment.E2E_CLEANUP_SERVICE_SOURCE_SHA ?? environment.E2E_CLEANUP_SERVICE_SHA;
  const digest = environment.E2E_CLEANUP_SERVICE_IMAGE_DIGEST;
  if (!source || !SHA.test(source)) throw new Error('Reviewed cleanup source must be a full commit SHA');
  if (!digest || !DIGEST.test(digest)) throw new Error('Reviewed cleanup image must be an OCI digest');
  // The Service envelope keeps `operation_mode` (and its optional
  // `recovery_attempt`) because the Service validator requires the field. E2E
  // always submits the ordinary mode, and never submits an attempt.
  const envelope: CleanupOperationEnvelope = { schema_version: 1, operation_mode: 'normal',
    operation_id: `beta-tester-cleanup:${request.runScope}`, run_scope: request.runScope,
    request_sha256: hash(inputs.cleanup_json), service_commit_sha: source, service_image_digest: digest, cleanup_request: inputs.cleanup_json };
  const overrides = { ContainerOverrides: [{ Name: 'OneShot', Command: ['node', 'dist/ops/beta-cleanup-operation.js', JSON.stringify(envelope)] }] };
  if (Buffer.byteLength(JSON.stringify(overrides), 'utf8') > 8192) throw new Error('Cleanup envelope exceeds the ECS container override limit');
  return envelope;
}

/** A generation of one captured scope: its base name, its one retry, or the migration name. */
export type CleanupExecutionGeneration = 0 | 1 | typeof MIGRATION_GENERATION;

/**
 * The deterministic names of one captured scope: the base name and exactly one retry, plus the
 * separate migration name that only the 90-day migration reconcile may start (#217). Nothing is
 * ever derived from the captured identities beyond the request hash, so a replay of the same
 * scope can only land on generation 0, generation 1, or — with the explicit migration allowance
 * — the one `-migration1` generation. The request itself is never re-scoped: all three names
 * bind the same envelope bytes and therefore the same `runScope`, request hash and evidence.
 */
export function deterministicCleanupExecutionName(envelope: CleanupOperationEnvelope,
  generation: CleanupExecutionGeneration = 0): string {
  const base = `beta-cleanup-${envelope.run_scope}-${envelope.request_sha256.slice(0, 16)}`;
  if (generation === MIGRATION_GENERATION) {
    // The migration name mirrors the retry's bounded base: the suffix is longer than
    // `-retry1`, so the base is truncated further to stay inside the execution-name limit.
    return boundedName(`${base.slice(0, MAX_EXECUTION_NAME - MIGRATION_SUFFIX.length)}${MIGRATION_SUFFIX}`);
  }
  if (!Number.isSafeInteger(generation) || generation < 0 || generation > MAX_GENERATIONS) throw new Error('Cleanup execution generation is invalid');
  // The retry keeps the established 72-character base bound, so a maximum-length
  // run scope can still start it and an in-flight legacy `-retry1` name is found.
  return boundedName(generation === 0 ? base : `${base.slice(0, 72)}-retry1`);
}

function boundedName(name: string): string {
  if (name.length > MAX_EXECUTION_NAME) throw new Error('Cleanup execution name exceeds the Step Functions limit');
  return name;
}

export function cleanupExecutionArn(versionArn: string, name: string): string {
  if (!VERSION_ARN.test(versionArn) || !/^[A-Za-z0-9_-]{1,80}$/.test(name)) throw new Error('Cleanup requires the fixed Beta state-machine version ARN and execution name');
  return `${versionArn.replace(/:stateMachine:/, ':execution:').replace(/:[1-9][0-9]*$/, '')}:${name}`;
}

function validateDescription(description: DescribeExecutionOutput, envelope: CleanupOperationEnvelope, versionArn: string, name: string): void {
  if (description.executionArn !== cleanupExecutionArn(versionArn, name) || description.name !== name
    || description.stateMachineArn !== versionArn.replace(/:[1-9][0-9]*$/, '') || description.stateMachineVersionArn !== versionArn
    || description.input !== JSON.stringify(envelope) || description.inputDetails?.included !== true
    || !description.status || !['RUNNING', 'SUCCEEDED', ...TERMINAL_FAILURE].includes(description.status)) {
    throw new Error('Observed cleanup execution does not bind the exact input, name and immutable version');
  }
}

function validateResult(value: unknown, envelope: CleanupOperationEnvelope): CleanupOperationResult {
  const output = object(value, 'Cleanup task output');
  if (output.schema_version !== 1 || output.record_type !== 'anywear_beta_cleanup_tasks'
    || output.operation_id !== envelope.operation_id || output.request_sha256 !== envelope.request_sha256 || output.run_scope !== envelope.run_scope
    || output.service_commit_sha !== envelope.service_commit_sha || output.service_image_digest !== envelope.service_image_digest
    || output.cluster_arn !== CLUSTER || output.log_group_name !== LOG_GROUP) throw new Error('Cleanup task output has a foreign operation/artifact binding');
  for (const purpose of ['verification', 'cleanup']) {
    if (typeof output[`${purpose}_task_arn`] !== 'string' || !TASK_ARN.test(output[`${purpose}_task_arn`] as string)
      || typeof output[`${purpose}_task_definition_arn`] !== 'string' || !DEFINITION_ARN.test(output[`${purpose}_task_definition_arn`] as string)
      || output[`${purpose}_task_status`] !== 'STOPPED' || output[`${purpose}_exit_code`] !== 0
      || output[`${purpose}_log_stream_prefix`] !== (purpose === 'verification' ? 'beta-anywear-cleanup-verify' : 'beta-anywear-cleanup')) {
      throw new Error('Cleanup output lacks exact stopped successful task identities');
    }
  }
  if (output.verification_task_arn === output.cleanup_task_arn) throw new Error('Verification and cleanup must be distinct tasks');
  return output as unknown as CleanupOperationResult;
}

async function observeTask(io: CleanupOperationIo, envelope: CleanupOperationEnvelope, taskArn: string,
  expectedDefinition?: string, requireSuccess = true): Promise<Record<string, unknown>> {
  if (!TASK_ARN.test(taskArn)) throw new Error('Cleanup task ARN is outside the fixed Beta cluster');
  const response = object(await io.aws(['ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', taskArn]), 'Observed cleanup tasks');
  const failures = array(response.failures, 'Task failures');
  const tasks = array(response.tasks, 'Tasks');
  const missingFailure = failures.length === 1 ? exactObject(failures[0], 'Task failure', ['arn', 'reason']) : undefined;
  const missing = tasks.length === 0 && failures.length === 1 && missingFailure?.arn === taskArn && missingFailure.reason === 'MISSING';
  if (missing) throw new CleanupTaskHistoryUnavailableError();
  if (failures.length !== 0 || tasks.length !== 1) throw new Error('Cleanup task cannot be observed');
  const liveTask = mapLiveTask(tasks[0]);
  if (liveTask.taskArn !== taskArn) throw new Error('Observed ECS task differs from the submitted task identity');
  return validateCanonicalTask(liveTask, envelope, io, { expectedDefinition, requireSuccess, snapshotText: JSON.stringify(tasks[0]) });
}

function validateCommitted(value: unknown, envelope: CleanupOperationEnvelope): Record<string, unknown> {
  const result = object(value, 'Service committed result');
  const counters = ['users', 'missingUsers', 'tasks', 'outbox', 'idempotency', 'generations', 'relations', 'outfits', 'items', 'photos'];
  // #217: the object phase is part of the committed result. `objects` is what the task
  // deleted under the captured users' prefixes and `objectsMissing` is what their own rows
  // expected but the listing did not contain. Both are required: a Service release without
  // them cannot prove the objects are gone.
  const objectCounters = ['objects', 'objectsMissing'];
  if (result.schema_version !== 1 || result.record_type !== 'anywear_beta_cleanup_result' || result.source !== 'beta-tester-cleanup'
    || result.cleanup !== 'beta-testers' || result.operation_id !== envelope.operation_id || result.request_sha256 !== envelope.request_sha256
    || result.run_scope !== envelope.run_scope || result.operation_mode !== envelope.operation_mode
    || result.recovery_attempt !== envelope.recovery_attempt || result.transaction_committed !== true
    || result.service_commit_sha !== envelope.service_commit_sha || result.service_image_digest !== envelope.service_image_digest
    || typeof result.envelope_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.envelope_sha256)
    || counters.some(key => !Number.isSafeInteger(result[key]) || (result[key] as number) < 0)
    || objectCounters.some(key => !Number.isSafeInteger(result[key]) || (result[key] as number) < 0)
    || (result.users as number) + (result.missingUsers as number) !== (object(parseStrictJson(envelope.cleanup_request), 'Cleanup request').users as unknown[]).length) {
    throw new Error('Service completion marker lacks exact committed request/source proof');
  }
  const dlq = object(result.dlq, 'Preserved DLQ proof');
  if (!Number.isSafeInteger(dlq.deleted) || (dlq.deleted as number) < 0
    || !Number.isSafeInteger(dlq.preserved) || (dlq.preserved as number) < 0 || dlq.known_message !== undefined) {
    throw new Error('Cleanup lacks bounded DLQ counters or includes an unassigned diagnostic message');
  }
  return result;
}

/**
 * Read one cleanup task's completion marker from its own log stream.
 *
 * The live tier passes the envelope hash the stopped cleanup task carried in its override and
 * keeps the original fifteen-attempt wait; a durable tier passes the hash recomputed from the
 * expected envelope and a single attempt, because absence must open the next tier rather than
 * wait. Only an absent marker becomes `CleanupProofAbsentError`; a duplicate, malformed or
 * unbound marker keeps its own error, which refuses at `completion_proof` and never falls
 * through to another tier.
 */
async function readCommitted(io: CleanupOperationIo, envelope: CleanupOperationEnvelope, logStream: string,
  envelopeSha256: string, attempts = 15): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const markers: string[] = [];
    let token: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      let response: Record<string, unknown>;
      try {
        response = object(await io.aws(['logs', 'get-log-events', '--log-group-name', LOG_GROUP, '--log-stream-name', logStream,
          '--start-from-head', '--limit', '1000', ...(token ? ['--next-token', token] : [])]), 'Cleanup logs');
      } catch (error) {
        if (error instanceof Error && error.name === 'ResourceNotFoundException') break;
        throw error;
      }
      for (const event of array(response.events, 'Log events')) {
        const message = object(event, 'Log event').message;
        if (typeof message !== 'string') throw new Error('Cleanup log message is malformed');
        for (const line of message.split(/\r?\n/)) if (line.startsWith(MARKER)) markers.push(line.slice(MARKER.length));
      }
      if (markers.length > 1) throw new Error('Cleanup logs contain duplicate completion markers');
      if (typeof response.nextForwardToken !== 'string') throw new Error('Cleanup log pagination is incomplete');
      if (response.nextForwardToken === token) {
        if (markers.length === 1) {
          const result = validateCommitted(parseStrictJson(markers[0]), envelope);
          if (result.envelope_sha256 !== envelopeSha256) throw new Error('Service completion does not bind the actual ECS envelope bytes');
          return result;
        }
        break;
      }
      if (page === 19) throw new Error('Cleanup log pagination exceeded its bounded proof window');
      token = response.nextForwardToken;
    }
    if (attempt < attempts - 1) await io.sleep(2_000);
  }
  throw new CleanupProofAbsentError();
}

/**
 * The uploaded operation records that may stand as a durable witness (#224): the lifecycle
 * artifact's own teardown diagnostic, or a reconcile artifact's per-scope record.
 */
const WITNESS_ARTIFACT_NAME = /^(?:beta-account-lifecycle|beta-smoke-account-lifecycle|beta-account-reconcile)-[1-9][0-9]*-[1-9][0-9]*$/;
const RECORD_SHA256 = /^[a-f0-9]{64}$/;
/** Every member a v3 operation could carry; `failure`/`refusal_*` are deliberately absent. */
const V3_OPERATION_MEMBERS = ['operation_mode', 'recovery_attempt', 'state_machine_version_arn', 'execution_arn',
  'execution_name', 'started_at', 'stopped_at', 'status', 'proof_status', 'input_sha256', 'input', 'output', 'tasks',
  'committed_result', 'preceding_execution'];
/** The v4 members, which additionally require `proof_origin` and allow `artifact_source`. */
const V4_OPERATION_MEMBERS = [...V3_OPERATION_MEMBERS, 'proof_origin', 'artifact_source'];
const WITNESS_TASK_MEMBERS = ['task_arn', 'task_definition_arn', 'kind', 'status', 'exit_code', 'image_digest',
  'service_commit_sha', 'log_group', 'log_stream', 'proof_origin', 'snapshot_sha256', 'envelope_sha256'];

/**
 * The one place a v3 record is accepted (#224).
 *
 * A v3 record can only have been written by the live tier, because the three-tier meaning of
 * `proof_status: 'verified'` arrived with v4. The reader maps its `verified` to
 * `proof_origin: 'live'` and leaves a v4 record untouched, so a v3 record can never be re-read
 * as an artifact proof. A record that is not a complete verification keeps throwing.
 */
function readLegacyV3Operation(record: unknown): CleanupOperationEvidence {
  const top = exactObject(record, 'Cleanup operation record', ['schema_version', 'record_type', 'operation']);
  if (top.record_type !== 'anywear_e2e_service_cleanup_operation') throw new Error('Cleanup operation record has a foreign type');
  if (top.schema_version === 4) return top as unknown as CleanupOperationEvidence;
  if (top.schema_version !== 3) throw new Error('Cleanup operation record schema is neither 3 nor 4');
  const operation = exactObject(top.operation, 'Cleanup operation', V3_OPERATION_MEMBERS);
  if (operation.proof_status !== 'verified' || operation.status !== 'SUCCEEDED') {
    throw new Error('Cleanup operation record is not a complete verification');
  }
  return { schema_version: 4, record_type: 'anywear_e2e_service_cleanup_operation',
    operation: { ...operation, proof_origin: 'live' } as unknown as CleanupOperationEvidence['operation'] };
}

interface WitnessExpectation {
  envelope: CleanupOperationEnvelope;
  versionArn: string;
  executionName: string;
  output: CleanupOperationResult;
  description: DescribeExecutionOutput;
}

/**
 * Re-prove one durable witness against the execution this dispatch just observed (#224).
 *
 * Every binding in `### How the proof stays bound` is checked here, and there is no partial
 * acceptance: the witness must be one complete live verification of this exact execution, its
 * envelope, its output and its instance. The written record then restates the source and stamps
 * each accepted task entry `proof_origin: 'artifact'`, so a copy is never laundered as a live
 * read.
 */
function validateArtifactWitness(witness: ArtifactWitness, expected: WitnessExpectation):
{ tasks: Record<string, unknown>[]; committed_result: Record<string, unknown> } {
  const value = object(witness, 'Artifact witness');
  const source = exactObject(value.source, 'Artifact witness source',
    ['artifact_id', 'artifact_name', 'artifact_digest', 'file', 'record_sha256']);
  if (!Number.isSafeInteger(source.artifact_id) || (source.artifact_id as number) < 1
    || typeof source.artifact_name !== 'string' || !WITNESS_ARTIFACT_NAME.test(source.artifact_name)
    || typeof source.artifact_digest !== 'string' || !DIGEST.test(source.artifact_digest)
    || typeof source.file !== 'string' || source.file.length === 0
    || typeof source.record_sha256 !== 'string' || !RECORD_SHA256.test(source.record_sha256)) {
    throw new Error('Artifact witness source is malformed');
  }
  const record = readLegacyV3Operation(value.record);
  const operation = exactObject(record.operation, 'Cleanup operation', V4_OPERATION_MEMBERS);
  if (operation.proof_status !== 'verified' || operation.status !== 'SUCCEEDED' || operation.proof_origin !== 'live'
    || operation.artifact_source !== undefined) throw new Error('Artifact witness is not a complete live verification');
  if (operation.execution_name !== expected.executionName
    || operation.execution_arn !== cleanupExecutionArn(expected.versionArn, expected.executionName)) {
    throw new Error('Artifact witness does not name this exact deterministic execution');
  }
  const envelopeSha256 = hash(JSON.stringify(expected.envelope));
  if (operation.input_sha256 !== envelopeSha256 || !isDeepStrictEqual(operation.input, expected.envelope)) {
    throw new Error('Artifact witness does not bind the expected envelope and Service source/image');
  }
  const output = validateResult(operation.output, expected.envelope);
  if (!isDeepStrictEqual(output, expected.output)) throw new Error('Artifact witness does not carry the observed execution output');
  const startedAt = expected.description.startDate?.toISOString();
  const stoppedAt = expected.description.stopDate?.toISOString();
  if (!startedAt || !stoppedAt || operation.started_at !== startedAt || operation.stopped_at !== stoppedAt) {
    throw new Error('Artifact witness does not describe the observed execution instance');
  }
  const entries = array(operation.tasks, 'Artifact witness tasks');
  if (entries.length !== 2) throw new Error('Artifact witness must carry exactly two task entries');
  const tasks = entries.map((entry, index) => {
    const purpose = index === 0 ? 'verification' : 'cleanup';
    const task = exactObject(entry, 'Artifact witness task', WITNESS_TASK_MEMBERS);
    const taskArn = output[`${purpose}_task_arn`];
    const definitionArn = output[`${purpose}_task_definition_arn`];
    const streamPrefix = output[`${purpose}_log_stream_prefix`];
    if (task.task_arn !== taskArn || task.task_definition_arn !== definitionArn || task.kind !== purpose
      || task.status !== 'STOPPED' || task.exit_code !== 0
      || task.image_digest !== expected.envelope.service_image_digest || task.service_commit_sha !== expected.envelope.service_commit_sha
      || task.log_group !== LOG_GROUP || task.log_stream !== `${streamPrefix}/OneShot/${TASK_ARN.exec(taskArn)![1]}`
      || typeof task.snapshot_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(task.snapshot_sha256)
      || task.proof_origin !== 'live') {
      throw new Error('Artifact witness task does not bind its exact stopped task and provenance');
    }
    return { ...task, proof_origin: 'artifact' };
  });
  const committed = validateCommitted(operation.committed_result, expected.envelope);
  if (committed.envelope_sha256 !== envelopeSha256) {
    throw new Error('Artifact witness committed result does not bind the expected envelope bytes');
  }
  return { tasks, committed_result: committed };
}

function defaultIo(versionArn: string): CleanupOperationIo {
  const client = new SFNClient({ region: 'ap-east-1' });
  return {
    async start(input, name) {
      const result = await client.send(new StartExecutionCommand({ stateMachineArn: versionArn, name, input: JSON.stringify(input) }));
      return { executionArn: result.executionArn };
    },
    describe: executionArn => client.send(new DescribeExecutionCommand({ executionArn }), { abortSignal: AbortSignal.timeout(15_000) }),
    async aws(args) {
      try {
        const { stdout } = await execute('aws', [...args, '--region', 'ap-east-1', '--output', 'json', '--no-cli-pager'],
          { timeout: 15_000, maxBuffer: 1024 * 1024, encoding: 'utf8', windowsHide: true });
        return parseStrictJson(stdout);
      } catch (error) {
        const sanitized = new Error('Cleanup read-only AWS evidence request failed');
        if (error && typeof error === 'object' && 'stderr' in error && /ResourceNotFoundException/.test(String(error.stderr))) sanitized.name = 'ResourceNotFoundException';
        throw sanitized;
      }
    },
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  };
}

async function writeEvidence(path: string, evidence: CleanupOperationEvidence): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

interface ExpectedExecution {
  envelope: CleanupOperationEnvelope;
  versionArn: string;
  name: string;
  arn: string;
}

function expectedExecution(envelope: CleanupOperationEnvelope, versionArn: string,
  generation: CleanupExecutionGeneration): ExpectedExecution {
  const name = deterministicCleanupExecutionName(envelope, generation);
  return { envelope, versionArn, name, arn: cleanupExecutionArn(versionArn, name) };
}

/**
 * Read one deterministic execution without starting anything. An absent name is
 * the start candidate; any other describe failure is a refusal, because the entry
 * point must never guess whether an execution exists.
 */
async function describeExecution(io: CleanupOperationIo, arn: string): Promise<DescribeExecutionOutput | undefined> {
  try {
    return await io.describe(arn);
  } catch (error) {
    if (error instanceof Error && error.name === 'ExecutionDoesNotExist') return undefined;
    throw error;
  }
}

function bindsExpected(description: DescribeExecutionOutput, expected: ExpectedExecution): boolean {
  try {
    validateDescription(description, expected.envelope, expected.versionArn, expected.name);
    return true;
  } catch {
    return false;
  }
}

async function recordDescription(evidence: CleanupOperationEvidence, path: string, description: DescribeExecutionOutput): Promise<void> {
  evidence.operation.status = description.status!;
  evidence.operation.started_at = description.startDate?.toISOString();
  evidence.operation.stopped_at = description.stopDate?.toISOString();
  await writeEvidence(path, evidence);
}

/**
 * The in-job budget a cleanup wait must not outlive (#217).
 *
 * A reconcile job passes the deadline it has left, so the wait stops with this error before the
 * job is cancelled and the record it needs to write is lost. Nothing about the operation's
 * evidence changes: the caller records the identities as retained against the deadline.
 */
export class CleanupDeadlineExceededError extends Error {
  readonly code = 'E2E_CLEANUP_DEADLINE_EXCEEDED';

  constructor() {
    super('Cleanup wait reached the caller\'s in-job deadline');
    this.name = 'CleanupDeadlineExceeded';
  }
}

/**
 * ECS answered the exact registered `{arn, reason: 'MISSING'}` shape for one leg (#224).
 *
 * It is an absence, not a contradiction: the stopped task has aged out of ECS's one-hour
 * retention, so a durable tier may prove the same execution instead. Every other shape — a
 * malformed failure object, a foreign task, a task that fails `validateCanonicalTask` — keeps
 * its own error and refuses at `task_proof` without consulting a witness. The message is
 * unchanged from the bare error this replaces.
 */
export class CleanupTaskHistoryUnavailableError extends Error {
  readonly code = 'E2E_CLEANUP_TASK_HISTORY_UNAVAILABLE';

  constructor() {
    super('Cleanup task history fallback is unavailable');
    this.name = 'CleanupTaskHistoryUnavailable';
  }
}

/**
 * The completion marker is absent from a cleanup stream that was read (#224).
 *
 * `readCommitted` throws this only when no marker was observed within its bounded read; a
 * duplicate, malformed or unbound marker keeps its own error and refuses at `completion_proof`.
 * The message is unchanged from the bare error it replaces.
 */
export class CleanupProofAbsentError extends Error {
  readonly code = 'E2E_CLEANUP_PROOF_ABSENT';

  constructor() {
    super('Cleanup log completion marker was not observed within the bounded wait');
    this.name = 'CleanupProofAbsent';
  }
}

/** Resume one execution: observe it until it is terminal, bounded to 900 observations or the deadline. */
async function awaitTerminal(io: CleanupOperationIo, arn: string, envelope: CleanupOperationEnvelope, versionArn: string,
  name: string, evidence: CleanupOperationEvidence, path: string, initial?: DescribeExecutionOutput,
  deadline?: number): Promise<DescribeExecutionOutput> {
  let description = initial;
  let last: DescribeExecutionOutput | undefined;
  for (let observation = 0; observation < 900; observation += 1) {
    if (deadline !== undefined && Date.now() >= deadline) throw new CleanupDeadlineExceededError();
    if (!description) description = await io.describe(arn);
    validateDescription(description, envelope, versionArn, name);
    last = description;
    await recordDescription(evidence, path, description);
    if (description.status === 'SUCCEEDED' || TERMINAL_FAILURE.includes(description.status!)) return description;
    await io.sleep(2_000);
    description = undefined;
  }
  // Every observation was RUNNING: report the last one so the caller refuses
  // with the execution identity it actually observed.
  return last!;
}

async function observePresent(io: CleanupOperationIo, description: DescribeExecutionOutput, expected: ExpectedExecution,
  evidence: CleanupOperationEvidence, path: string, deadline?: number): Promise<DescribeExecutionOutput> {
  if (description.status === 'RUNNING') {
    return awaitTerminal(io, expected.arn, expected.envelope, expected.versionArn, expected.name, evidence, path, description, deadline);
  }
  await recordDescription(evidence, path, description);
  return description;
}

/**
 * The one bounded predecessor check. One inventory pass over the three cleanup
 * task families asks ECS for `RUNNING`-desired tasks only; any returned task
 * means the cleanup family may still be working, so the next generation cannot
 * start. A task whose desired status is already `STOPPED` is outside this
 * single-inventory check.
 */
async function cleanupFamiliesStopped(io: CleanupOperationIo): Promise<string[]> {
  const families: string[] = [];
  for (const family of CLEANUP_FAMILIES) {
    const rows: unknown[] = [];
    const tokens = new Set<string>();
    let token: string | undefined;
    let complete = false;
    for (let page = 0; page < 10; page += 1) {
      const response = object(await io.aws(['ecs', 'list-tasks', '--cluster', CLUSTER, '--family', family,
        '--desired-status', 'RUNNING', '--max-results', '100', '--no-paginate', ...(token ? ['--next-token', token] : [])]),
      'Cleanup family inventory');
      const taskArns = array(response.taskArns, 'Cleanup family tasks');
      if (taskArns.length > 100 || rows.length + taskArns.length > 1000) throw new Error('Cleanup family inventory exceeds its bound');
      rows.push(...taskArns);
      if (response.nextToken === undefined) { complete = true; break; }
      if (typeof response.nextToken !== 'string' || !response.nextToken || tokens.has(response.nextToken)) {
        throw new Error('Cleanup family inventory pagination is incomplete or repeated');
      }
      tokens.add(response.nextToken);
      token = response.nextToken;
    }
    if (!complete) throw new Error('Cleanup family inventory pagination exceeds its bound');
    for (const arn of rows) {
      if (typeof arn !== 'string' || !TASK_ARN.test(arn)) throw new Error('Cleanup family inventory contains a foreign task');
    }
    if (rows.length !== 0) throw new Error('Cleanup family still has RUNNING tasks; the next generation is refused');
    families.push(family);
  }
  return families;
}

/**
 * Start or resume the deterministic cleanup operation for one captured run
 * scope.
 *
 * The caller is the run's own teardown or the `reconcile` operation, and both
 * take the same normal path: resolve generation 0, resume it while it runs,
 * verify it when it succeeded, and start generation 1 only after generation 0 is
 * terminal non-success and exactly one bounded predecessor check (its describe
 * plus one cleanup-family inventory) shows the cleanup families stopped. If
 * generation 1 already exists it is resumed or verified; if it is already
 * terminal non-success the dispatch refuses and starts nothing. Without the
 * explicit migration allowance, at most two deterministic names exist per
 * captured scope.
 *
 * Only the 90-day migration reconcile passes `options.migrationGeneration`, and
 * that allowance adds exactly one more name, `-migration1`, derived from the
 * same envelope and therefore the same `runScope` and request hash. It may start
 * only when generation 0 and generation 1 both exist and are terminal
 * non-success, and one bounded predecessor check shows the cleanup families
 * stopped. That name is started at most once: if it already exists it is resumed
 * while running and verified when it succeeded, and if it is itself terminal
 * non-success the dispatch refuses and starts nothing else. The allowance never
 * manufactures its own precondition: a migration dispatch that finds generation
 * 1 absent refuses instead of starting the ordinary retry, because the extra
 * generation is defined only against an already-exhausted captured scope.
 * Generation 0 keeps its ordinary behavior — absent is started, running is
 * resumed, succeeded is verified — so a scope with no execution is still cleaned.
 */
export async function runCleanupOperation(inputs: ServiceCleanupInputs, environment: NodeJS.ProcessEnv = process.env,
  io?: CleanupOperationIo, options: CleanupOperationOptions = {}): Promise<CleanupOperationEvidence | undefined> {
  // The allowance is an explicit opt-in, never a truthy side effect of a caller that
  // forwards an arbitrary options object. It is rejected before the first read or start.
  if (options.migrationGeneration !== undefined && typeof options.migrationGeneration !== 'boolean') {
    throw new Error('Cleanup migration allowance must be an explicit boolean');
  }
  const migrationAllowed = options.migrationGeneration === true;
  const versionArn = environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN;
  if (!versionArn) {
    console.warn('Beta cleanup capability is not configured; cleanup deferred and identities retained');
    return undefined;
  }
  const envelope = createCleanupOperationEnvelope(inputs, environment);
  const current = [expectedExecution(envelope, versionArn, 0), expectedExecution(envelope, versionArn, 1)];
  const transport = io ?? defaultIo(versionArn);
  const path = environment.E2E_SERVICE_CLEANUP_EVIDENCE_PATH ?? 'test-results/service-cleanup-operation.json';
  const evidence: CleanupOperationEvidence = { schema_version: 4, record_type: 'anywear_e2e_service_cleanup_operation',
    operation: { operation_mode: 'normal', state_machine_version_arn: current[0].versionArn, execution_arn: current[0].arn,
      execution_name: current[0].name, status: 'PENDING', proof_status: 'pending',
      input_sha256: hash(JSON.stringify(current[0].envelope)), input: current[0].envelope } };
  let refusalPhase: CleanupRefusalPhase = 'operation_start';
  let refusalCategory: CleanupRefusalCategory = 'operation_start_unavailable';
  const target = (expected: ExpectedExecution) => {
    evidence.operation.state_machine_version_arn = expected.versionArn;
    evidence.operation.execution_name = expected.name;
    evidence.operation.execution_arn = expected.arn;
    evidence.operation.input = expected.envelope;
    evidence.operation.input_sha256 = hash(JSON.stringify(expected.envelope));
    evidence.operation.status = 'PENDING';
    evidence.operation.started_at = undefined;
    evidence.operation.stopped_at = undefined;
  };
  const start = async () => {
    await writeEvidence(path, evidence);
    try {
      const started = await transport.start(evidence.operation.input, evidence.operation.execution_name);
      if (started.executionArn && started.executionArn !== evidence.operation.execution_arn) throw new Error('Cleanup start returned a foreign execution ARN');
    } catch (error) {
      if (!(error instanceof Error) || !['ExecutionAlreadyExists', 'TimeoutError', 'RequestTimeout', 'NetworkingError', 'InternalServerError', 'ServiceUnavailable'].includes(error.name)) throw error;
      // The exact resolution below settles a completed name or a lost response.
    }
  };
  const verifySuccess = async (description: DescribeExecutionOutput, proofEnvelope: CleanupOperationEnvelope): Promise<CleanupOperationEvidence> => {
    refusalPhase = 'execution_observation';
    refusalCategory = 'execution_not_succeeded';
    if (!description.output || description.outputDetails?.included !== true) throw new Error('Cleanup did not expose complete terminal success');
    refusalPhase = 'result_proof';
    refusalCategory = 'result_proof_unavailable';
    const output = validateResult(parseStrictJson(description.output), proofEnvelope);
    evidence.operation.output = output;
    await writeEvidence(path, evidence);
    refusalPhase = 'task_proof';
    refusalCategory = 'task_proof_unavailable';
    // Both legs are attempted in the unchanged order. A clean `MISSING` is an absence that opens
    // the durable tiers; every other answer — a malformed failure object, a foreign task, a task
    // that fails `validateCanonicalTask` — is a contradiction and refuses here without a witness.
    const observed: { verification?: Record<string, unknown>; cleanup?: Record<string, unknown> } = {};
    const missing: ('verification' | 'cleanup')[] = [];
    for (const purpose of ['verification', 'cleanup'] as const) {
      try {
        observed[purpose] = await observeTask(transport, proofEnvelope, output[`${purpose}_task_arn`],
          output[`${purpose}_task_definition_arn`]);
      } catch (error) {
        if (!(error instanceof CleanupTaskHistoryUnavailableError)) throw error;
        missing.push(purpose);
      }
    }
    const envelopeSha256 = hash(JSON.stringify(proofEnvelope));
    if (missing.length === 0) {
      // Tier 1, the strong live proof: unchanged four ECS calls and the unchanged marker wait.
      const verification = observed.verification!;
      const cleanup = observed.cleanup!;
      if (verification.kind !== 'verification' || cleanup.kind !== 'cleanup') throw new Error('Cleanup tasks exchanged their fixed purposes');
      evidence.operation.tasks = [verification, cleanup];
      await writeEvidence(path, evidence);
      refusalPhase = 'completion_proof';
      refusalCategory = 'completion_proof_unavailable';
      evidence.operation.committed_result = await readCommitted(transport, proofEnvelope, String(cleanup.log_stream),
        String(cleanup.envelope_sha256), 15);
      evidence.operation.proof_origin = 'live';
      evidence.operation.proof_status = 'verified';
      await writeEvidence(path, evidence);
      return evidence;
    }
    // Tier 2: at least one leg has aged out of ECS. The marker is read once, from the cleanup
    // stream the validated output names, and binds the live cleanup task's own envelope hash when
    // that leg is still observable or the recomputed expected hash when it is not.
    const liveEnvelopeSha256 = typeof observed.cleanup?.envelope_sha256 === 'string' ? observed.cleanup.envelope_sha256 : undefined;
    const logStream = `${output.cleanup_log_stream_prefix}/OneShot/${TASK_ARN.exec(output.cleanup_task_arn)![1]}`;
    refusalPhase = 'completion_proof';
    refusalCategory = 'completion_proof_unavailable';
    let committed: Record<string, unknown> | undefined;
    try {
      committed = await readCommitted(transport, proofEnvelope, logStream, liveEnvelopeSha256 ?? envelopeSha256, 1);
    } catch (error) {
      if (!(error instanceof CleanupProofAbsentError)) throw error;
    }
    if (committed) {
      evidence.operation.proof_origin = 'marker';
      evidence.operation.committed_result = committed;
      evidence.operation.proof_status = 'verified';
      await writeEvidence(path, evidence);
      return evidence;
    }
    // Tier 3: only both absences open the archived record, because an archived record must never
    // stand in for a task ECS can still show. One observed leg with no marker refuses.
    refusalPhase = 'task_proof';
    refusalCategory = 'task_proof_unavailable';
    if (missing.length === 2 && options.recovery) {
      const stoppedAt = description.stopDate?.toISOString();
      if (!stoppedAt) throw new Error('Cleanup execution has no stop instant to bind a durable witness');
      const witness = await options.recovery(evidence.operation.execution_name, stoppedAt);
      if (!witness) throw new Error('Cleanup task history fallback is unavailable');
      const validated = validateArtifactWitness(witness, { envelope: proofEnvelope,
        versionArn: evidence.operation.state_machine_version_arn, executionName: evidence.operation.execution_name, output, description });
      evidence.operation.proof_origin = 'artifact';
      evidence.operation.artifact_source = witness.source;
      evidence.operation.tasks = validated.tasks;
      evidence.operation.committed_result = validated.committed_result;
      evidence.operation.proof_status = 'verified';
      await writeEvidence(path, evidence);
      return evidence;
    }
    throw new Error('Cleanup task history fallback is unavailable');
  };
  try {
    // Generation 0. The ordinary dispatch resolves the current operation; an absent
    // generation 0 is started under the current version and normal envelope.
    refusalPhase = 'execution_observation';
    refusalCategory = 'execution_observation_unavailable';
    let expected: ExpectedExecution;
    let description = await describeExecution(transport, current[0].arn);
    if (!description) {
      expected = current[0];
      target(expected);
      refusalPhase = 'operation_start';
      refusalCategory = 'operation_start_unavailable';
      await start();
      refusalPhase = 'execution_observation';
      refusalCategory = 'execution_observation_unavailable';
      description = await awaitTerminal(transport, expected.arn, expected.envelope, expected.versionArn, expected.name, evidence, path, undefined, options.deadline);
    } else if (bindsExpected(description, current[0])) {
      expected = current[0];
      target(expected);
      description = await observePresent(transport, description, expected, evidence, path, options.deadline);
    } else {
      throw new Error('Observed generation 0 does not bind the current operation');
    }
    if (description.status === 'SUCCEEDED') return await verifySuccess(description, expected.envelope);
    if (description.status === 'RUNNING') {
      refusalPhase = 'execution_observation';
      refusalCategory = 'execution_not_succeeded';
      throw new Error('Cleanup execution did not reach a terminal state within the bounded wait');
    }
    // Generation 0 is terminal non-success. One bounded predecessor check
    // (its describe above plus this single inventory pass) gates generation 1.
    refusalPhase = 'retry_proof';
    refusalCategory = 'retry_proof_unavailable';
    const families = await cleanupFamiliesStopped(transport);
    evidence.operation.preceding_execution = { execution_arn: description.executionArn!, status: description.status!,
      ...(description.stopDate ? { stopped_at: description.stopDate.toISOString() } : {}), cleanup_families: families };
    await writeEvidence(path, evidence);
    target(current[1]);
    refusalPhase = 'execution_observation';
    refusalCategory = 'execution_observation_unavailable';
    let retry = await describeExecution(transport, current[1].arn);
    if (!retry) {
      if (migrationAllowed) {
        // The extra generation is defined against an exhausted captured scope; a
        // migration dispatch never starts the ordinary retry to manufacture one.
        refusalPhase = 'retry_eligibility';
        refusalCategory = 'retry_not_authorized';
        throw new Error('Migration cleanup requires the captured scope\'s one retry to exist; no ordinary retry is started');
      }
      refusalPhase = 'operation_start';
      refusalCategory = 'operation_start_unavailable';
      await start();
      refusalPhase = 'execution_observation';
      refusalCategory = 'execution_observation_unavailable';
      retry = await awaitTerminal(transport, current[1].arn, current[1].envelope, current[1].versionArn, current[1].name, evidence, path, undefined, options.deadline);
    } else {
      validateDescription(retry, current[1].envelope, current[1].versionArn, current[1].name);
      retry = await observePresent(transport, retry, current[1], evidence, path, options.deadline);
    }
    if (retry.status === 'SUCCEEDED') return await verifySuccess(retry, current[1].envelope);
    if (retry.status === 'RUNNING') {
      refusalPhase = 'execution_observation';
      refusalCategory = 'execution_not_succeeded';
      throw new Error('Cleanup retry did not reach a terminal state within the bounded wait');
    }
    if (!migrationAllowed) {
      refusalPhase = 'retry_eligibility';
      refusalCategory = 'retry_not_authorized';
      throw new Error('Cleanup retry already exists and is terminal non-success; no third execution is started');
    }
    // The 90-day migration reconcile's one extra generation. Both ordinary generations
    // exist and are terminal non-success, and the request is unchanged, so the migration
    // name is derived from the same envelope as the base: the captured run scope and its
    // cleanup operation identity are preserved, never re-scoped.
    const migration = expectedExecution(envelope, versionArn, MIGRATION_GENERATION);
    target(migration);
    refusalPhase = 'execution_observation';
    refusalCategory = 'execution_observation_unavailable';
    let migrated = await describeExecution(transport, migration.arn);
    if (!migrated) {
      // The single bounded predecessor check for this generation: retry 1's terminal
      // describe above plus one cleanup-family inventory, the same check and refusal
      // categories that gate generation 1.
      refusalPhase = 'retry_proof';
      refusalCategory = 'retry_proof_unavailable';
      const migrationFamilies = await cleanupFamiliesStopped(transport);
      evidence.operation.preceding_execution = { execution_arn: retry.executionArn!, status: retry.status!,
        ...(retry.stopDate ? { stopped_at: retry.stopDate.toISOString() } : {}), cleanup_families: migrationFamilies };
      await writeEvidence(path, evidence);
      refusalPhase = 'operation_start';
      refusalCategory = 'operation_start_unavailable';
      await start();
      refusalPhase = 'execution_observation';
      refusalCategory = 'execution_observation_unavailable';
      migrated = await awaitTerminal(transport, migration.arn, migration.envelope, migration.versionArn, migration.name, evidence, path, undefined, options.deadline);
    } else {
      validateDescription(migrated, migration.envelope, migration.versionArn, migration.name);
      migrated = await observePresent(transport, migrated, migration, evidence, path, options.deadline);
    }
    if (migrated.status === 'SUCCEEDED') return await verifySuccess(migrated, migration.envelope);
    if (migrated.status === 'RUNNING') {
      refusalPhase = 'execution_observation';
      refusalCategory = 'execution_not_succeeded';
      throw new Error('Cleanup migration generation did not reach a terminal state within the bounded wait');
    }
    refusalPhase = 'retry_eligibility';
    refusalCategory = 'retry_not_authorized';
    throw new Error('Cleanup migration generation already exists and is terminal non-success; no fourth execution is started');
  } catch (error) {
    evidence.operation.proof_status = 'refused';
    evidence.operation.failure = 'Exact execution/task/committed-result proof unavailable; Cognito identities retained';
    evidence.operation.refusal_phase = refusalPhase;
    evidence.operation.refusal_category = refusalCategory;
    await writeEvidence(path, evidence);
    // The deadline stop stays distinguishable for the caller: a reconcile records it as
    // `deadline_exceeded` and still writes its record, rather than as a Service refusal.
    if (error instanceof CleanupDeadlineExceededError) throw error;
    throw new Error(evidence.operation.failure, { cause: error });
  }
}
