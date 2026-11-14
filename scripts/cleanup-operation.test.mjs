import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DirectTeardown,
  QUARANTINE_REASON_MAX_BYTES,
  RESOURCE_KINDS,
  SCHEMA_DELETE_ORDER,
  deleteRouteFor,
  machineAuthHeaders,
  quarantinesScope,
  schemaDeleteOrder,
  structuralOwnerKind,
} from '../tests/support/cleanup-operation.ts';
import { readAttemptBusinessCleanup } from '../tests/support/attempt-cleanup-registry.ts';

const SECRET = { CLEANUP_MACHINE_AUTH_SECRET: 'test-secret' };
const OWNER_SUB = '11111111-2222-3333-4444-555555555555';
const RUN_SCOPE = '12345-1-abcdef0123456789';
// The scoped Beta worker address this suite mints per attempt (issue #129).
const scopedWorkerEmail = `e2e-beta-${RUN_SCOPE}-0-a1b2c3d4@anywear.local`;

// The registry key is the attempt identity and is never inspected, so a fresh
// object per attempt is an exact stand-in for the Playwright `TestInfo`.
let attemptCounter = 0;
function fakeTestInfo() {
  attemptCounter += 1;
  return { attempt: 'attempt-' + attemptCounter };
}

/**
 * A passing read-back: every routed GET proves absence and the base-photo list
 * comes back empty. A case that cares about a read states its own result.
 */
function defaultRead(url) {
  if (new URL(url).pathname === '/vto/base-photos') return { status: 200, body: [] };
  return { status: 404 };
}

function harness(options = {}) {
  const calls = [];
  const deletes = [];
  const reads = [];
  // One ordered record of every request this teardown made, so the
  // delete -> read-back -> acknowledge order is assertable without wall-clock time.
  const timeline = [];
  const pathOf = (url) => new URL(url).pathname;
  const expectedEmail = options.expectedEmail ?? scopedWorkerEmail;
  const teardown = new DirectTeardown({
    runScope: RUN_SCOPE,
    testScope: 'wardrobe.spec.ts::scenario',
    retryIndex: 0,
    leaseId: 'lease-1',
    leaseGeneration: 7,
    expectedUsername: options.expectedUsername ?? expectedEmail,
    expectedEmail,
    serviceUrl: 'https://service.invalid',
    environment: SECRET,
    request: {},
    testInfo: options.testInfo ?? fakeTestInfo(),
    io: async (path, init) => {
      calls.push({ path, ...init });
      timeline.push({ kind: 'machine', path });
      if (path.endsWith('/register')) {
        return options.register ?? { status: 201, body: { operation_id: 'op-1', state_version: 1, phase: 'registered', intent_hash: 'hash', replayed: false } };
      }
      if (path.endsWith('/owner-binding')) {
        return options.bind ?? { status: 200, body: { operation_id: 'op-1', state_version: 2, phase: 'owner_bound', product_result: null, teardown_result: null, scope_state: null, active_tasks: 0, pending_outbox: 0 } };
      }
      return options.acknowledge ?? { status: 200, body: { operation_id: 'op-1', state_version: 9, phase: 'lease_terminal', product_result: 'passed', teardown_result: 'passed', scope_state: 'released', active_tasks: 0, pending_outbox: 0 } };
    },
    deleteIo: async (url, authorization) => {
      deletes.push({ url, authorization });
      timeline.push({ kind: 'delete', path: pathOf(url) });
      return options.deleteStatus ? await options.deleteStatus(url) : 200;
    },
    // Every read this teardown issues, in order: the routed GETs and the single
    // base-photo list. An injected `read` decides the answer; the default is the
    // passing one, so a case that does not care about the read-back stays quiet.
    readIo: async (url, authorization) => {
      reads.push({ url, authorization });
      timeline.push({ kind: 'read', path: pathOf(url) });
      if (options.read) return await options.read(url);
      return defaultRead(url);
    },
  });
  return { teardown, calls, deletes, reads, timeline };
}

function attempt(retryIndex, leaseGeneration, payloads, testInfo = fakeTestInfo()) {
  return new DirectTeardown({
    runScope: RUN_SCOPE, testScope: 'wardrobe.spec.ts::scenario', retryIndex,
    leaseId: 'lease-1', leaseGeneration,
    expectedUsername: 'u', expectedEmail: 'u@anywear.local',
    serviceUrl: 'https://service.invalid', request: {}, environment: SECRET,
    testInfo,
    io: async (_path, init) => {
      payloads.push(JSON.parse(init.data));
      return { status: 201, body: { operation_id: 'op-' + retryIndex, state_version: 1, phase: 'registered', intent_hash: 'hash', replayed: false } };
    },
  });
}

test('every machine call carries a short-lived signature bound to its exact body', async () => {
  const { teardown, calls } = harness();
  await teardown.register();
  await teardown.bindOwner(OWNER_SUB);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(call.headers['X-AnyWear-Machine-Signature'], 'signature present');
    assert.ok(call.headers['X-Request-Id'], 'request id present');
    const expiresAt = Number(call.headers['X-AnyWear-Machine-Expires-At']);
    assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + 180_000, 'short lived and inside the Service TTL window');
    assert.equal(typeof call.data, 'string');
  }
});

test('registration must precede binding and acknowledgement', async () => {
  const { teardown } = harness();
  await assert.rejects(() => teardown.bindOwner(OWNER_SUB), /registered before this step/);
  await assert.rejects(() => teardown.finalize('passed', 'Bearer t'), /registered before this step/);
});

