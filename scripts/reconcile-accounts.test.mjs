import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertIdentitySetWithinContract,
  buildIdentitySet,
  buildReconcileRecord,
  classifyLifecycleArchive,
  classifyReconcileArchive,
  cleanupGroups,
  cleanupRequest,
  collectLifecycleArtifacts,
  createReconcileIo,
  creationRunScope,
  judgeResult,
  lifecycleArtifactBinding,
  lifecycleWorkflowRunBinding,
  lookbackDaysOfWindow,
  manifestIdentities,
  maxArtifactsForWindow,
  maxReconcileArtifactsForWindow,
  normalizeAccountStatus,
  objectAction,
  parseCreateUserEvents,
  parseManifestArtifactName,
  parseReconcileArtifactName,
  qualificationSession,
  readManifest,
  reconcileAccounts,
  reconcileWindow,
  recordAnnotations,
  validateReconcileRecord,
  E2E_REPOSITORY_ID,
  LIFECYCLE_FILE_MAX_BYTES,
  RECONCILE_ARTIFACTS_PER_DAY,
  RECONCILE_CLOUDTRAIL_MARGIN_MS,
  RECONCILE_MAX_USERS_PER_REQUEST,
  RECONCILE_MIGRATION_WINDOW_DAYS,
  RECONCILE_RECORD_ARTIFACTS_PER_DAY,
  RECONCILE_RECORD_TYPE,
  RECONCILE_SCHEMA_VERSION,
  RECONCILE_WINDOW_DAYS,
  RECONCILE_WITNESS_ARTIFACT_READS,
  REPORTED_REASONS,
  UNRESOLVED_REASONS,
} from './reconcile-accounts.mjs';
import { isCapturedBetaWorkerEmail } from '../tests/support/beta-address.ts';

const NOW = Date.parse('2026-10-23T00:00:00.000Z');
const DAY = 24 * 60 * 60_000;
const runIdentity = { runId: 900, attempt: 1 };
const stable = (slot = 0) => `e2e-beta-worker-${slot}-chromium@anywear.local`;
const scoped = (slot = 0, runScope = '123456789-1-0123456789abcdef') => `e2e-beta-${runScope}-${slot}-a1b2c3d4@anywear.local`;
const subject = (n = 1) => `10000000-0000-4000-8000-00000000000${n}`;
const HEAD_SHA = 'a'.repeat(40);
const qualificationRole = (session = 'e2e-123456789-1') => `arn:aws:sts::650880818323:assumed-role/beta-e2e-qualification-role/${session}`;

function manifestRecord(overrides = {}) {
  return {
    email: stable(0),
    mode: 'worker',
    status: 'retained',
    createdAt: new Date(NOW - 2 * DAY).toISOString(),
    updatedAt: new Date(NOW - 2 * DAY + 60_000).toISOString(),
    retainedReason: 'teardown: business cleanup failed',
    reconcileBy: new Date(NOW - DAY).toISOString(),
    ...overrides,
  };
}

function manifestFixture(run, attempt, accounts, { createdAt = new Date(NOW - 2 * DAY).toISOString() } = {}) {
  return {
    artifact: { runId: run, attempt, smoke: false, createdAt },
    manifest: { version: 1, runScope: `${run}-${attempt}-0123456789abcdef`, config: { maxActiveAccounts: 2, maxNewAccountsPerRun: 6 }, accounts },
  };
}

function creation(email, { eventTime = new Date(NOW - 2 * DAY + 30_000).toISOString(), caller = qualificationRole(), eventId = 'event-1', userPoolId } = {}) {
  return {
    EventId: eventId,
    EventTime: eventTime,
    CloudTrailEvent: JSON.stringify({
      eventName: 'AdminCreateUser',
      eventID: eventId,
      eventTime,
      userIdentity: { arn: caller },
      requestParameters: { username: email, ...(userPoolId ? { userPoolId } : {}) },
    }),
  };
}

const BETA_POOL_ID = 'ap-east-1_XqXt4Kw1L';
const MASKED = 'HIDDEN_DUE_TO_SECURITY_REASONS';

/**
 * A `AdminCreateUser` event in the shape the live pool actually records (#217).
 *
 * CloudTrail masks every created identity: `requestParameters.username` and
 * `requestParameters.userAttributes` are the literal `HIDDEN_DUE_TO_SECURITY_REASONS`, the
 * response element is masked too, the event carries no `Resources` array, and the immutable
 * Cognito username is `additionalEventData.sub`. This fixture is that payload, byte for byte in
 * the fields the parser reads.
 */
function maskedCreation(sub, { eventTime = new Date(NOW - 2 * DAY + 30_000).toISOString(), caller = qualificationRole(), eventId = 'masked-1', userPoolId = BETA_POOL_ID } = {}) {
  return {
    EventId: eventId,
    // The AWS CLI serializes its own `EventTime` with a numeric offset, not a `Z` suffix; the
    // event's embedded `eventTime` stays `Z`. Mirror both, as the live lookup response does.
    EventTime: new Date(Date.parse(eventTime)).toISOString().replace('Z', '+00:00'),
    CloudTrailEvent: JSON.stringify({
      eventVersion: '1.11',
      eventSource: 'cognito-idp.amazonaws.com',
      eventName: 'AdminCreateUser',
      awsRegion: 'ap-east-1',
      eventID: eventId,
      eventTime,
      userIdentity: { type: 'AssumedRole', arn: caller, accountId: '650880818323' },
      requestParameters: {
        userPoolId,
        username: MASKED,
        userAttributes: MASKED,
        forceAliasCreation: false,
        messageAction: 'SUPPRESS',
      },
      responseElements: { user: { username: MASKED, attributes: MASKED, userStatus: 'FORCE_CHANGE_PASSWORD' } },
      ...(sub === undefined ? {} : { additionalEventData: { sub } }),
      readOnly: false,
      eventType: 'AwsApiCall',
      managementEvent: true,
      recipientAccountId: '650880818323',
    }),
  };
}

function userNotFound() {
  return Object.assign(new Error('User does not exist.'), { name: 'UserNotFoundException' });
}

function committedResult(overrides = {}) {
  return { schema_version: 1, record_type: 'anywear_beta_cleanup_result', source: 'beta-tester-cleanup', transaction_committed: true, objects: 2, objectsMissing: 0, ...overrides };
}

/** One lifecycle artifact: its published name, the run it belongs to, and its upload set. */
function artifactFixture(index, { runId = 123, attempt = 1, files = ['account-budget.json', 'service-cleanup-operation.json', 'service-cleanup-run.json'], headBranch = 'main', run = {}, manifest } = {}) {
  const entries = files.map((name) => ({ name, size: 200, directory: false, symlink: false }));
  if (manifest !== undefined) entries[0] = { ...entries[0], bytes: Buffer.from(JSON.stringify(manifest)) };
  return {
    entry: {
      id: index + 1,
      name: `beta-account-lifecycle-${runId}-${attempt}`,
      expired: false,
      created_at: new Date(NOW - 2 * DAY).toISOString(),
      digest: `sha256:${'b'.repeat(64)}`,
      workflow_run: { id: runId, head_branch: headBranch, head_sha: HEAD_SHA, repository_id: E2E_REPOSITORY_ID, head_repository_id: E2E_REPOSITORY_ID },
    },
    entries,
    run: { path: '.github/workflows/beta-qualification.yml', event: 'workflow_dispatch', head_branch: 'main', head_sha: HEAD_SHA, ...run },
  };
}

/** One repository artifact-list page, as the production listing transport returns it. */
function artifactPages(rows, pageSize = 100) {
  return (page) => ({ total_count: rows.length, artifacts: rows.slice((page - 1) * pageSize, page * pageSize) });
}

/** One artifact belonging to another workflow: it must never consume the lifecycle bound. */
function unrelatedArtifact(index) {
  return {
    id: 10_000 + index,
    name: `playwright-report-${index}`,
    expired: false,
    created_at: new Date(NOW - DAY).toISOString(),
    digest: `sha256:${'c'.repeat(64)}`,
    workflow_run: { id: 50_000 + index, head_branch: 'main', head_sha: HEAD_SHA, repository_id: E2E_REPOSITORY_ID, head_repository_id: E2E_REPOSITORY_ID },
  };
}

/** The execution a reconcile-side witness test proves, and its own stop instant (#224). */
const WITNESS_EXECUTION = 'beta-cleanup-123-1-0123456789abcdef-0123456789abcdef';
const WITNESS_STOPPED_AT = new Date(NOW - 3 * DAY).toISOString();

/** One verified live-root Service cleanup operation record, as an uploaded artifact carries it. */
function cleanupRecord({ executionName = WITNESS_EXECUTION, schemaVersion = 4, proofOrigin = 'live', tasks, patch = {} } = {}) {
  return { schema_version: schemaVersion, record_type: 'anywear_e2e_service_cleanup_operation', operation: {
    operation_mode: 'normal',
    state_machine_version_arn: 'arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup:7',
    execution_arn: `arn:aws:states:ap-east-1:650880818323:execution:beta-anywear-tester-cleanup:${executionName}`,
    execution_name: executionName, started_at: WITNESS_STOPPED_AT, stopped_at: WITNESS_STOPPED_AT,
    status: 'SUCCEEDED', proof_status: 'verified', ...(schemaVersion === 4 ? { proof_origin: proofOrigin } : {}),
    input_sha256: 'a'.repeat(64), input: {}, output: {},
    tasks: tasks ?? [
      { task_arn: `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'1'.repeat(32)}`, kind: 'verification', proof_origin: 'live' },
      { task_arn: `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'2'.repeat(32)}`, kind: 'cleanup', proof_origin: 'live' },
    ],
    committed_result: { envelope_sha256: 'b'.repeat(64), transaction_committed: true, objects: 2, objectsMissing: 0 }, ...patch } };
}

/** One reconcile-family artifact: its two diagnostics and any per-scope operation records. */
function reconcileArtifactFixture(index, { runId = 124, attempt = 1, createdAt = new Date(NOW - DAY).toISOString(),
  records = [], headBranch = 'main', run = {} } = {}) {
  const entries = ['account-reconcile.json', 'deployment-evidence.json']
    .map(name => ({ name, size: 200, directory: false, symlink: false }));
  for (const { file, record } of records) {
    const bytes = Buffer.from(JSON.stringify(record));
    entries.push({ name: file, size: bytes.length, directory: false, symlink: false, bytes });
  }
  return {
    entry: { id: index + 1, name: `beta-account-reconcile-${runId}-${attempt}`, expired: false, created_at: createdAt,
      digest: `sha256:${'b'.repeat(64)}`,
      workflow_run: { id: runId, head_branch: headBranch, head_sha: HEAD_SHA, repository_id: E2E_REPOSITORY_ID, head_repository_id: E2E_REPOSITORY_ID } },
    entries,
    run: { path: '.github/workflows/beta-qualification.yml', event: 'workflow_dispatch', head_branch: 'main', head_sha: HEAD_SHA, ...run },
  };
}

/** One lifecycle artifact whose teardown diagnostic is a verified cleanup operation record (#224). */
function lifecycleArtifactWithDiagnostic(index, record, { runId = 123, attempt = 1,
  createdAt = new Date(NOW - 2 * DAY).toISOString(), accounts = [manifestRecord({ subject: subject(1) })] } = {}) {
  const fixture = artifactFixture(index, { runId, attempt, manifest: manifestFixture(runId, attempt, accounts).manifest });
  fixture.entry.created_at = createdAt;
  fixture.entries = fixture.entries.map(entry => entry.name === 'service-cleanup-operation.json'
    ? { ...entry, bytes: Buffer.from(JSON.stringify(record)) } : entry);
  return fixture;
}

/**
 * Run one reconcile whose fake Service cleanup asks the lookup for the witness, the way the real
 * verifier does once the marker and both ECS tasks are gone. The fake returns `verified` only
 * when the lookup answers, so the reconcile record reflects what the lookup decided.
 */
async function witnessRun({ artifacts, users = [], executionName = WITNESS_EXECUTION, stoppedAt = WITNESS_STOPPED_AT }) {
  let witness;
  let lookups = 0;
  const harnessed = harness({ artifacts, users, cleanup: async (_inputs, _environment, options) => {
    lookups += 1;
    witness = await options.recovery(executionName, stoppedAt);
    return witness ? { proof_status: 'verified', committed_result: committedResult() } : { proof_status: 'refused' };
  } });
  const logs = [];
  const outcome = await reconcileAccounts({ io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {},
    log: line => logs.push(line) });
  return { ...outcome, harnessed, logs, getWitness: () => witness, lookups: () => lookups };
}

