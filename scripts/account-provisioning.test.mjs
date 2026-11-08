import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as account from '../tests/support/account.ts';
import * as betaAddress from '../tests/support/beta-address.ts';
import {
  SCOPED_WORKER_EMAIL_PATTERN,
  STABLE_WORKER_EMAIL_PATTERN,
  WORKER_POOL_ADDRESSES,
  WORKER_POOL_SIZE,
  isBetaWorkerEmailForScope,
  isCapturedBetaWorkerEmail,
  scopedWorkerEmailPattern,
  workerPoolAddress,
} from '../tests/support/beta-address.ts';
import { leaseableWorkerAddresses, workerSlotOffset } from '../scripts/worker-slots.mjs';

const environment = ['E2E_STAGE', 'E2E_WORKERS', 'E2E_WORKER_SLOT_OFFSET', 'E2E_ACCOUNT_RUN_SCOPE'];
const originalEnvironment = new Map(environment.map((name) => [name, process.env[name]]));

const runScope = '123456789-1-0123456789abcdef';
const stable = (slot) => `e2e-beta-worker-${slot}-chromium@anywear.local`;
const scoped = (slot, suffix) => `e2e-beta-${runScope}-${slot}-${suffix}@anywear.local`;

function restoreEnvironment() {
  for (const name of environment) {
    const originalValue = originalEnvironment.get(name);
    if (originalValue === undefined) delete process.env[name];
    else process.env[name] = originalValue;
  }
}

function configureBetaAttempt(workers = '2') {
  process.env.E2E_STAGE = 'beta';
  process.env.E2E_WORKERS = workers;
  delete process.env.E2E_WORKER_SLOT_OFFSET;
}

test('the pool is exactly the eight stable allowlist rows the Service retires', () => {
  assert.equal(WORKER_POOL_SIZE, 8);
  assert.deepEqual(WORKER_POOL_ADDRESSES, Array.from({ length: 8 }, (_, slot) => stable(slot)));
  for (let slot = 0; slot < 8; slot += 1) {
    assert.equal(workerPoolAddress(slot), stable(slot));
    assert.equal(STABLE_WORKER_EMAIL_PATTERN.test(stable(slot)), true);
  }
  // No ninth row, no foreign browser, no similar-looking address family.
  for (const address of [
    stable(8),
    'e2e-beta-worker-2-firefox@anywear.local',
    'e2e-test-worker-2-chromium@anywear.local',
    'e2e-beta-worker-2-chromium@example.com',
    'e2e-beta-worker-02-chromium@anywear.local',
  ]) assert.equal(isCapturedBetaWorkerEmail(address), false, address);
  for (const slot of [-1, 8, 1.5, '0']) assert.throws(() => workerPoolAddress(slot), /pool slot|integer/, String(slot));
});

test('a slot is the parallel index offset inside the pool, and nothing wraps past slot seven', () => {
  configureBetaAttempt();
  assert.equal(account.createWorkerAccount({ parallelIndex: 0 }, 'chromium').email, stable(0));
  assert.equal(account.createWorkerAccount({ parallelIndex: 1 }, 'chromium').email, stable(1));
  process.env.E2E_WORKER_SLOT_OFFSET = '2';
  assert.equal(account.createWorkerAccount({ parallelIndex: 0 }, 'chromium').email, stable(2));
  assert.equal(account.createWorkerAccount({ parallelIndex: 1 }, 'chromium').email, stable(3));
  process.env.E2E_WORKER_SLOT_OFFSET = '6';
  assert.equal(account.createWorkerAccount({ parallelIndex: 1 }, 'chromium').email, stable(7));
  // An offset that would leave the pool refuses before any address is built.
  for (const workers of ['2', '3']) {
    process.env.E2E_WORKER_SLOT_OFFSET = '7';
    process.env.E2E_WORKERS = workers;
    assert.throws(() => account.createWorkerAccount({ parallelIndex: 0 }, 'chromium'), /SLOT_OFFSET|slot/i);
  }
  restoreEnvironment();
});

test('an invalid offset or parallel index fails clearly instead of wrapping into an unlisted address', () => {
  configureBetaAttempt();
  for (const raw of ['', '-1', '7', '8', '1.5', '02', '1e0', ' 0', 'invalid']) {
    process.env.E2E_WORKER_SLOT_OFFSET = raw;
    assert.throws(() => account.createWorkerAccount({ parallelIndex: 0 }, 'chromium'), /SLOT_OFFSET/, JSON.stringify(raw));
  }
  process.env.E2E_WORKERS = '2';
  for (const parallelIndex of [-1, 0.5, 2, '0']) {
    assert.throws(() => account.createWorkerAccount({ parallelIndex }, 'chromium'), /parallelIndex/, String(parallelIndex));
  }
  // Every pool row is chromium; another project has no listed address to borrow.
  for (const browserName of ['firefox', 'webkit', '', undefined]) {
    assert.throws(() => account.createWorkerAccount({ parallelIndex: 0 }, browserName), /chromium-only/, String(browserName));
  }
  restoreEnvironment();
});

test('the leaseable addresses are exactly the slots this run can occupy', () => {
  assert.deepEqual(leaseableWorkerAddresses({}, 2), [stable(0), stable(1)]);
  assert.deepEqual(leaseableWorkerAddresses({ E2E_WORKER_SLOT_OFFSET: '2' }, 2), [stable(2), stable(3)]);
  assert.deepEqual(leaseableWorkerAddresses({ E2E_WORKER_SLOT_OFFSET: '7' }, 1), [stable(7)]);
  for (const [raw, workers] of [['7', 2], ['8', 1], ['1.5', 1], ['02', 1]]) {
    assert.throws(() => leaseableWorkerAddresses({ E2E_WORKER_SLOT_OFFSET: raw }, workers), /SLOT_OFFSET|slot/i);
  }
  for (const workers of [0, 9, 1.5]) assert.throws(() => leaseableWorkerAddresses({}, workers), /SLOT_OFFSET|slot/i);
});