test('a scoped Beta worker address is transmitted verbatim to the operation surface', async () => {
  // The attempt's own scoped address is what the Service registers and what the
  // lease declaration is keyed by, so the identity the teardown later deletes is
  // exactly the identity this attempt created.
  const scoped = scopedWorkerEmail;
  const testInfo = fakeTestInfo();
  const { teardown, calls } = harness({ testInfo, expectedEmail: scoped });
  await teardown.register();
  assert.equal(JSON.parse(calls[0].data).expected_email, scoped);
  assert.equal(JSON.parse(calls[0].data).expected_username, scoped);
  assert.deepEqual(readAttemptBusinessCleanup(testInfo), { email: scoped, state: 'open' });
});

test('registration refusal aborts the attempt without claiming a scope', async () => {
  const { teardown } = harness({ register: { status: 400, body: { error: 'VALIDATION_ERROR' } } });
  await assert.rejects(() => teardown.register(), /refused with 400/);
  assert.equal(teardown.id, undefined);
});

test('owner binding refuses a malformed subject before any request', async () => {
  const { teardown, calls } = harness();
  await teardown.register();
  const before = calls.length;
  await assert.rejects(() => teardown.bindOwner('not-a-subject'), /subject is malformed/);
  assert.equal(calls.length, before);
});

test('exact created resource refs are captured once each, acknowledged in capture order, and deleted in schema order', async () => {
  const { teardown, calls, deletes } = harness();
  await teardown.register();
  teardown.capture('wardrobe_item', 'item-1');
  teardown.capture('wardrobe_item', 'item-1');
  teardown.capture('outfit_generation', 'gen-1');
  teardown.capture('base_photo', 'photo-1');
  teardown.capture('outfit', 'outfit-1');
  assert.equal(teardown.captured.length, 4);
  await teardown.finalize('passed', 'Bearer token');
  // Capture order is base photo, item, generation, outfit. The deletes follow the
  // schema contract instead: the generation first, because it references both the
  // outfit and the base photo; then the outfit, whose cascade releases its
  // joining rows; only then the item it held and the base photo it referenced.
  assert.deepEqual(deletes.map((entry) => entry.url), [
    'https://service.invalid/vto/generations/gen-1',
    'https://service.invalid/outfits/outfit-1',
    'https://service.invalid/wardrobe/items/item-1',
    'https://service.invalid/vto/base-photos/photo-1',
  ]);
  assert.ok(deletes.every((entry) => entry.authorization === 'Bearer token'));
  const acknowledge = calls.at(-1);
  assert.ok(acknowledge);
  assert.deepEqual(JSON.parse(acknowledge.data).resource_refs, [
    { kind: 'wardrobe_item', id: 'item-1' },
    { kind: 'outfit_generation', id: 'gen-1' },
    { kind: 'base_photo', id: 'photo-1' },
    { kind: 'outfit', id: 'outfit-1' },
  ]);
});

test('terminal acknowledgement sends an empty resource ref list when no resources were captured', async () => {
  const { teardown, calls } = harness();
  await teardown.register();
  await teardown.finalize('passed', 'Bearer token');
  const acknowledge = calls.at(-1);
  assert.ok(acknowledge);
  assert.deepEqual(JSON.parse(acknowledge.data).resource_refs, []);
});

test('malformed resource refs fail closed without changing the captured set', async () => {
  const { teardown, calls } = harness();
  await teardown.register();
  teardown.capture('wardrobe_item', 'item-1');
  for (const ref of [
    { kind: 'unknown', id: 'bad-kind' },
    { kind: 'wardrobe_item', id: '' },
    { kind: 'wardrobe_item', id: 'a'.repeat(129) },
    { kind: 'wardrobe_item', id: 42 },
  ]) {
    assert.throws(() => teardown.capture(ref.kind, ref.id), /Cleanup resource/);
  }
  assert.deepEqual(teardown.captured, [{ kind: 'wardrobe_item', id: 'item-1' }]);
  await teardown.finalize('passed', 'Bearer token');
  const acknowledge = calls.at(-1);
  assert.ok(acknowledge);
  assert.deepEqual(JSON.parse(acknowledge.data).resource_refs, [{ kind: 'wardrobe_item', id: 'item-1' }]);
});