function harness({ artifacts = [], events = [], users = [], cleanup = async () => ({ proof_status: 'verified', committed_result: committedResult() }), readArtifact } = {}) {
  const directory = new Map(users.map((entry) => [entry.email, { username: `sub-${entry.sub.slice(0, 8)}`, sub: entry.sub }]));
  const calls = [];
  const byId = new Map(artifacts.map((artifact) => [artifact.entry.id, artifact]));
  return {
    calls,
    directory,
    io: {
      async listArtifacts() { return artifacts.map((artifact) => artifact.entry); },
      async readArtifact(artifact) {
        calls.push({ artifact: artifact.id });
        if (readArtifact) return await readArtifact(artifact);
        return byId.get(artifact.id).entries;
      },
      async getWorkflowRun(runId) {
        calls.push({ run: runId });
        return byId.get([...byId.keys()].find((id) => byId.get(id).entry.workflow_run.id === runId))?.run;
      },
      async lookupCreateUserEvents() { calls.push({ cloudtrail: true }); return events; },
      async getUser(email) {
        calls.push({ get: email });
        const entry = directory.get(email);
        if (!entry) throw userNotFound();
        return { Username: entry.username, UserAttributes: [{ Name: 'email', Value: email }, { Name: 'sub', Value: entry.sub }] };
      },
      /**
       * Resolve a masked creation's `sub` the way the live pool does: the immutable username is
       * the sub, and `AdminGetUser(Username=<sub>)` returns that identity and its address.
       */
      async getUserByUsername(username) {
        calls.push({ getUsername: username });
        const entry = [...directory.entries()].find(([, value]) => value.sub === username);
        if (!entry) throw userNotFound();
        return { Username: username, UserAttributes: [{ Name: 'email', Value: entry[0] }, { Name: 'sub', Value: entry[1].sub }] };
      },
      async deleteUser(username) {
        calls.push({ delete: username });
        for (const [email, entry] of directory) if (entry.username === username) directory.delete(email);
      },
      async runServiceCleanup(inputs, environment, options) {
        calls.push({ service: inputs, environment, options });
        return cleanup(inputs, environment, options);
      },
    },
  };
}

/** The common case: one bound artifact carrying one manifest and one retained identity. */
function retainedFixture({ accounts = [manifestRecord({ subject: subject(1) })], runId = 123, attempt = 1 } = {}) {
  const fixture = manifestFixture(runId, attempt, accounts);
  return artifactFixture(0, { runId, attempt, manifest: fixture.manifest });
}

test('the reconcile window is a closed lookback: seven days, or the one 90-day migration dispatch', () => {
  const window = reconcileWindow(NOW);
  assert.equal(window.to, '2026-10-23T00:00:00.000Z');
  assert.equal(window.from, '2026-10-16T00:00:00.000Z');
  assert.equal((Date.parse(window.to) - Date.parse(window.from)) / DAY, RECONCILE_WINDOW_DAYS);
  assert.throws(() => reconcileWindow(NOW, 0), /positive integer/);
  for (const days of [1, 30, 89, 91]) assert.throws(() => reconcileWindow(NOW, days), /one of 7, 90 days/, String(days));

  // The migration dispatch reads the 90-day artifact retention, nine artifacts per day, but it
  // starts just inside CloudTrail's 90-day LookupEvents range: a window starting exactly at
  // `now - 90 days` can be rejected as outside the accepted range when the request is evaluated.
  const migration = reconcileWindow(NOW, RECONCILE_MIGRATION_WINDOW_DAYS);
  assert.equal(Date.parse(migration.to) - Date.parse(migration.from), RECONCILE_MIGRATION_WINDOW_DAYS * DAY - RECONCILE_CLOUDTRAIL_MARGIN_MS);
  assert.ok(RECONCILE_CLOUDTRAIL_MARGIN_MS > 0 && RECONCILE_CLOUDTRAIL_MARGIN_MS < 60 * 60_000);
  assert.equal(lookbackDaysOfWindow(migration), RECONCILE_MIGRATION_WINDOW_DAYS);
  assert.equal(maxArtifactsForWindow(window), RECONCILE_WINDOW_DAYS * RECONCILE_ARTIFACTS_PER_DAY);
  assert.equal(maxArtifactsForWindow(migration), RECONCILE_MIGRATION_WINDOW_DAYS * RECONCILE_ARTIFACTS_PER_DAY);
  assert.equal(RECONCILE_ARTIFACTS_PER_DAY, 9);

  const record = buildReconcileRecord({
    reconcileId: '900-1', window, sources: { artifacts: 1, artifacts_ignored: 0, cloudtrail_events: 0 },
    identities: [], unresolved: [], result: 'passed',
  });
  assert.equal(record.record_type, RECONCILE_RECORD_TYPE);
  assert.equal(record.schema_version, RECONCILE_SCHEMA_VERSION);
  // A zero-artifact scan is valid (CloudTrail-only reconcile); the count is bounded per day.
  assert.equal(buildReconcileRecord({
    reconcileId: '900-1', window, sources: { artifacts: 0, artifacts_ignored: 3, cloudtrail_events: 0 },
    identities: [], unresolved: [], result: 'passed',
  }).sources.artifacts_ignored, 3);
  for (const artifacts of [-1, maxArtifactsForWindow(window) + 1, 1.5]) {
    assert.throws(() => buildReconcileRecord({
      reconcileId: '900-1', window, sources: { artifacts, artifacts_ignored: 0, cloudtrail_events: 0 },
      identities: [], unresolved: [], result: 'passed',
    }), /artifact count is unbounded/, String(artifacts));
  }
  // Both bounds are the record's own: the 90-day window admits more artifacts than seven days.
  assert.doesNotThrow(() => buildReconcileRecord({
    reconcileId: '900-1', window: migration, sources: { artifacts: maxArtifactsForWindow(migration), artifacts_ignored: 0, cloudtrail_events: 0 },
    identities: [], unresolved: [], result: 'passed',
  }));
  assert.throws(() => buildReconcileRecord({
    reconcileId: '900-1',
    window: { from: '2026-10-20T00:00:00.000Z', to: '2026-10-23T00:00:00.000Z' },
    sources: { artifacts: 1, artifacts_ignored: 0, cloudtrail_events: 0 }, identities: [], unresolved: [], result: 'passed',
  }), /reviewed lookback/);
});

test('the address grammar accepts the stable pool and the historical scoped family only', () => {
  assert.ok(isCapturedBetaWorkerEmail(stable(7)));
  assert.ok(isCapturedBetaWorkerEmail(scoped(3)));
  for (const foreign of [
    'e2e-beta-worker-8-chromium@anywear.local',
    'e2e-beta-123-1-0123456789abcdef-8-a1b2c3d4@anywear.local',
    'e2e-functional-account@anywear.local',
    'someone@example.com',
  ]) assert.equal(isCapturedBetaWorkerEmail(foreign), false, foreign);
});

test('the lifecycle artifact name keeps the historical shape and rejects anything else', () => {
  assert.deepEqual(parseManifestArtifactName('beta-account-lifecycle-123-1'), { smoke: false, runId: 123, attempt: 1 });
  assert.deepEqual(parseManifestArtifactName('beta-smoke-account-lifecycle-123-2'), { smoke: true, runId: 123, attempt: 2 });
  for (const name of ['beta-account-lifecycle-0-1', 'beta-account-lifecycle-123', 'beta-account-reconcile-123-1', 'beta-account-lifecycle-123-1-extra']) {
    assert.equal(parseManifestArtifactName(name), undefined, name);
  }
});

test('the reader accepts exactly the closed upload set, with both account manifests', () => {
  const entry = (name, extra = {}) => ({ name, size: 210, ...extra });
  // A `full` artifact: both account legs and both cleanup diagnostics.
  const full = classifyLifecycleArchive([
    entry('account-budget.json'), entry('account-budget-oldest-client.json'),
    entry('service-cleanup-operation.json'), entry('service-cleanup-run.json'),
  ]);
  assert.deepEqual(full, { manifests: ['account-budget-oldest-client.json', 'account-budget.json'], diagnostics: 2 });
  // A `smoke` artifact carries the first, third and fourth.
  assert.deepEqual(classifyLifecycleArchive([
    entry('account-budget.json'), entry('service-cleanup-operation.json'), entry('service-cleanup-run.json'),
  ]), { manifests: ['account-budget.json'], diagnostics: 2 });
  // A historical artifact may name only the oldest-client leg: no specific manifest is required.
  assert.deepEqual(classifyLifecycleArchive([entry('account-budget-oldest-client.json')]),
    { manifests: ['account-budget-oldest-client.json'], diagnostics: 0 });
  // A manifest-less set is accepted and contributes nothing: the CloudTrail creation is the source.
  assert.deepEqual(classifyLifecycleArchive([entry('service-cleanup-run.json')]), { manifests: [], diagnostics: 1 });

  // Rejections: an unknown name, a directory, a symlink, a duplicate, an over-bound file, an empty set.
  assert.throws(() => classifyLifecycleArchive([entry('account-budget.json'), entry('other.json')]), /unknown file/);
  assert.throws(() => classifyLifecycleArchive([entry('test-results/account-budget.json')]), /unknown file/);
  assert.throws(() => classifyLifecycleArchive([entry('account-budget.json', { directory: true })]), /directory or symlink/);
  assert.throws(() => classifyLifecycleArchive([entry('account-budget.json', { symlink: true })]), /directory or symlink/);
  assert.throws(() => classifyLifecycleArchive([entry('account-budget.json'), entry('account-budget.json')]), /repeats/);
  assert.throws(() => classifyLifecycleArchive([entry('account-budget.json', { size: LIFECYCLE_FILE_MAX_BYTES + 1 })]), /over its bound/);
  assert.throws(() => classifyLifecycleArchive([]), /empty/);
  assert.throws(() => classifyLifecycleArchive([{ name: 'account-budget.json' }]), /over its bound/);
});

test('a lifecycle artifact is authoritative only when it is bound to the protected run', () => {
  const run = (overrides = {}) => {
    const fixture = retainedFixture();
    return { ...fixture.entry, workflow_run: { ...fixture.entry.workflow_run, ...overrides } };
  };
  assert.equal(lifecycleArtifactBinding(run()).bound, true);
  // A PR or another workflow's artifact is ignored, never authoritative.
  assert.deepEqual(lifecycleArtifactBinding(run({ head_branch: 'issue/217-reconcile' })), { bound: false, reason: 'branch' });
  // The artifact name must name the run the API reports.
  const fixture = retainedFixture();
  assert.deepEqual(lifecycleArtifactBinding({ ...fixture.entry, workflow_run: { ...fixture.entry.workflow_run, id: 999 } }), { bound: false, reason: 'run-id' });
  // A foreign repository cannot be bound either.
  assert.deepEqual(lifecycleArtifactBinding(run({ repository_id: 1 })), { bound: false, reason: 'repository' });
  assert.deepEqual(lifecycleArtifactBinding(run({ head_repository_id: 1 })), { bound: false, reason: 'repository' });
  assert.deepEqual(lifecycleArtifactBinding(run({ head_sha: 'not-a-sha' })), { bound: false, reason: 'head-sha' });
  assert.deepEqual(lifecycleArtifactBinding({ ...fixture.entry, workflow_run: undefined }), { bound: false, reason: 'run' });

  // The cached run lookup must show the protected workflow dispatch at the artifact's head. A
  // readable mismatch is a verdict, not an exception: the artifact is ignored and counted later.
  assert.deepEqual(lifecycleWorkflowRunBinding(fixture.run, HEAD_SHA), { bound: true });
  for (const [patch, reason] of [
    [{ path: '.github/workflows/other.yml' }, 'path'],
    [{ event: 'schedule' }, 'event'],
    [{ head_branch: 'release' }, 'branch'],
    [{ head_sha: 'c'.repeat(40) }, 'head-sha'],
  ]) assert.deepEqual(lifecycleWorkflowRunBinding({ ...fixture.run, ...patch }, HEAD_SHA), { bound: false, reason }, reason);
  assert.deepEqual(lifecycleWorkflowRunBinding(undefined, HEAD_SHA), { bound: false, reason: 'run' });
});