test('every attempt leases a stable pool address, and the generation distinguishes attempts', () => {
  configureBetaAttempt();
  const first = account.createWorkerAccount({ parallelIndex: 0 }, 'chromium');
  const retry = account.createWorkerAccount({ parallelIndex: 0 }, 'chromium');
  // The address no longer randomizes per attempt: the pool row is what Beta lists.
  assert.equal(first.email, retry.email);
  assert.equal(first.email, stable(0));
  assert.notEqual(first.leaseGeneration, retry.leaseGeneration);
  // The address does not depend on the stage name or a browser suffix.
  process.env.E2E_STAGE = 'prod';
  assert.equal(account.createWorkerAccount({ parallelIndex: 0 }, 'chromium').email, stable(0));
  restoreEnvironment();
});

test('the historical scoped family stays deletable and scope-bound for old manifests', () => {
  // The Service's cleanup parser still accepts the run-scoped family #129 introduced, and
  // a historical cleanup still has to delete identities a pre-#213 manifest names. No attempt
  // address is built from it any more, so it is accepted only as a captured artifact.
  assert.match(scoped(0, 'a1b2c3d4'), SCOPED_WORKER_EMAIL_PATTERN);
  assert.equal(isBetaWorkerEmailForScope(scoped(0, 'a1b2c3d4'), runScope), true);
  assert.equal(isBetaWorkerEmailForScope(scoped(0, 'a1b2c3d4'), '123456790-1-0123456789abcdef'), false);
  assert.equal(isBetaWorkerEmailForScope(scoped(0, 'a1b2c3d4').toUpperCase(), runScope), false);
  assert.equal(isBetaWorkerEmailForScope(`e2e-beta-${runScope}-0-a1b2c3d4e@anywear.local`, runScope), false);
  assert.equal(isBetaWorkerEmailForScope(`e2e-beta-${runScope}-8-a1b2c3d4@anywear.local`, runScope), false);
  assert.match(scoped(0, 'a1b2c3d4'), scopedWorkerEmailPattern(runScope));
  // The stable row is scope-free and always admitted for cleanup.
  assert.equal(isBetaWorkerEmailForScope(stable(0), runScope), true);
  assert.equal(isBetaWorkerEmailForScope(stable(0), 'a-foreign-scope'), true);
});

test('the pool replaced the synthetic address minting entirely', () => {
  assert.deepEqual(Object.keys(account).filter((name) => /createTestAccount|registerAndLogin|deleteTestAccount/.test(name)), []);
  assert.deepEqual(Object.keys(betaAddress).filter((name) => /betaWorkerAddress|MAX_ADDRESS_LOCAL_PART_LENGTH/.test(name)), []);
  configureBetaAttempt();
  const accountAddress = account.createWorkerAccount({ parallelIndex: 0 }, 'chromium').email;
  assert.equal(scopedWorkerEmailPattern(runScope).test(accountAddress), false);
  assert.equal(SCOPED_WORKER_EMAIL_PATTERN.test(accountAddress), false);
  restoreEnvironment();
});

test('the attempt reserves its lease before provisioning and the bootstrap marker is gone', async () => {
  const fixture = await readFile(new URL('../tests/support/fixtures.ts', import.meta.url), 'utf8');
  assert.ok(fixture.indexOf('await reserveTestAccount(') < fixture.indexOf('await provisionConfirmedTestAccount('),
    'the lease must be taken before any Cognito identity is created');
  const source = await readFile(new URL('../tests/support/account.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /custom:e2e_bootstrap/, 'the retired bootstrap marker must not be written');
  assert.match(source, /Name: 'email_verified', Value: 'true'/, 'a created identity is still verified');
  assert.match(source, /new AdminCreateUserCommand\(/);
  assert.match(source, /new AdminConfirmSignUpCommand\(/);
  assert.doesNotMatch(source, /registerAndLogin|deleteTestAccount|createTestAccount/);
});

test('the confirmed account row is provisioned out of band before the lease is marked in use', async () => {
  // Issue #230: an identity created with `AdminCreateUser` never fires the
  // PostConfirmation trigger, so the harness itself creates the mirror row
  // through the audited machine-authenticated entry point, before sign-in.
  const source = await readFile(new URL('../tests/support/account.ts', import.meta.url), 'utf8');
  assert.match(source, /\/identity-operations\/provision/, 'the row is created by the audited entry point');
  assert.match(source, /machineAuthHeaders\('identity:provision',/, 'the call carries its own machine capability');
  const confirm = source.indexOf('new AdminConfirmSignUpCommand(');
  // The entry point is also named in prose above the sequence, so ordering is
  // measured from the confirmation onward: the first occurrence after it is the
  // request itself.
  const provision = source.indexOf('/identity-operations/provision', confirm);
  const inUse = source.indexOf('await markAccountInUse(account.email)');
  assert.ok(confirm >= 0 && provision > confirm, 'provisioning must follow the confirmation that precedes it');
  assert.ok(inUse > provision, 'the lease is marked in use only after the row exists');
});

test('workerSlotOffset is the single offset validation', () => {
  assert.equal(workerSlotOffset({}, 2), 0);
  assert.equal(workerSlotOffset({ E2E_WORKER_SLOT_OFFSET: '6' }, 2), 6);
  for (const [raw, workers] of [['', 1], ['-1', 1], ['7', 2], ['8', 1], ['1e0', 1]]) {
    assert.throws(() => workerSlotOffset({ E2E_WORKER_SLOT_OFFSET: raw }, workers), /SLOT_OFFSET/);
  }
});