// Acceptance 1: the acknowledgement is the last machine call, and it is written
// only after every captured reference was read back. The unified timeline is what
// proves the order; wall-clock time never enters it.
test('the acknowledge POST is the last machine call and follows every delete and read-back', async () => {
  const { teardown, timeline, calls, reads } = harness();
  await teardown.register();
  teardown.capture('base_photo', 'photo-1');
  teardown.capture('wardrobe_item', 'item-1');
  teardown.capture('outfit_generation', 'gen-1');
  teardown.capture('outfit', 'outfit-1');
  const result = await teardown.finalize('passed', 'Bearer token');
  assert.equal(result.teardown_result, 'passed');

  // Deletes, then reads, then the single acknowledgement: no interleaving and no
  // request after the acknowledgement.
  const stages = timeline.map((entry) => entry.kind);
  assert.deepEqual(stages, [
    'machine', 'delete', 'delete', 'delete', 'delete', 'read', 'read', 'read', 'read', 'machine',
  ]);
  const acknowledgeAt = timeline.findLastIndex((entry) => entry.kind === 'machine');
  assert.equal(acknowledgeAt, timeline.length - 1, 'the acknowledgement is the final call');
  assert.ok(timeline[acknowledgeAt].path.endsWith('/cleanup-operations/acknowledge'));
  assert.equal(calls.at(-1).path, '/cleanup-operations/acknowledge');
  const lastReadAt = timeline.findLastIndex((entry) => entry.kind === 'read');
  const lastDeleteAt = timeline.findLastIndex((entry) => entry.kind === 'delete');
  assert.ok(lastDeleteAt < timeline.findIndex((entry) => entry.kind === 'read'), 'every delete precedes every read-back');
  assert.ok(lastReadAt < acknowledgeAt, 'every read-back precedes the acknowledgement');

  // Every captured reference with a read route was read back exactly once, and the
  // base photo was proven absent through the one list route, never a per-photo GET.
  assert.deepEqual(reads.map((entry) => new URL(entry.url).pathname), [
    '/vto/generations/gen-1',
    '/outfits/outfit-1',
    '/wardrobe/items/item-1',
    '/vto/base-photos',
  ]);
  assert.equal(reads.filter((entry) => new URL(entry.url).pathname === '/vto/base-photos').length, 1);
  assert.ok(reads.every((entry) => entry.authorization === 'Bearer token'));
});

// Acceptance 4: a 404 delete is recorded as already absent, never as a deletion.
test('a 404 delete with proven absence records already_absent and passes teardown', async () => {
  const { teardown } = harness({ deleteStatus: () => 404 });
  await teardown.register();
  teardown.capture('wardrobe_item', 'item-1');
  const result = await teardown.finalize('passed', 'Bearer token');
  assert.deepEqual(result.evidence, [{
    ref: { kind: 'wardrobe_item', id: 'item-1' },
    delete_status: 404,
    readback: 'absent',
    disposition: 'already_absent',
  }]);
  assert.equal(result.teardown_result, 'passed');
  assert.equal(result.scope_state, 'released');
});

// Acceptance 4: the 204-and-gone case is `removed`, and it is distinguishable
// from a 404-and-gone case in the returned evidence.
test('a 204 delete with proven absence records removed, distinguishably from already_absent', async () => {
  const { teardown } = harness({ deleteStatus: () => 204 });
  await teardown.register();
  teardown.capture('wardrobe_item', 'item-1');
  const result = await teardown.finalize('passed', 'Bearer token');
  assert.deepEqual(result.evidence, [{
    ref: { kind: 'wardrobe_item', id: 'item-1' },
    delete_status: 204,
    readback: 'absent',
    disposition: 'removed',
  }]);
  assert.equal(result.teardown_result, 'passed');
  assert.equal(result.scope_state, 'released');

  const alreadyAbsent = harness({ deleteStatus: () => 404 });
  await alreadyAbsent.teardown.register();
  alreadyAbsent.teardown.capture('wardrobe_item', 'item-1');
  const alreadyAbsentResult = await alreadyAbsent.teardown.finalize('passed', 'Bearer token');
  assert.notEqual(alreadyAbsentResult.evidence[0].disposition, result.evidence[0].disposition);
});

// Acceptance 3: the read-back wins over the delete status.
test('a 204 delete whose target is still readable is present and quarantines the scope', async () => {
  const { teardown, calls } = harness({ deleteStatus: () => 204, read: () => ({ status: 200 }) });
  await teardown.register();
  teardown.capture('wardrobe_item', 'item-1');
  const result = await teardown.finalize('passed', 'Bearer token');
  assert.equal(result.evidence[0].delete_status, 204);
  assert.equal(result.evidence[0].readback, 'present');
  assert.equal(result.evidence[0].disposition, 'present');
  assert.notEqual(result.teardown_result, 'passed');
  assert.equal(result.scope_state, 'quarantined');
  assert.match(result.quarantine_reason, /wardrobe_item:item-1\(present\)/);
  const acknowledge = calls.at(-1);
  assert.ok(acknowledge.path.endsWith('/acknowledge'), 'the declaration still closes');
  assert.equal(JSON.parse(acknowledge.data).scope_state, 'quarantined');
});

// Acceptance 5: a failed read-back is unverified, never a pass, and the
// acknowledgement is still sent so the declaration closes.
test('a read-back that throws is unverified, fails teardown, and still acknowledges', async () => {
  const { teardown, calls, reads } = harness({ read: () => { throw new Error('read boom'); } });
  await teardown.register();
  teardown.capture('wardrobe_item', 'item-1');
  const result = await teardown.finalize('passed', 'Bearer token');
  assert.equal(reads.length, 1, 'no retry: one read per captured reference');
  assert.equal(result.evidence[0].readback, 'error');
  assert.equal(result.evidence[0].disposition, 'unverified');
  assert.match(result.evidence[0].reason, /read boom/);
  assert.equal(result.teardown_result, 'failed');
  assert.equal(result.scope_state, 'quarantined');
  const acknowledge = calls.at(-1);
  assert.ok(acknowledge.path.endsWith('/acknowledge'), 'the declaration still closes');
  assert.equal(JSON.parse(acknowledge.data).teardown_result, 'failed');
});

// The edge table: a 5xx whose target is provably gone passes, and the anomaly
// stays visible in the evidence. This is a deliberate behaviour change.
test('a 5xx delete whose target is provably gone records absent_unattributed and passes', async () => {
  const { teardown } = harness({ deleteStatus: () => 503 });
  await teardown.register();
  teardown.capture('outfit_generation', 'gen-1');
  const result = await teardown.finalize('passed', 'Bearer token');
  assert.equal(result.evidence[0].delete_status, 503);
  assert.equal(result.evidence[0].disposition, 'absent_unattributed');
  assert.equal(result.teardown_result, 'passed');
  assert.equal(result.scope_state, 'released');
});