test('a manifest must name the artifact run and attempt, and a historical status reads as retained', () => {
  const artifact = { runId: 123, attempt: 1 };
  const manifest = (runScope, accounts = []) => Buffer.from(JSON.stringify({ version: 1, runScope, accounts }));
  assert.doesNotThrow(() => readManifest(manifest('123-1-0123456789abcdef'), artifact));
  // A forged or corrupted manifest cannot make one run's artifact authoritative for another's.
  assert.throws(() => readManifest(manifest('124-1-0123456789abcdef'), artifact), /does not name the artifact's run and attempt/);
  assert.throws(() => readManifest(manifest('123-2-0123456789abcdef'), artifact), /does not name the artifact's run and attempt/);
  assert.throws(() => readManifest(Buffer.from('{"version":2,"runScope":"123-1-0123456789abcdef","accounts":[]}'), artifact), /bounded run scope/);
  assert.throws(() => readManifest(Buffer.from('not-json'), artifact));

  assert.equal(normalizeAccountStatus('quarantined'), 'retained');
  assert.equal(normalizeAccountStatus('retained'), 'retained');
  assert.equal(normalizeAccountStatus('deleted'), 'deleted');
  assert.equal(normalizeAccountStatus('unknown'), undefined);
});

test('a historical quarantined record is read as retained, keeps its reason, and is anchored to its own createdAt', () => {
  const legacy = manifestFixture(123, 1, [{
    email: scoped(0, '123-1-0123456789abcdef'), mode: 'worker', status: 'quarantined', subject: subject(),
    createdAt: new Date(NOW - 3 * DAY).toISOString(), updatedAt: new Date(NOW - 3 * DAY + 60_000).toISOString(),
    reason: 'teardown: identity is still present',
  }]);
  const identities = manifestIdentities([legacy]);
  assert.equal(identities.length, 1);
  assert.equal(identities[0].status, 'retained');
  assert.equal(identities[0].retainedReason, 'teardown: identity is still present');
  // No stored bound on a historical record: the bound starts at its creating run, not at the
  // retention write (the historical record's last write is a minute later).
  assert.equal(identities[0].boundAt, Date.parse(new Date(NOW - 3 * DAY).toISOString()) + DAY);
  assert.deepEqual(identities[0].origin, { kind: 'manifest', run: 123, attempt: 1 });
  assert.throws(() => manifestIdentities([manifestFixture(123, 1, [manifestRecord({ status: 'exploded' })])]), /unknown account state/);
});

test('the latest manifest record for an address wins, and a deleted one removes it from the set', () => {
  const older = manifestFixture(123, 1, [manifestRecord({ status: 'retained', retainedReason: 'older' })]);
  const newer = manifestFixture(124, 1, [manifestRecord({ status: 'deleted', updatedAt: new Date(NOW - DAY).toISOString() })]);
  assert.deepEqual(manifestIdentities([older, newer]), []);

  const retainedAgain = manifestFixture(125, 1, [manifestRecord({
    status: 'retained', retainedReason: 'newer', updatedAt: new Date(NOW - 60_000).toISOString(),
  })]);
  const identities = manifestIdentities([older, newer, retainedAgain]);
  assert.equal(identities.length, 1);
  assert.equal(identities[0].retainedReason, 'newer');
  assert.deepEqual(identities[0].origin, { kind: 'manifest', run: 125, attempt: 1 });
});

test('CloudTrail creations are attributed by caller, window, pool and the run-scoped session', () => {
  const window = reconcileWindow(NOW);
  const events = [
    creation(stable(0), { eventId: 'event-a' }),
    // A creation by a principal that is not the qualification role is reported, never deleted.
    creation(stable(1), { eventId: 'event-b', caller: 'arn:aws:sts::650880818323:assumed-role/some-other-role/session' }),
    // Not a Beta pool address: reported as a warning, never an identity.
    creation('someone@example.com', { eventId: 'event-c' }),
    // Outside the window.
    creation(stable(2), { eventId: 'event-d', eventTime: new Date(NOW - 8 * DAY).toISOString() }),
    // Another user pool.
    creation(stable(3), { eventId: 'event-e', userPoolId: 'ap-east-1_other' }),
  ];
  const parsed = parseCreateUserEvents(events, window, { userPoolId: 'ap-east-1_beta' });
  assert.deepEqual(parsed.created.map((entry) => entry.eventId), ['event-a']);
  assert.deepEqual(parsed.unattributable.map((entry) => entry.eventId), ['event-b']);
  assert.equal(parsed.unattributable[0].caller, 'arn:aws:sts::650880818323:assumed-role/some-other-role/session');
  // A creation whose address is outside the families is reported, never silently dropped.
  assert.deepEqual(parsed.warnings.map((entry) => entry.eventId), ['event-c']);

  // The creating run comes from the credential session the protected steps assume.
  const sessionCaller = qualificationRole('e2e-123456789-7');
  assert.deepEqual(qualificationSession(sessionCaller), { run: 123456789, attempt: 7 });
  assert.equal(qualificationSession(qualificationRole('awsexample')), undefined);
  assert.equal(qualificationSession('arn:aws:sts::650880818323:assumed-role/other/e2e-1-1'), undefined);
  const attributed = parseCreateUserEvents([creation(stable(4), { caller: sessionCaller, eventId: 'event-f' })], window);
  assert.deepEqual([attributed.created[0].run, attributed.created[0].attempt], [123456789, 7]);
  // A creation recorded before run-scoped sessions carries no run and is still attributable.
  const legacy = parseCreateUserEvents([
    creation(stable(5), { caller: qualificationRole('awsexample'), eventId: 'event-g' }),
  ], window);
  assert.equal(legacy.created[0].run, undefined);

  // A CLI that renders the timestamp as epoch seconds is normalized, not dropped.
  const epoch = parseCreateUserEvents([{ EventId: 'event-h', EventTime: (NOW - DAY) / 1000, CloudTrailEvent: JSON.stringify({
    eventName: 'AdminCreateUser', userIdentity: { arn: qualificationRole() }, requestParameters: { username: stable(6) },
  }) }], window);
  assert.deepEqual(epoch.created.map((entry) => entry.eventTime), [new Date(NOW - DAY).toISOString()]);
  // The CLI's own `EventTime` is an offset instant; it is accepted and normalized to UTC.
  const offset = parseCreateUserEvents([{ EventId: 'event-offset', EventTime: '2026-10-22T02:02:12+00:00', CloudTrailEvent: JSON.stringify({
    eventName: 'AdminCreateUser', userIdentity: { arn: qualificationRole() }, requestParameters: { username: stable(6) },
  }) }], window);
  assert.deepEqual(offset.created.map((entry) => entry.eventTime), ['2026-10-22T02:02:12.000Z']);
  assert.throws(() => parseCreateUserEvents({}, window), /event array/);
});

test('an identity set proves ownership by the captured subject or by the qualification-role creation', () => {
  const window = reconcileWindow(NOW);
  // A captured subject alone is the proof.
  const subjectOnly = buildIdentitySet({
    manifests: [manifestFixture(123, 1, [manifestRecord({ subject: subject(1) })])], events: [], window,
  });
  assert.deepEqual(subjectOnly.identities.map((identity) => identity.email), [stable(0)]);
  assert.deepEqual(subjectOnly.identities[0].origin, { kind: 'manifest', run: 123, attempt: 1 });
  assert.equal(subjectOnly.identities[0].subject, subject(1));

  // A qualification-role creation for the exact address is the proof when the manifest lost it.
  const creationProven = buildIdentitySet({
    manifests: [manifestFixture(123, 1, [manifestRecord({ subject: undefined })])],
    events: [creation(stable(0), { eventId: 'own-creation', eventTime: new Date(NOW - 2 * DAY + 30_000).toISOString() })],
    window,
  });
  assert.deepEqual(creationProven.identities.map((identity) => identity.email), [stable(0)]);
  assert.equal(creationProven.identities[0].origin.kind, 'cloudtrail');
  assert.equal(creationProven.identities[0].origin.run, 123456789);
  assert.equal(creationProven.identities[0].subject, undefined, 'the live subject is read back');

  // Neither proof: reported, never deleted.
  const unprovable = buildIdentitySet({ manifests: [manifestFixture(123, 1, [manifestRecord({ subject: undefined })])], events: [], window });
  assert.deepEqual(unprovable.identities, []);
  assert.deepEqual(unprovable.unresolved.map((entry) => [entry.email, entry.reason]), [[stable(0), 'unprovable_ownership']]);

  // A scoped historical address carries its own scope and stays reconcilable without a subject.
  const scopedRecord = buildIdentitySet({
    manifests: [manifestFixture(123, 1, [manifestRecord({ email: scoped(0, '123-1-0123456789abcdef'), subject: undefined })])],
    events: [], window,
  });
  assert.deepEqual(scopedRecord.identities.map((identity) => identity.email), [scoped(0, '123-1-0123456789abcdef')]);
});

test('a creation with no manifest names its run and derives its cleanup scope from it', () => {
  const window = reconcileWindow(NOW);
  const created = buildIdentitySet({
    manifests: [], window,
    events: [creation(stable(1), { eventId: 'orphan', caller: qualificationRole('e2e-456-2'), eventTime: new Date(NOW - DAY).toISOString() })],
  });
  assert.equal(created.identities.length, 1);
  assert.deepEqual(created.identities[0].origin, {
    kind: 'cloudtrail', event_id: 'orphan', event_time: new Date(NOW - DAY).toISOString(), run: 456, attempt: 2,
  });
  assert.match(created.identities[0].runScope, /^456-2-[a-f0-9]{16}$/);
  assert.equal(created.identities[0].runScope, creationRunScope({ email: stable(1), eventId: 'orphan', eventTime: new Date(NOW - DAY).toISOString(), run: 456, attempt: 2 }));

  // Before run-scoped sessions there is no run to name; the scope states the creation instead.
  const legacy = buildIdentitySet({
    manifests: [], window,
    events: [creation(stable(2), { eventId: 'legacy', caller: qualificationRole('awsexample'), eventTime: new Date(NOW - DAY).toISOString() })],
  });
  assert.equal(legacy.identities[0].origin.run, undefined);
  assert.match(legacy.identities[0].runScope, /^[1-9][0-9]{9}-1-[a-f0-9]{16}$/);

  // A scoped historical creation keeps the scope its own address embeds.
  const scopedCreation = buildIdentitySet({
    manifests: [], window,
    events: [creation(scoped(1, '777-1-0123456789abcdef'), { eventId: 'scoped', caller: qualificationRole('awsexample'), eventTime: new Date(NOW - DAY).toISOString() })],
  });
  assert.equal(scopedCreation.identities[0].runScope, '777-1-0123456789abcdef');
});

test('a newer creation displaces the older manifest record for the same address', () => {
  const window = reconcileWindow(NOW);
  const displaced = buildIdentitySet({
    manifests: [manifestFixture(123, 1, [manifestRecord({ subject: subject(1) })])],
    events: [creation(stable(0), { eventId: 'later', caller: qualificationRole('e2e-777-1'), eventTime: new Date(NOW - DAY).toISOString() })],
    window,
  });
  assert.equal(displaced.identities.length, 1);
  // The newer creation proves the prior identity was absent, so the stale subject is dropped
  // and the live one is read back from the identity the address now holds.
  assert.equal(displaced.identities[0].subject, undefined);
  assert.deepEqual(displaced.identities[0].origin.run, 777);
  assert.equal(displaced.identities[0].origin.kind, 'cloudtrail');
  assert.match(displaced.identities[0].runScope, /^777-1-[a-f0-9]{16}$/);

  // A foreign newer creation displaces the record too, and is reported rather than deleted:
  // the reconciler has no ownership proof for an identity another principal created.
  const foreign = buildIdentitySet({
    manifests: [manifestFixture(123, 1, [manifestRecord({ subject: subject(1) })])],
    events: [creation(stable(0), { eventId: 'foreign', caller: 'arn:aws:sts::650880818323:assumed-role/other/session', eventTime: new Date(NOW - DAY).toISOString() })],
    window,
  });
  assert.deepEqual(foreign.identities, []);
  assert.deepEqual(foreign.unresolved.map((entry) => entry.reason), ['unattributable_caller']);
});

test('a manifest record outside the Beta worker families is reported as outside_worker_family', () => {
  const window = reconcileWindow(NOW);
  const fixture = manifestFixture(123, 1, [
    manifestRecord({ email: 'e2e-functional-account@anywear.local', mode: 'ephemeral' }),
    manifestRecord({ email: 'retired-account@anywear.local', mode: 'worker' }),
    manifestRecord({ email: stable(0), subject: subject(1) }),
  ]);
  const { identities, unresolved } = buildIdentitySet({ manifests: [fixture], events: [], window });
  assert.deepEqual(identities.map((identity) => identity.email), [stable(0)]);
  assert.deepEqual(unresolved.map((entry) => [entry.email, entry.reason]), [
    ['e2e-functional-account@anywear.local', 'outside_worker_family'],
    ['retired-account@anywear.local', 'outside_worker_family'],
  ]);
});

test('the pre-mutation contract check states every address the record will carry', () => {
  const window = reconcileWindow(NOW);
  const identity = {
    email: stable(0), subject: subject(), origin: { kind: 'manifest', run: 123, attempt: 1 },
    actions: { service_cleanup: 'not_required', cognito: 'not_attempted', objects: 'not_required', readback: 'not_attempted' },
    outcome: 'retained',
  };
  assert.doesNotThrow(() => assertIdentitySetWithinContract({
    reconcileId: '900-1', window, identities: [{ email: stable(0), subject: subject(), origin: identity.origin }],
    unresolved: [{ email: 'e2e-functional-account@anywear.local', reason: 'outside_worker_family', origin: { kind: 'manifest', run: 1, attempt: 1 } }],
  }));
  // A worker-family reason may not carry an address outside the families.
  assert.throws(() => assertIdentitySetWithinContract({
    reconcileId: '900-1', window, identities: [],
    unresolved: [{ email: 'e2e-functional-account@anywear.local', reason: 'unprovable_ownership', origin: { kind: 'manifest', run: 1, attempt: 1 } }],
  }), /outside the captured Beta worker families/);
  // The three reported reasons are the only ones that may state a bounded non-worker address.
  assert.deepEqual([...REPORTED_REASONS].sort(), ['outside_worker_family', 'unattributable_caller', 'unprovable_ownership']);
  for (const reason of ['unattributable_caller', 'unprovable_ownership']) {
    assert.throws(() => assertIdentitySetWithinContract({
      reconcileId: '900-1', window, identities: [],
      unresolved: [{ email: 'e2e-functional-account@anywear.local', reason, origin: { kind: 'manifest', run: 1, attempt: 1 } }],
    }), /outside the captured Beta worker families/);
  }
});

test('cleanup groups keep one exact request per captured scope and admit at most eight users', () => {
  const identities = Array.from({ length: 10 }, (_, index) => ({
    email: scoped(index % 8, '123-1-0123456789abcdef'), runScope: '123-1-0123456789abcdef', boundAt: NOW + index,
  }));
  const groups = cleanupGroups(identities);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.identities.length).sort((a, b) => a - b), [2, 8]);
  assert.equal(RECONCILE_MAX_USERS_PER_REQUEST, 8);
  assert.equal(cleanupRequest('123-1-0123456789abcdef', [{ sub: subject(), email: stable(0) }]),
    JSON.stringify({ runScope: '123-1-0123456789abcdef', users: [{ sub: subject(), email: stable(0) }] }));
  assert.throws(() => cleanupGroups([{ email: stable(0), runScope: 'not-a-scope', boundAt: NOW }]), /run scope is invalid/);
});

test('the object action is proven by the committed counters, never assumed', () => {
  assert.equal(objectAction(committedResult({ objects: 3, objectsMissing: 0 })), 'deleted');
  assert.equal(objectAction(committedResult({ objects: 0, objectsMissing: 4 })), 'absent');
  assert.equal(objectAction(committedResult({ objects: 0, objectsMissing: 0 })), 'none');
  assert.equal(objectAction(committedResult({ objects: undefined })), 'unavailable');
  assert.equal(objectAction(undefined), 'unavailable');
});

test('the run fails only for a leftover past its bound, and never for a reported condition', () => {
  const bounds = new Map([[stable(0), NOW - 1], [stable(1), NOW + DAY]]);
  assert.equal(judgeResult([], NOW, bounds), 'passed');
  assert.equal(judgeResult([{ email: stable(0), reason: 'service_cleanup_refused' }], NOW, bounds), 'failed');
  assert.equal(judgeResult([{ email: stable(0), reason: 'deadline_exceeded' }], NOW, bounds), 'failed');
  assert.equal(judgeResult([{ email: stable(1), reason: 'service_cleanup_refused' }], NOW, bounds), 'passed');
  for (const reason of REPORTED_REASONS) {
    assert.equal(judgeResult([{ email: stable(1), reason }], NOW, bounds), 'passed', reason);
  }
  assert.equal(judgeResult([{ email: stable(9), reason: 'service_cleanup_refused' }], NOW, bounds), 'failed', 'an entry with no bound fails closed');

  // The reported reasons are warnings; everything else is the error that fails the run.
  const annotations = recordAnnotations({
    unresolved: [
      { email: 'e2e-functional-account@anywear.local', reason: 'outside_worker_family', origin: { kind: 'manifest', run: 1, attempt: 1 } },
      { email: stable(2), reason: 'unattributable_caller', caller: 'arn:aws:sts::650880818323:assumed-role/other/session', origin: { kind: 'cloudtrail', event_id: 'e', event_time: new Date(NOW).toISOString() } },
      { email: stable(3), reason: 'service_cleanup_refused', origin: { kind: 'cloudtrail', event_id: 'f', event_time: new Date(NOW).toISOString(), run: 5, attempt: 1 } },
    ],
  });
  assert.equal(annotations.warnings.length, 2);
  assert.equal(annotations.errors.length, 1);
  assert.match(annotations.warnings[0], /^::warning title=Reported E2E leftover condition::/);
  assert.match(annotations.errors[0], /^::error title=Unresolved E2E leftover::.*\(service_cleanup_refused\) from CloudTrail event f at .* \(run 5 attempt 1\)/);
});

test('the record is a closed contract: sources, origins, reasons and actions are bounded', () => {
  const window = reconcileWindow(NOW);
  const identity = {
    email: stable(0), subject: subject(), origin: { kind: 'manifest', run: 123, attempt: 1 },
    actions: { service_cleanup: 'committed', cognito: 'deleted', objects: 'deleted', readback: 'absent' },
    outcome: 'reconciled',
  };
  const base = { reconcileId: '900-1', window, sources: { artifacts: 1, artifacts_ignored: 0, cloudtrail_events: 0 }, identities: [identity], unresolved: [], result: 'passed' };
  const record = buildReconcileRecord(base);
  assert.equal(validateReconcileRecord(record), record);
  assert.deepEqual(Object.keys(record.sources).sort(), ['artifacts', 'artifacts_ignored', 'cloudtrail_events']);

  assert.throws(() => validateReconcileRecord({ ...record, extra: 1 }), /unknown or missing member/);
  assert.throws(() => validateReconcileRecord({ ...record, sources: { artifacts: 1, cloudtrail_events: 0 } }), /unknown or missing member/);
  assert.throws(() => validateReconcileRecord({ ...record, identities: [{ ...identity, actions: { ...identity.actions, objects: 'assumed' } }] }), /outside the closed set/);
  assert.throws(() => validateReconcileRecord({ ...record, identities: [{ ...identity, outcome: 'quarantined' }] }), /outside the closed set/);
  assert.throws(() => validateReconcileRecord({ ...record, identities: [{ ...identity, origin: { kind: 'console' } }] }), /not manifest or cloudtrail/);
  assert.throws(() => validateReconcileRecord({ ...record, result: 'failed' }), /failed with no unresolved identity/);
  assert.throws(() => validateReconcileRecord({ ...record, unresolved: [{ email: stable(0), reason: 'made_up', origin: identity.origin }] }), /closed set/);
  assert.throws(() => validateReconcileRecord({ ...record, unresolved: [{ email: stable(0), reason: 'object_cleanup_unproven', origin: identity.origin }] }), /closed set/);
  assert.throws(() => validateReconcileRecord({ ...record, identities: [identity, identity] }), /duplicated/);

  // The cloudtrail origin may name the creation's run and attempt; it may not carry anything else.
  const cloudtrail = { email: stable(1), subject: null, origin: { kind: 'cloudtrail', event_id: 'e', event_time: new Date(NOW).toISOString(), run: 5, attempt: 2 }, actions: identity.actions, outcome: 'reconciled' };
  assert.doesNotThrow(() => validateReconcileRecord({ ...record, identities: [cloudtrail] }));
  assert.throws(() => validateReconcileRecord({
    ...record, identities: [{ ...cloudtrail, origin: { ...cloudtrail.origin, caller: 'x' } }],
  }), /unknown member/);
  // `outside_worker_family` is the only reason that admits a bounded non-worker address.
  assert.doesNotThrow(() => validateReconcileRecord({
    ...record, identities: [], result: 'passed',
    unresolved: [{ email: 'e2e-functional-account@anywear.local', reason: 'outside_worker_family', origin: identity.origin }],
  }));
  assert.doesNotThrow(() => validateReconcileRecord({
    ...record, identities: [], unresolved: [{ email: stable(1), reason: 'unattributable_caller', caller: 'arn', origin: identity.origin }],
  }));
  assert.deepEqual([...UNRESOLVED_REASONS].sort(), [...new Set(UNRESOLVED_REASONS)].sort(), 'the reason set has no duplicate');
});

test('a retained manifest identity is reconciled through the exact cleanup, delete and absence read-back', async () => {
  const harnessed = harness({
    artifacts: [retainedFixture()],
    users: [{ email: stable(0), sub: subject(1) }],
  });
  const { record, result } = await reconcileAccounts({
    io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {},
  });
  assert.equal(result, 'passed');
  assert.equal(record.identities.length, 1);
  assert.deepEqual(record.identities[0], {
    email: stable(0), subject: subject(1), origin: { kind: 'manifest', run: 123, attempt: 1 },
    actions: { service_cleanup: 'committed', cognito: 'deleted', objects: 'deleted', readback: 'absent' },
    outcome: 'reconciled',
  });
  assert.deepEqual(record.unresolved, []);
  assert.deepEqual(record.sources, { artifacts: 1, artifacts_ignored: 0, cloudtrail_events: 0 });
  // The Service request is the exact captured scope and subject, normal mode.
  const serviceCall = harnessed.calls.find((call) => call.service);
  assert.deepEqual(JSON.parse(serviceCall.service.cleanup_json), {
    runScope: '123-1-0123456789abcdef', users: [{ sub: subject(1), email: stable(0) }],
  });
  assert.equal(serviceCall.environment.operation_mode, undefined);
  // Delete used the immutable username the ownership read returned, never the address.
  assert.deepEqual(harnessed.calls.filter((call) => call.delete), [{ delete: `sub-${subject(1).slice(0, 8)}` }]);
});

test('both account manifests in one artifact feed one identity set, and sources counts artifacts', async () => {
  const full = manifestFixture(123, 1, [manifestRecord({ email: stable(0), subject: subject(1) })]);
  const oldest = manifestFixture(123, 1, [manifestRecord({ email: stable(1), subject: subject(2) })]);
  const artifact = artifactFixture(0, {
    runId: 123,
    files: ['account-budget-oldest-client.json', 'account-budget.json', 'service-cleanup-operation.json', 'service-cleanup-run.json'],
    manifest: oldest.manifest,
  });
  artifact.entries[1] = { ...artifact.entries[1], bytes: Buffer.from(JSON.stringify(full.manifest)) };
  const harnessed = harness({ artifacts: [artifact], users: [{ email: stable(0), sub: subject(1) }, { email: stable(1), sub: subject(2) }] });
  const { record } = await reconcileAccounts({ io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {} });
  assert.deepEqual(record.identities.map((identity) => identity.email), [stable(0), stable(1)]);
  // `sources.artifacts` counts the artifact, not the two manifests it carried.
  assert.equal(record.sources.artifacts, 1);
  assert.equal(harnessed.calls.filter((call) => call.service).length, 1);
});

test('a creation-only identity whose manifest was never uploaded is reconciled from its creation', async () => {
  const harnessed = harness({
    artifacts: [],
    events: [creation(stable(1), { eventId: 'orphan-event', caller: qualificationRole('e2e-321-1'), eventTime: new Date(NOW - DAY).toISOString() })],
    users: [{ email: stable(1), sub: subject(2) }],
  });
  const { record } = await reconcileAccounts({ io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {} });
  assert.equal(record.identities.length, 1);
  assert.deepEqual(record.identities[0].origin, {
    kind: 'cloudtrail', event_id: 'orphan-event', event_time: new Date(NOW - DAY).toISOString(), run: 321, attempt: 1,
  });
  assert.equal(record.identities[0].subject, subject(2), 'the live sub is read back from Cognito');
  assert.equal(record.identities[0].outcome, 'reconciled');
  assert.equal(record.sources.cloudtrail_events, 1);
  // The cleanup scope is derived from the run the creation names, never from the address alone.
  const serviceCall = harnessed.calls.find((call) => call.service);
  const scope = JSON.parse(serviceCall.service.cleanup_json).runScope;
  assert.match(scope, /^321-1-[a-f0-9]{16}$/);
  assert.deepEqual(JSON.parse(serviceCall.service.cleanup_json).users, [{ sub: subject(2), email: stable(1) }]);
});

test('a pre-session creation is cleared by the migration and recorded with the role and the event', async () => {
  const harnessed = harness({
    artifacts: [],
    events: [creation(scoped(2, '321-1-0123456789abcdef'), { eventId: 'legacy-event', caller: qualificationRole('awsexample'), eventTime: new Date(NOW - DAY).toISOString() })],
    users: [{ email: scoped(2, '321-1-0123456789abcdef'), sub: subject(5) }],
  });
  const { record } = await reconcileAccounts({
    io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW, RECONCILE_MIGRATION_WINDOW_DAYS), environment: {},
  });
  assert.deepEqual(record.identities[0].origin, { kind: 'cloudtrail', event_id: 'legacy-event', event_time: new Date(NOW - DAY).toISOString() });
  assert.equal(record.identities[0].outcome, 'reconciled');
  const serviceCall = harnessed.calls.find((call) => call.service);
  assert.deepEqual(JSON.parse(serviceCall.service.cleanup_json), { runScope: '321-1-0123456789abcdef', users: [{ sub: subject(5), email: scoped(2, '321-1-0123456789abcdef') }] });
});