// The edge table: a 404 whose target is still readable is a contradiction, and
// the read-back wins.
test('a 404 delete whose target is still readable is present and fails teardown', async () => {
  const { teardown } = harness({ deleteStatus: () => 404, read: () => ({ status: 200 }) });
  await teardown.register();
  teardown.capture('outfit_generation', 'gen-1');
  const result = await teardown.finalize('passed', 'Bearer token');
  assert.equal(result.evidence[0].delete_status, 404);
  assert.equal(result.evidence[0].disposition, 'present');
  assert.notEqual(result.teardown_result, 'passed');
  assert.equal(result.scope_state, 'quarantined');
});

// A thrown delete has no status to attribute absence with, so proven absence is
// unattributed and the thrown message is kept in the evidence.
test('a thrown delete whose target is provably gone records absent_unattributed and keeps the failure reason', async () => {
  const { teardown } = harness({ deleteStatus: () => { throw new Error('socket hang up'); } });
  await teardown.register();
  teardown.capture('outfit', 'outfit-1');
  const result = await teardown.finalize('passed', 'Bearer token');
  assert.equal(result.evidence[0].delete_status, undefined);
  assert.equal(result.evidence[0].disposition, 'absent_unattributed');
  assert.match(result.evidence[0].reason, /delete failed: socket hang up/);
  assert.equal(result.teardown_result, 'passed');
});

test('a delete that leaves its target readable partially fails teardown and quarantines without rewriting the product result', async () => {
  const { teardown, calls } = harness({
    deleteStatus: (url) => (url.includes('/outfits/') ? 500 : 200),
    read: (url) => ({ status: url.includes('/outfits/') ? 200 : 404 }),
  });
  await teardown.register();
  teardown.capture('wardrobe_item', 'item-1');
  teardown.capture('outfit', 'outfit-1');
  const result = await teardown.finalize('passed', 'Bearer token');
  assert.deepEqual(result.evidence.map((entry) => [entry.ref.kind, entry.disposition]), [
    ['outfit', 'present'],
    ['wardrobe_item', 'removed'],
  ]);
  assert.equal(result.teardown_result, 'partial');
  assert.equal(result.scope_state, 'quarantined');
  assert.equal(result.product_result, 'passed', 'a teardown failure never overwrites the product assertion');
  assert.match(result.quarantine_reason, /outfit:outfit-1\(present\)/);
  const acknowledge = calls.at(-1);
  assert.ok(acknowledge);
  const body = JSON.parse(acknowledge.data ?? '{}');
  assert.equal(body.product_result, 'passed');
  assert.equal(body.teardown_result, 'partial');
  assert.equal(body.scope_state, 'quarantined');
});

test('every delete failing while the target stays readable reports failed teardown and keeps the product result', async () => {
  const { teardown } = harness({ deleteStatus: () => 500, read: () => ({ status: 200 }) });
  await teardown.register();
  teardown.capture('wardrobe_item', 'item-1');
  const result = await teardown.finalize('failed', 'Bearer token');
  assert.equal(result.evidence[0].disposition, 'present');
  assert.equal(result.teardown_result, 'failed');
  assert.equal(result.scope_state, 'quarantined');
  assert.equal(result.product_result, 'failed');
});

test('a captured ref with no ordinary user delete route quarantines as unverified instead of being skipped', async () => {
  const { teardown, deletes, reads } = harness();
  await teardown.register();
  teardown.capture('object_key', 'uploads/key.png');
  const result = await teardown.finalize('passed', 'Bearer token');
  assert.equal(deletes.length, 0);
  assert.equal(reads.length, 0, 'no read route exists, so no request is made');
  assert.deepEqual(result.evidence, [{
    ref: { kind: 'object_key', id: 'uploads/key.png' },
    readback: 'error',
    disposition: 'unverified',
    reason: 'no ordinary user-facing read route',
  }]);
  assert.equal(result.teardown_result, 'failed');
  assert.equal(result.scope_state, 'quarantined');
});

test('finalize is idempotent per attempt and deletes and reads each ref only once', async () => {
  const { teardown, deletes, reads, calls } = harness();
  await teardown.register();
  teardown.capture('wardrobe_item', 'item-1');
  const first = await teardown.finalize('passed', 'Bearer token');
  const afterFirst = { deletes: deletes.length, reads: reads.length, calls: calls.length };
  const second = await teardown.finalize('passed', 'Bearer token');
  assert.equal(second.teardown_result, first.teardown_result);
  assert.equal(deletes.length, afterFirst.deletes);
  assert.equal(reads.length, afterFirst.reads);
  assert.equal(calls.length, afterFirst.calls);
});

test('a retry allocates a distinct scope index and a fresh lease generation', async () => {
  const payloads = [];
  await attempt(0, 1, payloads).register();
  await attempt(1, 2, payloads).register();
  assert.equal(payloads[0].retry_index, 0);
  assert.equal(payloads[0].lease_generation, 1);
  assert.equal(payloads[1].retry_index, 1);
  assert.equal(payloads[1].lease_generation, 2);
});