test('a displaced address is deleted from the live identity, not from the stale manifest subject', async () => {
  const harnessed = harness({
    artifacts: [retainedFixture({ accounts: [manifestRecord({ subject: subject(1) })] })],
    events: [creation(stable(0), { eventId: 'later', caller: qualificationRole('e2e-777-1'), eventTime: new Date(NOW - DAY).toISOString() })],
    // The live identity is the later run's, so its subject differs from the captured one.
    users: [{ email: stable(0), sub: subject(8) }],
  });
  const { record } = await reconcileAccounts({ io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {} });
  assert.equal(record.identities[0].outcome, 'reconciled');
  assert.equal(record.identities[0].subject, subject(8));
  assert.equal(record.identities[0].origin.kind, 'cloudtrail');
  const serviceCall = harnessed.calls.find((call) => call.service);
  assert.deepEqual(JSON.parse(serviceCall.service.cleanup_json).users, [{ sub: subject(8), email: stable(0) }]);
});

test('a creation by another role is reported and never deleted', async () => {
  const harnessed = harness({
    artifacts: [retainedFixture({ accounts: [manifestRecord({ email: stable(0), status: 'deleted' })] })],
    events: [creation(stable(2), { eventId: 'foreign', caller: 'arn:aws:sts::650880818323:assumed-role/other/session' })],
    users: [{ email: stable(2), sub: subject(3) }],
  });
  const { record } = await reconcileAccounts({ io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {} });
  assert.equal(record.identities.length, 0);
  assert.deepEqual(record.unresolved.map((entry) => [entry.reason, entry.caller]), [['unattributable_caller', 'arn:aws:sts::650880818323:assumed-role/other/session']]);
  assert.equal(harnessed.calls.some((call) => call.delete), false);
  assert.equal(harnessed.calls.some((call) => call.service), false);
  assert.equal(record.result, 'passed', 'a foreign creation is reported, never a failure');
});

test('a masked creation is attributed through its immutable sub and resolves to its worker address', async () => {
  const harnessed = harness({
    artifacts: [],
    events: [maskedCreation(subject(2), {
      eventId: 'masked-attributed',
      caller: qualificationRole('e2e-4242-3'),
      eventTime: new Date(NOW - DAY).toISOString(),
    })],
    users: [{ email: stable(2), sub: subject(2) }],
  });
  const { record, result, warnings } = await reconcileAccounts({
    io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {},
  });
  assert.equal(result, 'passed');
  assert.deepEqual(warnings, []);
  assert.equal(record.identities.length, 1);
  assert.deepEqual(record.identities[0], {
    email: stable(2),
    subject: subject(2),
    origin: { kind: 'cloudtrail', event_id: 'masked-attributed', event_time: new Date(NOW - DAY).toISOString(), run: 4242, attempt: 3 },
    actions: { service_cleanup: 'committed', cognito: 'deleted', objects: 'deleted', readback: 'absent' },
    outcome: 'reconciled',
  });
  // The masked literal is never an address: the address was read back from the sub.
  assert.equal(JSON.stringify(record).includes(MASKED), false);
  assert.deepEqual(harnessed.calls.filter((call) => call.getUsername).map((call) => call.getUsername), [subject(2)]);
  const serviceCall = harnessed.calls.find((call) => call.service);
  const cleanup = JSON.parse(serviceCall.service.cleanup_json);
  assert.deepEqual(cleanup.users, [{ sub: subject(2), email: stable(2) }]);
  assert.match(cleanup.runScope, /^4242-3-[a-f0-9]{16}$/);
  assert.deepEqual(harnessed.calls.filter((call) => call.delete), [{ delete: `sub-${subject(2).slice(0, 8)}` }]);
});

test('a masked creation recorded before run-scoped sessions is attributed without a run', async () => {
  // The live 2026-10-23 events were recorded with a plain `GitHubActions` session name, so the
  // creation names no run; its cleanup scope is derived from the event and the identity still
  // reconciles.
  const harnessed = harness({
    artifacts: [],
    events: [maskedCreation(subject(7), {
      eventId: 'masked-legacy',
      caller: qualificationRole('GitHubActions'),
      eventTime: new Date(NOW - DAY).toISOString(),
    })],
    users: [{ email: stable(7), sub: subject(7) }],
  });
  const { record } = await reconcileAccounts({
    io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {},
  });
  assert.deepEqual(record.identities[0].origin, {
    kind: 'cloudtrail', event_id: 'masked-legacy', event_time: new Date(NOW - DAY).toISOString(),
  });
  assert.equal(record.identities[0].outcome, 'reconciled');
  assert.equal(record.identities[0].subject, subject(7));
  const scope = JSON.parse(harnessed.calls.find((call) => call.service).service.cleanup_json).runScope;
  assert.match(scope, /^[1-9][0-9]{9}-1-[a-f0-9]{16}$/);
});

test('a masked creation by another principal is reported with its caller and address, never deleted', async () => {
  const foreignCaller = 'arn:aws:sts::650880818323:assumed-role/some-other-role/session';
  const harnessed = harness({
    artifacts: [],
    events: [maskedCreation(subject(3), { eventId: 'masked-foreign', caller: foreignCaller, eventTime: new Date(NOW - DAY).toISOString() })],
    users: [{ email: stable(3), sub: subject(3) }],
  });
  const { record, warnings } = await reconcileAccounts({
    io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {},
  });
  assert.deepEqual(record.identities, []);
  assert.deepEqual(record.unresolved, [{
    email: stable(3),
    reason: 'unattributable_caller',
    caller: foreignCaller,
    origin: { kind: 'cloudtrail', event_id: 'masked-foreign', event_time: new Date(NOW - DAY).toISOString() },
  }]);
  assert.equal(record.result, 'passed', 'a foreign creation is reported, never a failure');
  assert.deepEqual(warnings, []);
  // The caller is checked before any address rule, so the address is resolved and stated.
  assert.deepEqual(harnessed.calls.filter((call) => call.getUsername).map((call) => call.getUsername), [subject(3)]);
  assert.equal(harnessed.calls.some((call) => call.delete), false);
  assert.equal(harnessed.calls.some((call) => call.service), false);
});

test('a masked creation with no usable sub is warned and never dropped or deleted', async () => {
  const noSubTime = new Date(NOW - 2 * DAY).toISOString();
  const goneTime = new Date(NOW - DAY).toISOString();
  const harnessed = harness({
    artifacts: [],
    events: [
      maskedCreation(undefined, { eventId: 'masked-no-sub', eventTime: noSubTime }),
      maskedCreation(subject(9), { eventId: 'masked-gone', eventTime: goneTime }),
    ],
  });
  const { record, result, warnings } = await reconcileAccounts({
    io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {},
  });
  assert.equal(result, 'passed');
  assert.deepEqual(record.identities, []);
  assert.deepEqual(record.unresolved, []);
  assert.equal(record.sources.cloudtrail_events, 2, 'both events were read; neither was dropped from the scan');
  assert.equal(warnings.length, 2);
  // The warning names the event id, its time and the caller, so the operator can find the event.
  assert.match(warnings[0], /^::warning title=Unattributed E2E creation::/);
  assert.match(warnings[0], /masked-no-sub/);
  assert.ok(warnings[0].includes(noSubTime));
  assert.ok(warnings[0].includes(qualificationRole()));
  assert.match(warnings[0], /names no usable username or additionalEventData\.sub/);
  assert.match(warnings[1], /masked-gone/);
  assert.ok(warnings[1].includes(goneTime));
  assert.ok(warnings[1].includes(qualificationRole()));
  assert.ok(warnings[1].includes(subject(9)));
  assert.match(warnings[1], /resolves to no live identity/);
  assert.equal(harnessed.calls.some((call) => call.delete), false);
  assert.equal(harnessed.calls.some((call) => call.service), false);
});

test('a masked creation whose sub resolves outside the worker families is reported, never deleted', async () => {
  const harnessed = harness({
    artifacts: [],
    events: [
      maskedCreation(subject(4), { eventId: 'masked-outside', eventTime: new Date(NOW - DAY).toISOString() }),
      maskedCreation(subject(5), { eventId: 'masked-tester', eventTime: new Date(NOW - 2 * DAY).toISOString() }),
    ],
    users: [
      { email: 'e2e-functional-account@anywear.local', sub: subject(4) },
      { email: 'tester@example.com', sub: subject(5) },
    ],
  });
  const { record, warnings } = await reconcileAccounts({
    io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {},
  });
  assert.deepEqual(record.identities, []);
  // A bounded E2E address outside the families fits the record's one open reason; a real
  // tester address does not fit the closed grammar and is reported as a warning instead.
  assert.deepEqual(record.unresolved.map((entry) => [entry.email, entry.reason]), [
    ['e2e-functional-account@anywear.local', 'outside_worker_family'],
  ]);
  assert.equal(record.result, 'passed');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /masked-tester/);
  assert.match(warnings[0], /tester@example\.com is outside the Beta worker families/);
  assert.equal(harnessed.calls.some((call) => call.delete), false);
  assert.equal(harnessed.calls.some((call) => call.service), false);
});

test('a masked creation whose sub cannot be read fails closed before any mutation', async () => {
  const harnessed = harness({
    artifacts: [],
    events: [maskedCreation(subject(6), { eventId: 'masked-unreadable' })],
  });
  harnessed.io.getUserByUsername = async () => {
    throw Object.assign(new Error('not authorized to perform cognito-idp:AdminGetUser'), { name: 'AccessDeniedException' });
  };
  await assert.rejects(
    reconcileAccounts({ io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {} }),
    /masked-unreadable: username .* could not be read/,
  );
  assert.equal(harnessed.calls.some((call) => call.delete), false);
  assert.equal(harnessed.calls.some((call) => call.service), false);
});

test('the masked AdminCreateUser payload is parsed by its immutable sub, never by its masked username', () => {
  const window = reconcileWindow(NOW);
  const parsed = parseCreateUserEvents([
    maskedCreation(subject(1), { eventId: 'masked-parse', caller: qualificationRole('e2e-55-2') }),
    maskedCreation(subject(6), { eventId: 'masked-legacy-session', caller: qualificationRole('GitHubActions') }),
    maskedCreation(undefined, { eventId: 'masked-no-address' }),
    maskedCreation(subject(2), { eventId: 'masked-foreign', caller: 'arn:aws:sts::650880818323:assumed-role/other/session' }),
    maskedCreation(subject(3), { eventId: 'masked-other-pool', userPoolId: 'ap-east-1_other' }),
    maskedCreation('not-a-sub', { eventId: 'masked-invalid-sub' }),
  ], window, { userPoolId: BETA_POOL_ID });
  assert.deepEqual(parsed.created.map((entry) => [entry.eventId, entry.sub, entry.email, entry.run, entry.attempt]), [
    ['masked-parse', subject(1), undefined, 55, 2],
    // The live pre-session shape (the 2026-10-23 events the pool actually recorded): the
    // qualification role is assumed with a plain session name, so the creation names no run
    // and its scope is derived from the event itself.
    ['masked-legacy-session', subject(6), undefined, undefined, undefined],
  ]);
  assert.deepEqual(parsed.unattributable.map((entry) => [entry.eventId, entry.email, entry.sub]), [
    ['masked-foreign', undefined, subject(2)],
  ]);
  assert.deepEqual(parsed.warnings.map((entry) => entry.eventId), ['masked-no-address', 'masked-invalid-sub']);
  assert.equal(JSON.stringify(parsed).includes(MASKED), false, 'the mask literal never becomes a creation fact');
});

test('an unbound artifact is ignored and counted while a bound one is still read', async () => {
  const bound = retainedFixture();
  const unbound = artifactFixture(1, { runId: 124, headBranch: 'issue/217-reconcile', manifest: manifestFixture(124, 1, [manifestRecord({ email: stable(1), subject: subject(2) })]).manifest });
  const harnessed = harness({ artifacts: [bound, unbound], users: [{ email: stable(0), sub: subject(1) }] });
  const { record } = await reconcileAccounts({ io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {} });
  assert.equal(record.sources.artifacts, 1);
  assert.equal(record.sources.artifacts_ignored, 1);
  assert.deepEqual(record.identities.map((identity) => identity.email), [stable(0)]);
  assert.equal(harnessed.calls.some((call) => call.artifact === unbound.entry.id), false, 'an unbound artifact is never read');
});