test('an attempt declares nothing until it registers, and registration opens the declaration', async () => {
  const testInfo = fakeTestInfo();
  const { teardown } = harness({ testInfo });
  assert.deepEqual(readAttemptBusinessCleanup(testInfo), { email: '', state: 'undeclared' });

  await teardown.register();
  assert.deepEqual(readAttemptBusinessCleanup(testInfo), {
    email: scopedWorkerEmail,
    state: 'open',
  });
  // An attempt that never registered still waits for its own outcome.
  const unregistered = fakeTestInfo();
  assert.deepEqual(readAttemptBusinessCleanup(unregistered), { email: '', state: 'undeclared' });
});

test('a refused registration never claims a lease declaration', async () => {
  const testInfo = fakeTestInfo();
  const { teardown } = harness({ testInfo, register: { status: 400, body: { error: 'VALIDATION_ERROR' } } });
  await assert.rejects(() => teardown.register(), /refused with 400/);
  assert.deepEqual(readAttemptBusinessCleanup(testInfo), { email: '', state: 'undeclared' });
});

test('finalize closes the declaration with the teardown outcome it recorded', async () => {
  const declared = fakeTestInfo();
  const { teardown } = harness({ testInfo: declared });
  await teardown.register();
  teardown.capture('wardrobe_item', 'item-1');
  const result = await teardown.finalize('passed', 'Bearer token');
  assert.equal(result.teardown_result, 'passed');
  assert.deepEqual(readAttemptBusinessCleanup(declared), {
    email: scopedWorkerEmail,
    state: 'closed',
    teardownResult: 'passed',
  });

  const partialInfo = fakeTestInfo();
  const partial = harness({
    testInfo: partialInfo,
    deleteStatus: (url) => (url.includes('/outfits/') ? 500 : 200),
    read: (url) => ({ status: url.includes('/outfits/') ? 200 : 404 }),
  });
  await partial.teardown.register();
  partial.teardown.capture('wardrobe_item', 'item-1');
  partial.teardown.capture('outfit', 'outfit-1');
  const partialResult = await partial.teardown.finalize('passed', 'Bearer token');
  assert.equal(partialResult.teardown_result, 'partial');
  const partialDeclaration = readAttemptBusinessCleanup(partialInfo);
  assert.equal(partialDeclaration.state, 'closed');
  assert.equal(partialDeclaration.teardownResult, 'partial');
  assert.match(partialDeclaration.reason, /^teardown partial; references 2: /);
  assert.match(partialDeclaration.reason, /outfit:outfit-1\(present\)$/);

  const failedInfo = fakeTestInfo();
  const failed = harness({ testInfo: failedInfo, deleteStatus: () => 500, read: () => ({ status: 200 }) });
  await failed.teardown.register();
  failed.teardown.capture('wardrobe_item', 'item-1');
  const failedResult = await failed.teardown.finalize('failed', 'Bearer token');
  assert.equal(failedResult.teardown_result, 'failed');
  const failedDeclaration = readAttemptBusinessCleanup(failedInfo);
  assert.equal(failedDeclaration.state, 'closed');
  assert.equal(failedDeclaration.teardownResult, 'failed');
});

// Acceptance 6: an attempt that captured nothing still acknowledges `passed`, and
// issues no read-back request at all. This is the zero-capture terminal path.
test('the zero-captured-reference finalize acknowledges passed with no read-back request', async () => {
  const testInfo = fakeTestInfo();
  const { teardown, calls, deletes, reads } = harness({ testInfo });
  await teardown.register();
  const result = await teardown.finalize('skipped', 'Bearer token');
  assert.deepEqual(result.evidence, []);
  assert.equal(result.teardown_result, 'passed');
  assert.equal(result.scope_state, 'released');
  assert.equal(deletes.length, 0);
  assert.equal(reads.length, 0);
  const acknowledge = calls.at(-1);
  assert.ok(acknowledge.path.endsWith('/acknowledge'));
  assert.deepEqual(JSON.parse(acknowledge.data).resource_refs, []);
  assert.equal(JSON.parse(acknowledge.data).teardown_result, 'passed');
  assert.deepEqual(readAttemptBusinessCleanup(testInfo), {
    email: scopedWorkerEmail,
    state: 'closed',
    teardownResult: 'passed',
  });
});

// Acceptance 7: captured references with no bearer token make no request, but the
// declaration still closes as failed and quarantined. It used to pass silently.
test('captured references without a bearer token acknowledge failed and make no request', async () => {
  const testInfo = fakeTestInfo();
  const { teardown, calls, deletes, reads } = harness({ testInfo });
  await teardown.register();
  teardown.capture('wardrobe_item', 'item-1');
  teardown.capture('outfit', 'outfit-1');
  const result = await teardown.finalize('passed');
  assert.equal(result.teardown_result, 'failed');
  assert.equal(result.scope_state, 'quarantined');
  assert.equal(result.quarantine_reason, 'no_authorization');
  assert.equal(deletes.length, 0);
  assert.equal(reads.length, 0);
  assert.deepEqual(result.evidence.map((entry) => [entry.ref.kind, entry.disposition, entry.reason]), [
    ['outfit', 'unverified', 'no_authorization'],
    ['wardrobe_item', 'unverified', 'no_authorization'],
  ]);
  const acknowledge = calls.at(-1);
  const body = JSON.parse(acknowledge.data);
  assert.equal(body.teardown_result, 'failed');
  assert.equal(body.scope_state, 'quarantined');
  assert.equal(body.quarantine_reason, 'no_authorization');
  assert.deepEqual(readAttemptBusinessCleanup(testInfo), {
    email: scopedWorkerEmail,
    state: 'closed',
    teardownResult: 'failed',
    reason: 'no_authorization',
  });
});

test('a refused acknowledgement leaves the declaration open, so the lease cannot release', async () => {
  const testInfo = fakeTestInfo();
  const { teardown } = harness({ testInfo, acknowledge: { status: 409, body: { error: 'LEASE_FENCED' } } });
  await teardown.register();
  await assert.rejects(() => teardown.finalize('passed', 'Bearer token'), /acknowledgement refused with 409/);
  assert.deepEqual(readAttemptBusinessCleanup(testInfo), {
    email: scopedWorkerEmail,
    state: 'open',
  });
});

test('the declaration key is the attempt, not the leased address', async () => {
  // Two attempts share one allowlisted address and one lease generation, which a
  // string-keyed registry would conflate.
  const firstAttempt = fakeTestInfo();
  const secondAttempt = fakeTestInfo();
  const first = harness({ testInfo: firstAttempt });
  const second = harness({ testInfo: secondAttempt });
  await first.teardown.register();
  await second.teardown.register();
  first.teardown.capture('wardrobe_item', 'item-1');
  const firstResult = await first.teardown.finalize('passed', 'Bearer token');
  assert.equal(firstResult.teardown_result, 'passed');

  assert.deepEqual(readAttemptBusinessCleanup(firstAttempt), {
    email: scopedWorkerEmail,
    state: 'closed',
    teardownResult: 'passed',
  });
  assert.deepEqual(readAttemptBusinessCleanup(secondAttempt), {
    email: scopedWorkerEmail,
    state: 'open',
  });
});

test('an unregistered operation is never acknowledged and makes no request', async () => {
  // `finalize` is the only terminal entry point now, so it is also the only place
  // that can reach the acknowledgement. The registration check runs before the
  // first delete or read, so an unregistered attempt fails closed with no call.
  const { teardown, calls, deletes, reads } = harness();
  teardown.capture('wardrobe_item', 'item-1');
  await assert.rejects(() => teardown.finalize('passed', 'Bearer token'), /registered before this step/);
  assert.equal(calls.length, 0);
  assert.equal(deletes.length, 0);
  assert.equal(reads.length, 0);
});

test('delete routes match the existing user-facing Service surface', () => {
  assert.equal(deleteRouteFor({ kind: 'wardrobe_item', id: 'i' }), '/wardrobe/items/i');
  assert.equal(deleteRouteFor({ kind: 'outfit', id: 'o' }), '/outfits/o');
  assert.equal(deleteRouteFor({ kind: 'outfit_generation', id: 'g' }), '/vto/generations/g');
  assert.equal(deleteRouteFor({ kind: 'base_photo', id: 'b' }), '/vto/base-photos/b');
  assert.equal(deleteRouteFor({ kind: 'object_key', id: 'k' }), undefined);
});

test('scope quarantine follows teardown failure, not the product outcome', () => {
  assert.equal(quarantinesScope('passed'), false);
  assert.equal(quarantinesScope('partial'), true);
  assert.equal(quarantinesScope('failed'), true);
});

// The following three tests are the guard against a parent-before-child
// deletion: the capture inventory and the deletion order are asserted together,
// so a kind added to either list without the other fails here instead of at the
// gate in a paid Beta run.

// The schema edges between the captured kinds, as `[referencing kind, referenced
// kind, delete action]`. They fix the order in two different directions, which
// is why the order is a contract and not a preference:
//
// - `no action` refuses the parent delete while a referencing row survives, so
//   the referencing kind must be deleted first.
// - `cascade` releases the referencing row when the parent goes, so the
//   referencing kind can only be deleted *after* it: `outfit_wearable_items ->
//   outfits` is the row that holds a garment, and only the outfit delete removes
//   it.
const SCHEMA_EDGES = [
  ['outfit_generation', 'outfit', 'no action'],
  ['outfit_generation', 'base_photo', 'no action'],
  ['outfit_wearable_items', 'outfit', 'cascade'],
  ['outfit_wearable_items', 'wardrobe_item', 'no action'],
];

// `outfit_wearable_items` is not a captured kind: it is the joining row that
// holds a garment for its outfit, so it stands for the captured `wardrobe_item`
// whose release that row decides.
const standsFor = (kind) => (kind === 'outfit_wearable_items' ? 'wardrobe_item' : kind);