test('the artifact read is bounded at nine per lookback day, at both lookback bounds', async () => {
  const diagnostics = (index) => artifactFixture(index, { files: ['service-cleanup-run.json'] });
  // A seven-day window admits 63 artifacts (nine a day) and refuses the sixty-fourth.
  const week = reconcileWindow(NOW);
  const weekBound = maxArtifactsForWindow(week);
  assert.equal(weekBound, 63);
  const small = harness({ artifacts: [] });
  await assert.rejects(reconcileAccounts({
    io: { ...small.io, async listArtifacts() { return Array.from({ length: weekBound + 1 }, (_, index) => diagnostics(index).entry); } },
    now: NOW, runIdentity, window: week, environment: {},
  }), /exceed the reconcile bound/);

  // The 90-day migration dispatch admits the larger bound the artifact retention implies:
  // the same sixty-four artifacts are inside it, and only 811 refuse.
  const migration = reconcileWindow(NOW, RECONCILE_MIGRATION_WINDOW_DAYS);
  assert.equal(maxArtifactsForWindow(migration), 810);
  const migrationHarness = harness({ artifacts: [] });
  const accepted = await reconcileAccounts({
    io: {
      ...migrationHarness.io,
      async listArtifacts() { return Array.from({ length: 64 }, (_, index) => diagnostics(index).entry); },
      async getWorkflowRun() { return { path: '.github/workflows/beta-qualification.yml', event: 'workflow_dispatch', head_branch: 'main', head_sha: HEAD_SHA }; },
      async readArtifact() { return [{ name: 'service-cleanup-run.json', size: 10 }]; },
    },
    now: NOW, runIdentity, window: migration, environment: {},
  });
  assert.equal(accepted.record.sources.artifacts, 64);
  assert.equal(accepted.record.identities.length, 0);
  await assert.rejects(reconcileAccounts({
    io: { ...migrationHarness.io, async listArtifacts() { return Array.from({ length: 811 }, (_, index) => diagnostics(index).entry); } },
    now: NOW, runIdentity, window: migration, environment: {},
  }), /exceed the reconcile bound/);
});

test('a repository with hundreds of unrelated artifacts still reconciles its lifecycle window', async () => {
  // The Beta repository keeps every workflow's artifacts. 703 unrelated rows pushed the old
  // two-page listing budget past its limit even though one artifact belonged to the run; the
  // production listing now walks to the API's last page and applies the bound only to
  // lifecycle-named, in-window rows.
  const lifecycle = retainedFixture();
  const pages = artifactPages([...Array.from({ length: 703 }, (_, index) => unrelatedArtifact(index)), lifecycle.entry]);
  const harnessed = harness({ artifacts: [lifecycle], users: [{ email: stable(0), sub: subject(1) }] });
  const { record } = await reconcileAccounts({
    io: { ...harnessed.io, async listArtifacts(window) { return await collectLifecycleArtifacts({ window, fetchPage: pages }); } },
    now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {},
  });
  assert.equal(record.sources.artifacts, 1);
  assert.equal(record.sources.artifacts_ignored, 0);
  assert.deepEqual(record.identities.map((identity) => [identity.email, identity.outcome]), [[stable(0), 'reconciled']]);
  assert.equal(record.result, 'passed');
});

test('the production listing counts only lifecycle artifacts against the nine-per-day bound', async () => {
  const window = reconcileWindow(NOW);
  const bound = maxArtifactsForWindow(window);
  assert.equal(bound, 63);
  const lifecycle = (count) => Array.from({ length: count }, (_, index) => artifactFixture(index, { files: ['service-cleanup-run.json'] }).entry);
  const unrelated = Array.from({ length: 700 }, (_, index) => unrelatedArtifact(index));
  // Seven hundred unrelated artifacts do not consume one unit of the lifecycle bound.
  const accepted = await collectLifecycleArtifacts({ window, fetchPage: artifactPages([...unrelated, ...lifecycle(bound)]) });
  assert.equal(accepted.length, bound);
  // The sixty-fourth lifecycle artifact is the bound the listing refuses, not the page count.
  await assert.rejects(
    collectLifecycleArtifacts({ window, fetchPage: artifactPages([...unrelated, ...lifecycle(bound + 1)]) }),
    /exceed the reconcile bound/,
  );
});

test('a truncated or unreadable artifact listing fails closed', async () => {
  const window = reconcileWindow(NOW);
  const rows = Array.from({ length: 704 }, (_, index) => unrelatedArtifact(index));
  const pages = artifactPages(rows);
  // An empty page before the API's last page is a truncated scan, not an empty window.
  await assert.rejects(collectLifecycleArtifacts({
    window,
    fetchPage: (page, size) => (page === 2 ? { total_count: rows.length, artifacts: [] } : pages(page, size)),
  }), /truncated/);
  // A short page before the API's last page is truncated too.
  await assert.rejects(collectLifecycleArtifacts({
    window,
    fetchPage: (page, size) => (page === 3 ? { total_count: rows.length, artifacts: rows.slice(0, 1) } : pages(page, size)),
  }), /truncated/);
  // A transport failure or a malformed page aborts the whole listing.
  await assert.rejects(collectLifecycleArtifacts({ window, fetchPage: () => { throw new Error('gh api unavailable'); } }), /gh api unavailable/);
  await assert.rejects(collectLifecycleArtifacts({ window, fetchPage: () => ({ artifacts: [] }) }), /malformed/);
  // A listing that never reaches its last page is refused at the walk bound, never truncated.
  await assert.rejects(collectLifecycleArtifacts({
    window,
    fetchPage: (page, size) => ({ total_count: 100_000, artifacts: Array.from({ length: size }, (_, index) => unrelatedArtifact(index)) }),
  }), /page bound/);
});

test('a lifecycle artifact with a missing or malformed digest is refused before its bytes are read', async () => {
  const window = reconcileWindow(NOW);
  for (const digest of [undefined, null, '', 'sha256:abc', `md5:${'a'.repeat(32)}`, `sha256:${'A'.repeat(64)}`]) {
    const entry = { ...artifactFixture(0).entry, digest };
    await assert.rejects(collectLifecycleArtifacts({ window, fetchPage: artifactPages([entry]) }), /well-formed sha256 digest/, String(digest));
  }
  // The production reader refuses a row that bypassed the listing as well, before any fetch.
  const io = createReconcileIo({ USER_POOL_ID: 'ap-east-1_example' });
  try {
    await assert.rejects(io.readArtifact({ id: 1, digest: undefined }), /well-formed sha256 digest/);
  } finally {
    io.destroy();
  }
});

test('a readable cached run that fails the binding is ignored and counted, never a source failure', async () => {
  for (const [patch, reason] of [
    [{ path: '.github/workflows/other.yml' }, 'path'],
    [{ event: 'schedule' }, 'event'],
    [{ head_branch: 'release' }, 'branch'],
    [{ head_sha: 'c'.repeat(40) }, 'head-sha'],
  ]) {
    const artifact = retainedFixture();
    const harnessed = harness({ artifacts: [artifact], users: [{ email: stable(0), sub: subject(1) }] });
    const io = { ...harnessed.io, async getWorkflowRun() { return { ...artifact.run, ...patch }; } };
    const { record } = await reconcileAccounts({ io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {} });
    assert.equal(record.sources.artifacts, 0, reason);
    assert.equal(record.sources.artifacts_ignored, 1, reason);
    assert.deepEqual(record.identities, [], reason);
    assert.equal(record.result, 'passed', reason);
    assert.equal(harnessed.calls.some((call) => call.get || call.service || call.delete), false, `${reason}: nothing is read or mutated`);
  }
  // A lookup the transport cannot answer is a source failure: the binding cannot be decided.
  const bound = harness({ artifacts: [retainedFixture()], users: [{ email: stable(0), sub: subject(1) }] });
  await assert.rejects(reconcileAccounts({
    io: { ...bound.io, async getWorkflowRun() { return undefined; } },
    now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {},
  }), /workflow run is unavailable/);
  assert.equal(bound.calls.some((call) => call.service || call.delete), false);
});

test('the reconcile threads the absolute in-job deadline into every cleanup wait', async () => {
  const harnessed = harness({ artifacts: [retainedFixture()], users: [{ email: stable(0), sub: subject(1) }] });
  const startedAt = Date.now();
  await reconcileAccounts({ io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {}, deadlineMs: 12 * 60_000 });
  const call = harnessed.calls.find((entry) => entry.service);
  // The cleanup wait expects `{ deadline }`; a leftover `remainingMs` would leave it unbounded.
  assert.equal(call.options.remainingMs, undefined);
  assert.equal(typeof call.options.deadline, 'number');
  assert.ok(call.options.deadline >= startedAt + 12 * 60_000 - 1_000);
  assert.ok(call.options.deadline <= Date.now() + 12 * 60_000 + 1_000);
});

test('the migration allowance reaches the cleanup only from the 90-day reconcile lookback', async () => {
  // The allowance follows the recorded window, which is the closed lookback set. An ordinary
  // reconcile leaves the key absent, so the cleanup keeps its unchanged two-name rule.
  for (const [environment, expected] of [[{}, false], [{ E2E_ACCOUNT_RECONCILE_LOOKBACK_DAYS: '7' }, false],
    [{ E2E_ACCOUNT_RECONCILE_LOOKBACK_DAYS: '90' }, true]]) {
    const harnessed = harness({ artifacts: [retainedFixture()], users: [{ email: stable(0), sub: subject(1) }] });
    await reconcileAccounts({ io: harnessed.io, now: NOW, runIdentity, environment });
    const call = harnessed.calls.find((entry) => entry.service);
    assert.equal(Object.hasOwn(call.options, 'migrationGeneration'), expected, JSON.stringify(environment));
    assert.equal(call.options.migrationGeneration, expected ? true : undefined, JSON.stringify(environment));
    assert.equal(typeof call.options.deadline, 'number');
  }
  // The same allowance follows the migration window when the caller passes it directly: the
  // dispatch input and the recorded window cannot disagree.
  const harnessed = harness({ artifacts: [retainedFixture()], users: [{ email: stable(0), sub: subject(1) }] });
  await reconcileAccounts({
    io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW, RECONCILE_MIGRATION_WINDOW_DAYS), environment: {},
  });
  assert.equal(harnessed.calls.find((entry) => entry.service).options.migrationGeneration, true);
});