test('every resource kind has a delete order position and every reference is released before its parent', () => {
  // A kind outside the order would silently sort to the front of it.
  assert.deepEqual([...RESOURCE_KINDS].sort(), [...SCHEMA_DELETE_ORDER].sort());
  assert.equal(new Set(SCHEMA_DELETE_ORDER).size, SCHEMA_DELETE_ORDER.length);
  assert.deepEqual([...SCHEMA_DELETE_ORDER], [
    'outfit_generation',
    'outfit',
    'wardrobe_item',
    'base_photo',
    'object_key',
  ]);
  const at = (kind) => SCHEMA_DELETE_ORDER.indexOf(kind);

  for (const [referencing, referenced, action] of SCHEMA_EDGES) {
    if (action === 'cascade') {
      // The parent delete removes the referencing row, so the parent comes first
      // and the kind the row held is free only after it.
      assert.ok(at(referenced) < at(standsFor(referencing)),
        `${standsFor(referencing)} is released by the ${referenced} cascade, so ${referenced} must be deleted first`);
      continue;
    }
    // A `no action` reference refuses the parent delete while its own row
    // survives. The row is gone either because its kind is deleted first, or
    // because a cascade took the row with it — which is how the garment is
    // released: its joining row dies with the outfit, not by its own delete.
    const cascadedAwayBy = SCHEMA_EDGES.filter(([holder, target, edgeAction]) => (
      holder === referencing && edgeAction === 'cascade' && at(target) < at(standsFor(referencing))));
    assert.ok(at(standsFor(referencing)) < at(referenced) || cascadedAwayBy.length > 0,
      `${referencing} must be released before ${referenced}: either it is deleted first, `
      + `or a ${referenced} cascade takes it away first`);
  }
  // Structural ownership is the stricter relation: an outfit does not release a
  // generation the way its cascade releases a joining item row, so a captured
  // generation is unreleasable unless its outfit was captured with it.
  assert.equal(structuralOwnerKind('outfit_generation'), 'outfit');
  for (const kind of ['outfit', 'wardrobe_item', 'base_photo', 'object_key']) {
    assert.equal(structuralOwnerKind(kind), undefined, `${kind} has no structural owner`);
  }
});

test('the deletion order is the schema contract, not the capture order', async () => {
  const { teardown, deletes } = harness();
  await teardown.register();
  for (const [kind, id] of [
    ['base_photo', 'photo-1'],
    ['wardrobe_item', 'item-1'],
    ['outfit_generation', 'gen-1'],
    ['outfit', 'outfit-1'],
  ]) teardown.capture(kind, id);
  await teardown.finalize('passed', 'Bearer token');
  assert.deepEqual(deletes.map((entry) => new URL(entry.url).pathname), [
    '/vto/generations/gen-1',
    '/outfits/outfit-1',
    '/wardrobe/items/item-1',
    '/vto/base-photos/photo-1',
  ]);
  // Sorting is stable and never mutates the captured set, which the
  // acknowledgement still reports in capture order.
  const captured = [
    { kind: 'outfit', id: 'outfit-1' },
    { kind: 'outfit_generation', id: 'gen-1' },
  ];
  const ordered = schemaDeleteOrder(captured);
  assert.notEqual(ordered, captured);
  assert.deepEqual(ordered, [
    { kind: 'outfit_generation', id: 'gen-1' },
    { kind: 'outfit', id: 'outfit-1' },
  ]);
  assert.deepEqual(captured, [
    { kind: 'outfit', id: 'outfit-1' },
    { kind: 'outfit_generation', id: 'gen-1' },
  ]);
});

test('a capture the order cannot release fails closed and names the unproven resource', async () => {
  const kindOf = { '/vto/generations/': 'outfit_generation', '/outfits/': 'outfit',
    '/wardrobe/items/': 'wardrobe_item', '/vto/base-photos/': 'base_photo' };
  const kindAt = (pathname) => kindOf[pathname.slice(0, pathname.lastIndexOf('/') + 1)];
  // Live rows, not the capture list: a reference only refuses a delete while a
  // row of the referencing kind still exists. This is what makes the order work
  // at all, because the generation is gone before its outfit is deleted.
  const refuses = (liveRows, referenced) => SCHEMA_EDGES.some(([referencing, target, action]) => (
    target === referenced && action === 'no action' && liveRows.has(standsFor(referencing))));
  // The read-back reads the same simulated store the deletes mutate, and the base
  // photo is proven through the one list route rather than a per-photo GET.
  const readOf = (liveRows, basePhotoIds) => (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/vto/base-photos') {
      return { status: 200, body: liveRows.has('base_photo') ? basePhotoIds.map((id) => ({ id })) : [] };
    }
    return { status: liveRows.has(kindAt(pathname)) ? 200 : 404 };
  };

  // The order releases every reference: with the whole capture present each
  // delete is accepted, one at a time. The generation is deletable because
  // nothing references it, which is what frees its outfit; the outfit delete
  // then cascade-releases the garment it held. Nothing is left to read back.
  const live = new Set(['outfit_generation', 'outfit', 'wardrobe_item', 'base_photo']);
  const { teardown, deletes } = harness({
    deleteStatus: async (url) => {
      const kind = kindAt(new URL(url).pathname);
      const refusedDelete = refuses(live, kind);
      if (kind === 'outfit') live.delete('wardrobe_item');
      if (!refusedDelete) live.delete(kind);
      return refusedDelete ? 503 : 204;
    },
    read: readOf(live, ['photo-1']),
  });
  await teardown.register();
  teardown.capture('outfit', 'outfit-1');
  teardown.capture('outfit_generation', 'gen-1');
  teardown.capture('base_photo', 'photo-1');
  const complete = await teardown.finalize('passed', 'Bearer token');
  assert.deepEqual(deletes.map((entry) => new URL(entry.url).pathname), [
    '/vto/generations/gen-1',
    '/outfits/outfit-1',
    '/vto/base-photos/photo-1',
  ]);
  assert.deepEqual(complete.evidence.map((entry) => entry.disposition), ['removed', 'removed', 'removed']);
  assert.equal(complete.teardown_result, 'passed');
  assert.equal(complete.scope_state, 'released');
  assert.equal(quarantinesScope(complete.teardown_result), false);

  // A genuinely incomplete capture, the shape this issue fixes: the generation's
  // delete is refused, so the surviving generation keeps refusing the base photo
  // it references. Neither row leaves the store, the read-back finds both still
  // readable, and the gate quarantines naming the unproven references.
  const surviving = new Set(['outfit_generation', 'base_photo']);
  const incomplete = harness({
    deleteStatus: async (url) => {
      const kind = kindAt(new URL(url).pathname);
      return kind === 'outfit_generation' || refuses(surviving, kind) ? 503 : 204;
    },
    read: readOf(surviving, ['photo-1']),
  });
  await incomplete.teardown.register();
  incomplete.teardown.capture('outfit_generation', 'gen-1');
  incomplete.teardown.capture('base_photo', 'photo-1');
  const refused = await incomplete.teardown.finalize('passed', 'Bearer token');
  assert.deepEqual(refused.evidence.map((entry) => entry.disposition), ['present', 'present']);
  assert.equal(refused.teardown_result, 'failed');
  assert.equal(refused.scope_state, 'quarantined');
  assert.equal(quarantinesScope(refused.teardown_result), true);
  assert.match(refused.quarantine_reason, /outfit_generation:gen-1\(present\)/);
  assert.match(refused.quarantine_reason, /base_photo:photo-1\(present\)/);
  const acknowledge = incomplete.calls.at(-1);
  assert.ok(acknowledge);
  assert.equal(JSON.parse(acknowledge.data).scope_state, 'quarantined');
});