test('the migration allowance is derived from the recorded window and no other caller can request it', () => {
  // Every qualification teardown and `full`/`smoke` cleanup shares the same
  // `runCleanupOperation` entry without an options object: none of them can mint the
  // migration generation, and the protected entry exposes no input that selects it.
  const teardown = readFileSync(new URL('./cleanup-worker-accounts.mjs', import.meta.url), 'utf8');
  assert.equal(teardown.includes('migrationGeneration'), false);
  const workflow = readFileSync(new URL('../.github/workflows/beta-qualification.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /migration_generation|MIGRATION_GENERATION/);
  const reconcile = readFileSync(new URL('./reconcile-accounts.mjs', import.meta.url), 'utf8');
  assert.match(reconcile, /lookbackDaysOfWindow\(window\) === RECONCILE_MIGRATION_WINDOW_DAYS/);
});

test('the production cleanup wrapper passes the absolute deadline to the real cleanup wait', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-reconcile-deadline-'));
  const cleanupIo = {
    async describe() { throw Object.assign(new Error('Execution does not exist'), { name: 'ExecutionDoesNotExist' }); },
    async start() { return {}; },
    async aws() { return {}; },
    async sleep() {},
  };
  const io = createReconcileIo({ USER_POOL_ID: 'ap-east-1_example' }, { cleanupIo });
  const cleanupEnvironment = {
    E2E_CLEANUP_SERVICE_SHA: 'a'.repeat(40),
    E2E_CLEANUP_SERVICE_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
    BETA_CLEANUP_STATE_MACHINE_VERSION_ARN: 'arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup:7',
    E2E_SERVICE_CLEANUP_EVIDENCE_PATH: join(directory, 'service-cleanup-operation.json'),
  };
  const inputs = { action: 'cleanup', emails: '[]', cleanup_json: JSON.stringify({
    runScope: '123-1-0123456789abcdef', users: [{ sub: subject(1), email: stable(0) }],
  }) };
  try {
    // A call site that forgot the deadline would let the wait outlive the job; it fails closed.
    await assert.rejects(io.runServiceCleanup(inputs, cleanupEnvironment), /absolute deadline/);
    // The deadline the reconcile computes is absolute, and the real cleanup wait reads it: if
    // either side drifted back to `remainingMs`, the wait would poll instead of stopping.
    await assert.rejects(
      io.runServiceCleanup(inputs, cleanupEnvironment, { deadline: Date.now() - 1 }),
      (error) => error instanceof Error && error.name === 'CleanupDeadlineExceeded',
    );
  } finally {
    io.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an identity already absent with no captured subject is already absent, without a cleanup request', async () => {
  const harnessed = harness({
    artifacts: [],
    events: [creation(stable(1), { eventId: 'gone', eventTime: new Date(NOW - DAY).toISOString() })],
    users: [],
  });
  const { record } = await reconcileAccounts({ io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {} });
  assert.deepEqual(record.identities.map((identity) => [identity.outcome, identity.actions.cognito, identity.actions.service_cleanup]), [['already_absent', 'already_absent', 'not_required']]);
  assert.equal(harnessed.calls.some((call) => call.service), false);
});

test('an absent identity with a captured subject still replays the cleanup that owes rows and objects', async () => {
  const harnessed = harness({ artifacts: [retainedFixture()], users: [] });
  const { record } = await reconcileAccounts({ io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {} });
  assert.equal(harnessed.calls.filter((call) => call.service).length, 1);
  assert.deepEqual(record.identities[0].actions, { service_cleanup: 'committed', cognito: 'already_absent', objects: 'deleted', readback: 'absent' });
  assert.equal(record.identities[0].outcome, 'already_absent');
});

test('a refused Service cleanup retains the identity, and a past-bound refusal fails the run', async () => {
  const withinBound = harness({
    artifacts: [retainedFixture({ accounts: [manifestRecord({ subject: subject(1), reconcileBy: new Date(NOW + DAY).toISOString() })] })],
    users: [{ email: stable(0), sub: subject(1) }],
    cleanup: async () => { throw new Error('service cleanup refused'); },
  });
  const passed = await reconcileAccounts({ io: withinBound.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {} });
  assert.equal(passed.record.result, 'passed', 'a retry inside the bound is the ordinary path');
  assert.deepEqual(passed.record.unresolved.map((entry) => entry.reason), ['service_cleanup_refused']);
  assert.deepEqual(passed.record.identities[0].actions, { service_cleanup: 'refused', cognito: 'not_attempted', objects: 'unavailable', readback: 'not_attempted' });

  const pastBound = harness({
    artifacts: [retainedFixture({
      accounts: [manifestRecord({ email: stable(0), subject: subject(1), createdAt: new Date(NOW - 3 * DAY).toISOString(), updatedAt: new Date(NOW - 3 * DAY).toISOString(), reconcileBy: new Date(NOW - 2 * DAY).toISOString() })],
      runId: 200,
    })],
    users: [{ email: stable(0), sub: subject(1) }],
    cleanup: async () => { throw new Error('service cleanup refused'); },
  });
  const failed = await reconcileAccounts({ io: pastBound.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {} });
  assert.equal(failed.record.result, 'failed');
});

test('a committed result without object counters is a Service refusal, and nothing is deleted', async () => {
  const harnessed = harness({
    artifacts: [retainedFixture()],
    users: [{ email: stable(0), sub: subject(1) }],
    cleanup: async () => ({ proof_status: 'verified', committed_result: committedResult({ objects: undefined, objectsMissing: undefined }) }),
  });
  const { record } = await reconcileAccounts({ io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {} });
  assert.deepEqual(record.unresolved.map((entry) => entry.reason), ['service_cleanup_refused']);
  assert.equal(record.identities[0].actions.objects, 'unavailable');
  assert.equal(record.identities[0].actions.cognito, 'not_attempted');
  assert.equal(harnessed.calls.some((call) => call.delete), false);
});

test('a subject mismatch refuses the identity instead of deleting a foreign one', async () => {
  const harnessed = harness({ artifacts: [retainedFixture()], users: [{ email: stable(0), sub: subject(9) }] });
  const { record } = await reconcileAccounts({ io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {} });
  assert.deepEqual(record.unresolved.map((entry) => entry.reason), ['subject_mismatch']);
  assert.equal(harnessed.calls.some((call) => call.delete), false);
  assert.equal(harnessed.calls.some((call) => call.service), false);
});

test('an invalid deadline refuses rather than disabling the bound', async () => {
  const harnessed = harness({ artifacts: [retainedFixture()], users: [] });
  for (const deadlineMs of [Number('not-a-number'), 0, -1_000, Number.POSITIVE_INFINITY]) {
    await assert.rejects(reconcileAccounts({
      io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {}, deadlineMs,
    }), /positive number of milliseconds/, String(deadlineMs));
  }
  assert.equal(harnessed.calls.some((call) => call.get || call.service || call.delete), false);
});

test('a deadline that has already passed records the leftover and starts no cleanup', async () => {
  // A zero-but-positive deadline is the honest way to model an exhausted budget without a
  // NaN; the check is the same in-job deadline the group loop uses.
  const harnessed = harness({ artifacts: [retainedFixture()], users: [{ email: stable(0), sub: subject(1) }] });
  const { record } = await reconcileAccounts({
    io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {}, deadlineMs: Number.MIN_VALUE,
  });
  assert.deepEqual(record.unresolved.map((entry) => entry.reason), ['deadline_exceeded']);
  assert.equal(harnessed.calls.some((call) => call.service), false);
  assert.equal(harnessed.calls.some((call) => call.delete), false);
  assert.equal(record.result, 'failed');
});

test('a cleanup wait that reaches the deadline is recorded and the record is still written', async () => {
  const harnessed = harness({
    artifacts: [retainedFixture()],
    users: [{ email: stable(0), sub: subject(1) }],
    cleanup: async () => {
      throw Object.assign(new Error('Cleanup wait reached the in-job deadline'), { name: 'CleanupDeadlineExceeded' });
    },
  });
  const { record } = await reconcileAccounts({
    io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {}, deadlineMs: 12 * 60_000,
  });
  assert.deepEqual(record.unresolved.map((entry) => entry.reason), ['deadline_exceeded']);
  assert.deepEqual(record.identities[0].actions, { service_cleanup: 'unavailable', cognito: 'not_attempted', objects: 'unavailable', readback: 'not_attempted' });
  assert.equal(record.identities[0].outcome, 'retained');
  assert.equal(record.result, 'failed');
  // The record is written even though the wait stopped: that is what the deadline exists for.
  assert.equal(validateReconcileRecord(record), record);
});

test('an empty lookback is a valid scan, not a refusal', async () => {
  // The design's own crash case: a run whose manifest was never uploaded. When it is the only
  // run in the lookback there is no artifact at all, so the identity set has to come from
  // CloudTrail alone — otherwise the creation could never be cleared (#217).
  const harnessed = harness({
    artifacts: [],
    events: [creation(scoped(1, '321-1-0123456789abcdef'), { eventId: 'only-event', eventTime: new Date(NOW - DAY).toISOString() })],
    users: [{ email: scoped(1, '321-1-0123456789abcdef'), sub: subject(4) }],
  });
  const empty = await reconcileAccounts({
    io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {},
  });
  assert.equal(empty.record.sources.artifacts, 0);
  assert.equal(empty.record.identities.length, 1);
  assert.deepEqual(empty.record.identities[0].origin, {
    kind: 'cloudtrail', event_id: 'only-event', event_time: new Date(NOW - DAY).toISOString(), run: 123456789, attempt: 1,
  });
  assert.equal(empty.record.identities[0].outcome, 'reconciled');
  assert.equal(empty.record.result, 'passed');

  // Nothing to reconcile at all: a passed no-op record that still states the empty scan.
  const quiet = harness({ artifacts: [], events: [], users: [] });
  const noop = await reconcileAccounts({
    io: quiet.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {},
  });
  assert.equal(noop.record.sources.artifacts, 0);
  assert.equal(noop.record.sources.cloudtrail_events, 0);
  assert.deepEqual(noop.record.identities, []);
  assert.deepEqual(noop.record.unresolved, []);
  assert.equal(noop.record.result, 'passed');
  assert.equal(quiet.calls.some((call) => call.service || call.delete), false);
});

test('a source failure writes no record, mutates nothing and exits non-zero', async () => {
  const bound = harness({ artifacts: [retainedFixture()], users: [{ email: stable(0), sub: subject(1) }] });
  // An unreadable artifact list (transport/API failure, not an empty window).
  await assert.rejects(reconcileAccounts({
    io: { ...bound.io, listArtifacts: async () => { throw new Error('artifact list unavailable'); } },
    now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {},
  }), /artifact list unavailable/);
  // Unreadable CloudTrail.
  await assert.rejects(reconcileAccounts({
    io: { ...bound.io, lookupCreateUserEvents: async () => { throw new Error('CloudTrail unavailable'); } },
    now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {},
  }), /CloudTrail unavailable/);
  // A bound artifact whose bytes fail their digest or archive checks.
  await assert.rejects(reconcileAccounts({
    io: { ...bound.io, async readArtifact() { throw new Error('Lifecycle artifact digest does not match its bytes'); } },
    now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {},
  }), /digest does not match/);
  // A workflow run that cannot be read is a source failure too: the binding cannot be decided.
  await assert.rejects(reconcileAccounts({
    io: { ...bound.io, async getWorkflowRun() { throw new Error('workflow run unavailable'); } },
    now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {},
  }), /workflow run unavailable/);
  // A manifest whose runScope names another run and attempt is a contract violation, not a
  // stale record: nothing is deleted from it and no record is written.
  const mismatched = artifactFixture(0, { runId: 123, manifest: { ...manifestFixture(123, 1, [manifestRecord({ subject: subject(1) })]).manifest, runScope: '999-1-0123456789abcdef' } });
  await assert.rejects(reconcileAccounts({
    io: harness({ artifacts: [mismatched], users: [{ email: stable(0), sub: subject(1) }] }).io,
    now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {},
  }), /does not name the artifact's run and attempt/);
  assert.equal(bound.calls.some((call) => call.service || call.delete), false, 'no source failure reaches a mutation');
});

test('no input can throw after a deletion: an unstatable record refuses before the first Service call', async () => {
  // A record whose address the closed contract cannot state (not a Beta address at all) is not
  // a reported condition and not a worker identity. It must refuse before any mutation, even
  // though a reconcilable identity sits in the same manifest.
  const bad = manifestFixture(123, 1, [
    manifestRecord({ email: stable(0), subject: subject(1) }),
    manifestRecord({ email: 'not-an-e2e-address@example.com', mode: 'worker' }),
  ]);
  const harnessed = harness({
    artifacts: [artifactFixture(0, { runId: 123, manifest: bad.manifest })],
    users: [{ email: stable(0), sub: subject(1) }],
  });
  await assert.rejects(reconcileAccounts({
    io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {},
  }), /outside the captured Beta worker families/);
  assert.equal(harnessed.calls.some((call) => call.get || call.service || call.delete), false, 'validation precedes every mutation');
});

test('a non-worker record beside a reconcilable identity is reported, and the record is still written', async () => {
  const fixture = manifestFixture(123, 1, [
    manifestRecord({ email: 'e2e-functional-account@anywear.local', mode: 'ephemeral' }),
    manifestRecord({ email: stable(0), subject: subject(1) }),
  ]);
  const harnessed = harness({
    artifacts: [artifactFixture(0, { runId: 123, manifest: fixture.manifest })],
    users: [{ email: stable(0), sub: subject(1) }],
  });
  const { record } = await reconcileAccounts({ io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {} });
  assert.deepEqual(record.unresolved.map((entry) => [entry.email, entry.reason]), [['e2e-functional-account@anywear.local', 'outside_worker_family']]);
  assert.equal(record.identities[0].outcome, 'reconciled');
  assert.equal(record.result, 'passed', 'a reported condition never fails the reconcile');
  assert.equal(harnessed.calls.some((call) => call.get === 'e2e-functional-account@anywear.local'), false);
  assert.equal(recordAnnotations(record).errors.length, 0);
  assert.equal(recordAnnotations(record).warnings.length, 1);
});

test('the reconcile artifact name, upload set and per-day bound are closed', () => {
  // #224: the reconcile family is named by its own parser and the same protected-run binding.
  assert.deepEqual(parseReconcileArtifactName('beta-account-reconcile-40012312740-1'), { smoke: false, runId: 40012312740, attempt: 1 });
  for (const name of ['beta-account-reconcile-0-1', 'beta-account-reconcile-1', 'beta-account-reconcile-1-0',
    'beta-account-lifecycle-1-1', 'beta-account-reconcile-1-1-extra']) {
    assert.equal(parseReconcileArtifactName(name), undefined, name);
  }

  const entry = (name, extra = {}) => ({ name, size: 210, ...extra });
  assert.deepEqual(classifyReconcileArchive([
    entry('account-reconcile.json'), entry('deployment-evidence.json'),
    entry('service-cleanup-0-38851867995-1-0000000000000000.json'), entry('service-cleanup-3-123-1-0123456789abcdef.json'),
  ]), { records: ['service-cleanup-0-38851867995-1-0000000000000000.json', 'service-cleanup-3-123-1-0123456789abcdef.json'] });
  assert.deepEqual(classifyReconcileArchive([entry('account-reconcile.json')]), { records: [] });
  for (const name of ['account-budget.json', 'service-cleanup-1-123-1.json', 'test-results/account-reconcile.json',
    'service-cleanup--1-1-0123456789abcdef.json', 'service-cleanup-1-0-1-0123456789abcdef.json']) {
    assert.throws(() => classifyReconcileArchive([entry(name)]), /unknown file/, name);
  }
  assert.throws(() => classifyReconcileArchive([entry('account-reconcile.json', { directory: true })]), /directory or symlink/);
  assert.throws(() => classifyReconcileArchive([entry('deployment-evidence.json', { symlink: true })]), /directory or symlink/);
  assert.throws(() => classifyReconcileArchive([entry('account-reconcile.json'), entry('account-reconcile.json')]), /repeats/);
  assert.throws(() => classifyReconcileArchive([entry('account-reconcile.json', { size: LIFECYCLE_FILE_MAX_BYTES + 1 })]), /over its bound/);
  assert.throws(() => classifyReconcileArchive([]), /empty/);

  const week = reconcileWindow(NOW);
  const migration = reconcileWindow(NOW, RECONCILE_MIGRATION_WINDOW_DAYS);
  assert.equal(RECONCILE_RECORD_ARTIFACTS_PER_DAY, 9);
  assert.equal(maxReconcileArtifactsForWindow(week), RECONCILE_WINDOW_DAYS * RECONCILE_RECORD_ARTIFACTS_PER_DAY);
  assert.equal(maxReconcileArtifactsForWindow(migration), RECONCILE_MIGRATION_WINDOW_DAYS * RECONCILE_RECORD_ARTIFACTS_PER_DAY);
  assert.equal(RECONCILE_WITNESS_ARTIFACT_READS, 40);
});

test('one artifact-list walk carries both families, and each keeps its own per-day bound', async () => {
  const window = reconcileWindow(NOW);
  const lifecycle = retainedFixture();
  const reconcile = reconcileArtifactFixture(5, { runId: 300 });
  const collected = await collectLifecycleArtifacts({ window, fetchPage: artifactPages([unrelatedArtifact(0), lifecycle.entry, reconcile.entry]) });
  assert.deepEqual(collected.map((row) => row.name).sort(), [lifecycle.entry.name, reconcile.entry.name].sort());
  assert.ok(collected.every((row) => row.created_at !== undefined));

  // The reconcile family refuses its sixty-fourth row, exactly as the lifecycle family does.
  const reconcileRows = Array.from({ length: maxReconcileArtifactsForWindow(window) + 1 },
    (_, index) => reconcileArtifactFixture(100 + index, { runId: 500 + index }).entry);
  await assert.rejects(collectLifecycleArtifacts({ window, fetchPage: artifactPages(reconcileRows) }),
    /Reconcile artifacts in the window exceed/);
  // At the bound, a reconcile row never consumes one unit of the lifecycle bound.
  const atBound = await collectLifecycleArtifacts({ window, fetchPage: artifactPages(reconcileRows.slice(0, -1)) });
  assert.equal(atBound.length, maxReconcileArtifactsForWindow(window));

  // A name in neither family is still a dispatch mistake, not an ignored row.
  const harnessed = harness({ artifacts: [] });
  await assert.rejects(reconcileAccounts({
    io: { ...harnessed.io, async listArtifacts() { return [{ ...reconcile.entry, name: 'playwright-report-1' }]; } },
    now: NOW, runIdentity, window, environment: {},
  }), /non-lifecycle artifact/);
});

test('a reconcile-family record answers the witness lookup and resolves the identity as already absent', async () => {
  // The retained identity comes from the lifecycle family; the verified record for its exact
  // execution survives in a reconcile artifact, so the cleanup is proved without ECS.
  const record = cleanupRecord();
  const cleanupFile = 'service-cleanup-0-123-1-0123456789abcdef.json';
  const reconcileArtifact = reconcileArtifactFixture(10, { runId: 400, records: [{ file: cleanupFile, record }] });
  const run = await witnessRun({ artifacts: [retainedFixture(), reconcileArtifact] });
  assert.equal(run.result, 'passed');
  assert.equal(run.lookups(), 1);
  assert.deepEqual(run.record.identities[0].actions,
    { service_cleanup: 'committed', cognito: 'already_absent', objects: 'deleted', readback: 'absent' });
  assert.equal(run.record.identities[0].outcome, 'already_absent');
  assert.deepEqual(run.record.unresolved, []);
  // `sources.artifacts` still counts the lifecycle family only.
  assert.equal(run.record.sources.artifacts, 1);
  const witness = run.getWitness();
  assert.equal(witness.record.operation.execution_name, WITNESS_EXECUTION);
  assert.deepEqual(witness.source, { artifact_id: reconcileArtifact.entry.id, artifact_name: reconcileArtifact.entry.name,
    artifact_digest: reconcileArtifact.entry.digest, file: cleanupFile,
    record_sha256: createHash('sha256').update(JSON.stringify(record)).digest('hex') });
  assert.equal(run.logs.some((line) => line.includes(`cleanup record for ${WITNESS_EXECUTION} read from`)), true);
});

test('the earliest of two identical live-root records is the witness', async () => {
  const record = cleanupRecord();
  const file = 'service-cleanup-0-123-1-0123456789abcdef.json';
  const early = reconcileArtifactFixture(10, { runId: 400, createdAt: new Date(NOW - 2 * DAY).toISOString(), records: [{ file, record }] });
  const late = reconcileArtifactFixture(11, { runId: 401, createdAt: new Date(NOW - DAY).toISOString(), records: [{ file, record }] });
  const run = await witnessRun({ artifacts: [retainedFixture(), late, early] });
  assert.equal(run.getWitness().source.artifact_name, early.entry.name);
  assert.equal(run.record.identities[0].outcome, 'already_absent');
});

test('a refused record and an artifact-stamped record are never witnesses', async () => {
  const file = 'service-cleanup-0-123-1-0123456789abcdef.json';
  const live = cleanupRecord();
  const cases = [
    ['refused', cleanupRecord({ patch: { proof_status: 'refused' } })],
    ['artifact', cleanupRecord({ proofOrigin: 'artifact',
      tasks: [live.operation.tasks[0], { ...live.operation.tasks[1], proof_origin: 'artifact' }] })],
  ];
  for (const [label, record] of cases) {
    const artifact = reconcileArtifactFixture(10, { runId: 400, records: [{ file, record }] });
    const run = await witnessRun({ artifacts: [retainedFixture(), artifact] });
    assert.equal(run.getWitness(), undefined, label);
    // The candidate was read and inspected; it is simply not a source.
    assert.equal(run.harnessed.calls.filter((call) => call.artifact === artifact.entry.id).length, 1, label);
    assert.deepEqual(run.record.unresolved.map((entry) => entry.reason), ['service_cleanup_refused'], label);
  }
});

test('a conflicting duplicate for one execution drops the name and refuses the identity', async () => {
  const first = cleanupRecord();
  const second = cleanupRecord({ patch: { input_sha256: 'c'.repeat(64) } });
  const early = lifecycleArtifactWithDiagnostic(20, first, { runId: 400 });
  const late = lifecycleArtifactWithDiagnostic(21, second, { runId: 401, createdAt: new Date(NOW - DAY).toISOString() });
  const run = await witnessRun({ artifacts: [retainedFixture(), early, late] });
  assert.equal(run.getWitness(), undefined);
  assert.equal(run.logs.some((line) => line.includes('appears in two artifacts with different bytes')), true);
  assert.deepEqual(run.record.unresolved.map((entry) => entry.reason), ['service_cleanup_refused']);
});

test('a lifecycle artifact diagnostic is a witness source at no extra read', async () => {
  const record = cleanupRecord();
  const lifecycle = lifecycleArtifactWithDiagnostic(20, record, { runId: 123 });
  const run = await witnessRun({ artifacts: [lifecycle] });
  assert.equal(run.getWitness().source.artifact_name, lifecycle.entry.name);
  assert.equal(run.getWitness().source.file, 'service-cleanup-operation.json');
  assert.equal(run.getWitness().record.operation.execution_name, WITNESS_EXECUTION);
  // The diagnostic was already downloaded with the manifest read; the lookup read nothing more.
  assert.equal(run.harnessed.calls.filter((call) => call.artifact === lifecycle.entry.id).length, 1);
  assert.equal(run.record.identities[0].outcome, 'already_absent');
});

test('a corrupt lifecycle cleanup diagnostic is skipped, not a source failure', async () => {
  // The diagnostics were ignored before #224, so a corrupt one contributes no witness and must not
  // turn an otherwise valid reconcile into a source failure; the skip is logged.
  const lifecycle = artifactFixture(0, { runId: 123,
    manifest: manifestFixture(123, 1, [manifestRecord({ subject: subject(1) })]).manifest });
  lifecycle.entries = lifecycle.entries.map((entry) => entry.name === 'service-cleanup-operation.json'
    ? { ...entry, bytes: Buffer.from('{not-json') } : entry);
  const harnessed = harness({ artifacts: [lifecycle], users: [{ email: stable(0), sub: subject(1) }] });
  const logs = [];
  const { record, result } = await reconcileAccounts({
    io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {}, log: (line) => logs.push(line),
  });
  assert.equal(result, 'passed');
  assert.equal(record.identities[0].outcome, 'reconciled');
  assert.equal(logs.some((line) => line.includes(`ignored an unreadable cleanup diagnostic in ${lifecycle.entry.name}`)), true);
});

test('the witness lookup reads at most forty candidate artifacts per execution', async () => {
  const artifacts = [retainedFixture(), ...Array.from({ length: RECONCILE_WITNESS_ARTIFACT_READS + 1 },
    (_, index) => reconcileArtifactFixture(100 + index, { runId: 500 + index }))];
  const run = await witnessRun({ artifacts });
  assert.equal(run.getWitness(), undefined);
  const reconcileReads = run.harnessed.calls.filter((call) => typeof call.artifact === 'number' && call.artifact > 100);
  assert.equal(reconcileReads.length, RECONCILE_WITNESS_ARTIFACT_READS);
});

test('a witness resolves from the rows the production collector builds, not a hand-written row', async () => {
  // Regression: `collectLifecycleArtifacts` is the production listing, and the lookup filters on
  // `expired === false`. A collected row that dropped the flag silently closed the artifact tier
  // in production and re-created the exact #224 defect once the marker's retention passed.
  const lifecycle = retainedFixture();
  const record = cleanupRecord();
  const reconcileArtifact = reconcileArtifactFixture(10, { runId: 400,
    records: [{ file: 'service-cleanup-0-123-1-0123456789abcdef.json', record }] });
  const window = reconcileWindow(NOW);
  const collected = await collectLifecycleArtifacts({ window,
    fetchPage: artifactPages([lifecycle.entry, reconcileArtifact.entry]) });
  const reconcileRow = collected.find((row) => row.name === reconcileArtifact.entry.name);
  assert.equal(reconcileRow.expired, false, 'the collector row must state the flag the lookup filters on');
  let witness;
  const harnessed = harness({ artifacts: [lifecycle, reconcileArtifact], users: [],
    cleanup: async (_inputs, _environment, options) => {
      witness = await options.recovery(WITNESS_EXECUTION, WITNESS_STOPPED_AT);
      return witness ? { proof_status: 'verified', committed_result: committedResult() } : { proof_status: 'refused' };
    } });
  const { record: reconcileRecord, result } = await reconcileAccounts({
    io: { ...harnessed.io, async listArtifacts() { return collected; } },
    now: NOW, runIdentity, window, environment: {},
  });
  assert.equal(result, 'passed');
  assert.equal(witness.record.operation.execution_name, WITNESS_EXECUTION);
  assert.equal(witness.source.artifact_name, reconcileArtifact.entry.name);
  assert.equal(reconcileRecord.identities[0].outcome, 'already_absent');
  assert.deepEqual(reconcileRecord.unresolved, []);
});

test('the ordinary teardown passes no witness lookup, and a live reconcile never reads one', async () => {
  // The reach of tier 3 is the reconcile operation alone: the teardown/job cleanup never supplies
  // a lookup, so it cannot read another run's artifact to prove its own fresh execution.
  const teardown = readFileSync(new URL('./cleanup-worker-accounts.mjs', import.meta.url), 'utf8');
  assert.equal(teardown.includes('createCleanupWitnessLookup'), false);
  assert.equal(teardown.includes('recovery:'), false);
  const harnessed = harness({ artifacts: [retainedFixture()], users: [{ email: stable(0), sub: subject(1) }] });
  const logs = [];
  const { record } = await reconcileAccounts({
    io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {}, log: (line) => logs.push(line),
  });
  assert.equal(record.identities[0].outcome, 'reconciled');
  assert.equal(logs.some((line) => line.includes('cleanup record for')), false);
  // The reconcile supplies the lookup; only an exhausted live proof calls it.
  assert.equal(typeof harnessed.calls.find((call) => call.service).options.recovery, 'function');
});