// Base photos have no single-resource GET, so all captured base photos are proven
// through exactly one list read per attempt — never a per-photo routed GET.
test('two captured base photos are proven absent through exactly one base-photo list read', async () => {
  const { teardown, reads } = harness({ deleteStatus: () => 204, read: () => ({ status: 200, body: [] }) });
  await teardown.register();
  teardown.capture('base_photo', 'photo-1');
  teardown.capture('base_photo', 'photo-2');
  const result = await teardown.finalize('passed', 'Bearer token');
  assert.deepEqual(reads.map((entry) => new URL(entry.url).pathname), ['/vto/base-photos']);
  assert.deepEqual(result.evidence.map((entry) => entry.disposition), ['removed', 'removed']);
  assert.equal(result.teardown_result, 'passed');
});

test('a captured base photo still in the list is present and withholds a pass', async () => {
  const { teardown, reads } = harness({
    deleteStatus: () => 204,
    read: () => ({ status: 200, body: [{ id: 'photo-2' }] }),
  });
  await teardown.register();
  teardown.capture('base_photo', 'photo-1');
  teardown.capture('base_photo', 'photo-2');
  const result = await teardown.finalize('passed', 'Bearer token');
  assert.equal(reads.length, 1, 'one list read covers every captured base photo');
  assert.deepEqual(result.evidence.map((entry) => [entry.ref.id, entry.disposition]), [
    ['photo-1', 'removed'],
    ['photo-2', 'present'],
  ]);
  assert.equal(result.teardown_result, 'partial');
  assert.equal(result.scope_state, 'quarantined');
  assert.match(result.quarantine_reason, /base_photo:photo-2\(present\)/);
});

test('a failed or thrown base-photo list marks every captured base photo unverified', async () => {
  for (const read of [
    () => ({ status: 503 }),
    () => { throw new Error('list timed out'); },
  ]) {
    const { teardown, reads } = harness({ deleteStatus: () => 204, read });
    await teardown.register();
    teardown.capture('base_photo', 'photo-1');
    teardown.capture('base_photo', 'photo-2');
    const result = await teardown.finalize('passed', 'Bearer token');
    assert.equal(reads.length, 1, 'one failing list read is not retried');
    assert.deepEqual(result.evidence.map((entry) => entry.disposition), ['unverified', 'unverified']);
    assert.equal(result.teardown_result, 'failed');
    assert.equal(result.scope_state, 'quarantined');
  }
});

// The Service's acknowledgement route caps quarantine_reason at 512 characters and
// its schema is strict, so the budget is built here and never overruns.
test('a many-reference quarantine reason stays inside 512 UTF-8 bytes and is deterministic', async () => {
  const capture = (teardown) => {
    for (let index = 0; index < 40; index += 1) {
      teardown.capture('wardrobe_item', 'item-' + String(index).padStart(2, '0') + '-0f8f8f8f-8f8f-4f8f-8f8f-8f8f8f8f8f8f');
    }
  };
  const run = async () => {
    const { teardown, calls } = harness({ deleteStatus: () => 204, read: () => ({ status: 200 }) });
    await teardown.register();
    capture(teardown);
    const result = await teardown.finalize('passed', 'Bearer token');
    return { result, acknowledge: calls.at(-1) };
  };
  const first = await run();
  const second = await run();
  assert.equal(first.result.teardown_result, 'failed');
  assert.ok(first.result.quarantine_reason);
  assert.ok(Buffer.byteLength(first.result.quarantine_reason, 'utf8') <= QUARANTINE_REASON_MAX_BYTES,
    'the reason fits the Service route budget');
  assert.match(first.result.quarantine_reason, /; \+\d+ more$/);
  assert.equal(second.result.quarantine_reason, first.result.quarantine_reason,
    'the same input builds the same reason');
  assert.equal(JSON.parse(first.acknowledge.data).quarantine_reason, first.result.quarantine_reason,
    'the acknowledgement carries exactly the bounded reason');
});

test('machine auth refuses to sign without its secret', () => {
  assert.throws(() => machineAuthHeaders('operation:register', '{}', {}), /CLEANUP_MACHINE_AUTH_SECRET/);
});

