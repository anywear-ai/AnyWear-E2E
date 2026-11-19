import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
  AccountLeaseRefusalError,
  accountBudgetConfig,
  markAccountDeleted,
  markAccountInUse,
  recordAccountSubject,
  releaseWorkerAccount,
  reserveAccount,
  retainAccount,
  retainAttemptedAccount,
} from '../tests/support/account-budget.ts';

const environment = [
  'E2E_ACCOUNT_BUDGET_PATH',
  'E2E_ACCOUNT_RUN_SCOPE',
  'E2E_WORKERS',
  'E2E_STAGE',
  'E2E_WORKER_SLOT_OFFSET',
  'E2E_MAX_ACTIVE_ACCOUNTS',
  'E2E_MAX_NEW_ACCOUNTS_PER_RUN',
];
const originalEnvironment = new Map(environment.map((name) => [name, process.env[name]]));
const temporaryDirectories = [];

// The eight stable Beta worker-pool rows (issue #213). The budget leases only these.
const workerAddress = (slot = 0) => `e2e-beta-worker-${slot}-chromium@anywear.local`;

function restoreEnvironment() {
  for (const name of environment) {
    const originalValue = originalEnvironment.get(name);
    if (originalValue === undefined) delete process.env[name];
    else process.env[name] = originalValue;
  }
}

afterEach(async () => {
  restoreEnvironment();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test('a deleted pool address can be re-reserved with a fresh lease and subject', async () => {
  await configureBudget();
  const email = workerAddress();

  await reserveAccount(email, 'worker', 'lease-1');
  await recordAccountSubject(email, 'subject-1');
  await markAccountDeleted(email);
  await reserveAccount(email, 'worker', 'lease-2');
  await recordAccountSubject(email, 'subject-2');
  await markAccountInUse(email);

  const manifest = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
  assert.equal(manifest.accounts.length, 2);
  assert.deepEqual(manifest.accounts.map(({ status, subject }) => ({ status, subject })), [
    { status: 'deleted', subject: 'subject-1' },
    { status: 'in_use', subject: 'subject-2' },
  ]);
  await assert.rejects(reserveAccount(email, 'worker', 'lease-3'), /already has an active lease/);
});

test('every attempt reservation consumes the per-run creation budget', async () => {
  await configureBudget(2);

  await reserveAccount(workerAddress(0), 'worker', 'lease-1');
  await markAccountDeleted(workerAddress(0));
  await reserveAccount(workerAddress(1), 'worker', 'lease-2');
  await markAccountDeleted(workerAddress(1));

  await assert.rejects(reserveAccount(workerAddress(0), 'worker', 'lease-3'), /new-account budget exhausted/);
  const manifest = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
  assert.equal(manifest.accounts.length, 2);
});

test('retention applies to the latest lease of a re-created pool address', async () => {
  await configureBudget();
  const email = workerAddress();

  await reserveAccount(email, 'worker', 'lease-1');
  await markAccountDeleted(email);
  await reserveAccount(email, 'worker', 'lease-2');
  await retainAccount(email, 'cleanup failed');

  const manifest = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
  assert.deepEqual(manifest.accounts.map(({ status }) => status), ['deleted', 'retained']);
});

test('a released attempt returns its pool address for a fresh lease generation', async () => {
  await configureBudget();
  const email = workerAddress();

  await reserveAccount(email, 'worker', 'lease-1');
  await recordAccountSubject(email, 'subject-1');
  await markAccountInUse(email);
  await releaseWorkerAccount(email);
  await reserveAccount(email, 'worker', 'lease-2');
  await recordAccountSubject(email, 'subject-2');
  await markAccountInUse(email);

  const manifest = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
  assert.deepEqual(manifest.accounts.map(({ status, leaseGeneration, reason }) => ({ status, leaseGeneration, reason })), [
    { status: 'deleted', leaseGeneration: 'lease-1', reason: 'released after verified identity absence' },
    { status: 'in_use', leaseGeneration: 'lease-2', reason: undefined },
  ]);
  assert.notEqual(manifest.accounts[0].leaseId, manifest.accounts[1].leaseId);
});

test('a retained pool slot carries a reason and a reconcile bound, and is never silently reused', async () => {
  await configureBudget();
  const email = workerAddress();

  const before = Date.now();
  await reserveAccount(email, 'worker', 'lease-1');
  await retainAccount(email, 'teardown: identity is still present');
  const manifest = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
  const record = manifest.accounts[0];
  assert.equal(record.status, 'retained');
  assert.equal(record.retainedReason, 'teardown: identity is still present');
  // The bound is time, not pool capacity: 24 hours from the record's own `createdAt`,
  // which is when the creating run reserved this address.
  assert.ok(Number.isFinite(Date.parse(record.reconcileBy)), 'retained record carries a reconcile bound');
  assert.ok(Date.parse(record.reconcileBy) >= before + 23 * 60 * 60_000);
  assert.ok(Date.parse(record.reconcileBy) <= Date.now() + 25 * 60 * 60_000);

  const refusal = await reserveAccount(email, 'worker', 'lease-2').then(
    () => assert.fail('a retained slot must not be re-reserved while its identity is present'),
    (thrown) => thrown,
  );
  assert.match(refusal.message, /already has an active lease/);
  assert.equal(refusal.name, 'AccountLeaseRefusalError');
  await assert.rejects(releaseWorkerAccount(email), /retained pending reconcile and cannot be released/);
});

test('retention has no capacity budget: more retained slots than workers are still writable', async () => {
  await configureBudget(8);
  process.env.E2E_MAX_ACTIVE_ACCOUNTS = '8';
  // Four retained slots would have exhausted the removed two-slot quarantine budget.
  for (const slot of [0, 1, 2, 3]) {
    await reserveAccount(workerAddress(slot), 'worker', `lease-${slot}`);
    await retainAccount(workerAddress(slot), 'teardown: partial');
  }
  const manifest = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
  assert.deepEqual(manifest.accounts.map(({ status }) => status), Array(4).fill('retained'));
});

test('a depleted pool fails with the account-budget error instead of minting another address', async () => {
  await configureBudget();
  process.env.E2E_MAX_ACTIVE_ACCOUNTS = '2';
  for (const slot of [0, 1]) {
    await reserveAccount(workerAddress(slot), 'worker', `lease-${slot}`);
    await retainAccount(workerAddress(slot), 'teardown: identity is still present');
  }
  // Both leased rows are retained, so a retry has no address to take. The refusal is the
  // budget's own error; it is never a fresh synthetic address the allowlist does not list.
  for (const slot of [0, 1]) {
    const error = await reserveAccount(workerAddress(slot), 'worker', 'lease-retry').then(
      () => assert.fail('a depleted pool must refuse the attempt'),
      (thrown) => thrown,
    );
    assert.ok(error instanceof AccountLeaseRefusalError);
    assert.equal(error.code, 'E2E_ACCOUNT_LEASE_REFUSED');
  }
  const manifest = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
  assert.deepEqual(manifest.accounts.map(({ email, status }) => ({ email, status })), [
    { email: workerAddress(0), status: 'retained' },
    { email: workerAddress(1), status: 'retained' },
  ]);
});

test('the budget refuses a worker address outside the eight-row pool', async () => {
  await configureBudget();
  for (const email of [
    'e2e-beta-worker-8-chromium@anywear.local',
    'e2e-beta-worker-0-firefox@anywear.local',
    'e2e-beta-123456789-1-0123456789abcdef-0-a1b2c3d4@anywear.local',
    'e2e-functional-account@anywear.local',
  ]) {
    await assert.rejects(reserveAccount(email, 'worker', 'lease-foreign'), /leases only the eight Beta worker-pool addresses/, email);
  }
  await assert.rejects(readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'), { code: 'ENOENT' });
});

test('a refused re-reservation is diagnosed, keeps its exact message, and writes nothing', async () => {
  await configureBudget();
  const email = workerAddress();

  await reserveAccount(email, 'worker', 'lease-1');
  await retainAccount(email, 'teardown: identity is still present');
  const before = await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8');

  const error = await reserveAccount(email, 'worker', 'lease-2').then(
    () => assert.fail('a retained slot must not be re-reserved'),
    (thrown) => thrown,
  );
  assert.ok(error instanceof AccountLeaseRefusalError);
  // Byte-for-byte: the guard's message text is the original defect string, so
  // existing evidence and log comparisons stay valid.
  assert.equal(error.message, 'Account already has an active lease: ' + email);
  assert.equal(error.name, 'AccountLeaseRefusalError');
  assert.equal(error.code, 'E2E_ACCOUNT_LEASE_REFUSED');
  assert.equal(error.email, email);
  assert.equal(error.leaseGeneration, 'lease-1');
  // The refused record's own bounded reason, read from `retainedReason`.
  assert.equal(error.reason, 'teardown: identity is still present');
  // The refusal is a read-only diagnosis: the manifest is unchanged.
  assert.equal(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'), before);
});

test('a refusal inside the same run scope is still an ordinary guard, not a reuse', async () => {
  await configureBudget();
  const email = workerAddress();

  await reserveAccount(email, 'worker', 'lease-1');
  await markAccountInUse(email);
  const error = await reserveAccount(email, 'worker', 'lease-2').then(
    () => assert.fail('a held lease must not be re-reserved'),
    (thrown) => thrown,
  );
  assert.equal(error.code, 'E2E_ACCOUNT_LEASE_REFUSED');
  assert.equal(error.leaseGeneration, 'lease-1');
  assert.equal(error.reason, undefined, 'a held lease carries no retention reason');
});

test('a historical manifest written before #217 is read as retained and stays writable', async () => {
  await configureBudget();
  const email = workerAddress();
  // Exactly what the removed model wrote: a `quarantined` status, a `reason` and a
  // `maxQuarantinedAccounts` budget member.
  await writeFile(process.env.E2E_ACCOUNT_BUDGET_PATH, `${JSON.stringify({
    version: 1,
    runScope: process.env.E2E_ACCOUNT_RUN_SCOPE,
    config: { maxActiveAccounts: 1, maxNewAccountsPerRun: 2, maxQuarantinedAccounts: 1 },
    accounts: [{
      email, mode: 'worker', status: 'quarantined', subject: '10000000-0000-4000-8000-000000000001',
      leaseId: 'lease-1', leaseGeneration: 'generation-1',
      createdAt: '2026-10-16T05:03:56.709Z', updatedAt: '2026-10-16T05:03:56.709Z',
      reason: 'teardown: business cleanup partial',
    }],
  })}\n`);

  // Reading the record answers as `retained`, and the ledger can still be written: the
  // reconciler's `deleted` transition must land on the same file.
  await markAccountDeleted(email);
  const state = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
  assert.equal(state.accounts[0].status, 'deleted');
  assert.equal(state.accounts[0].retainedReason, 'teardown: business cleanup partial');
  assert.equal(state.accounts[0].reconcileBy, '2026-10-17T05:03:56.709Z');
  assert.equal(Object.hasOwn(state.config, 'maxQuarantinedAccounts'), false, 'the removed budget member is dropped on write');
});

test('a retained identity consumes no active budget while its own address stays blocked', async () => {
  await configureBudget();
  // One active slot and one new-account slot: under the removed model the retained record
  // would have consumed the active budget and a later attempt could not lease at all.
  process.env.E2E_MAX_ACTIVE_ACCOUNTS = '1';
  process.env.E2E_MAX_NEW_ACCOUNTS_PER_RUN = '2';
  await reserveAccount(workerAddress(0), 'worker', 'lease-0');
  await retainAccount(workerAddress(0), 'teardown: identity is still present');

  // The second attempt leases normally: `retained` is not a capacity gate.
  await reserveAccount(workerAddress(1), 'worker', 'lease-1');
  await markAccountInUse(workerAddress(1));
  const manifest = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
  assert.deepEqual(manifest.accounts.map(({ status }) => status), ['retained', 'in_use']);

  // The retained address itself is still refused, with its own reason: the identity is
  // present, so only the reconcile operation can return the row to the pool.
  const refusal = await reserveAccount(workerAddress(0), 'worker', 'lease-again').then(
    () => assert.fail('a retained address must not be leased'),
    (thrown) => thrown,
  );
  assert.ok(refusal instanceof AccountLeaseRefusalError);
  assert.equal(refusal.reason, 'teardown: identity is still present');
});

test('a retained attempt still counts against the per-run new-account cap', async () => {
  await configureBudget(2);
  process.env.E2E_MAX_ACTIVE_ACCOUNTS = '2';
  await reserveAccount(workerAddress(0), 'worker', 'lease-0');
  await retainAccount(workerAddress(0), 'teardown: partial');
  await reserveAccount(workerAddress(1), 'worker', 'lease-1');
  await retainAccount(workerAddress(1), 'teardown: partial');
  // Both attempts were retained, so the active budget is empty, but the per-run cap counts
  // every attempt: deletion never restores the creation quota.
  await assert.rejects(reserveAccount(workerAddress(2), 'worker', 'lease-2'), /new-account budget exhausted/);
});

test('the retained bound is anchored to the record createdAt, not to a later read', async () => {
  await configureBudget();
  const email = workerAddress();
  // A record created three days ago and last written now: the bound states when the creating
  // run's leftover became late, not when this reader noticed it.
  await writeFile(process.env.E2E_ACCOUNT_BUDGET_PATH, `${JSON.stringify({
    version: 1,
    runScope: process.env.E2E_ACCOUNT_RUN_SCOPE,
    config: { maxActiveAccounts: 1, maxNewAccountsPerRun: 2 },
    accounts: [{
      email, mode: 'worker', status: 'quarantined',
      leaseId: 'lease-1', leaseGeneration: 'generation-1',
      createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z',
      reason: 'teardown: business cleanup partial',
    }],
  })}\n`);
  await markAccountDeleted(email);
  const state = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
  assert.equal(state.accounts[0].status, 'deleted');
  assert.equal(state.accounts[0].reconcileBy, '2026-10-17T00:00:00.000Z', 'the bound starts at createdAt');
});

test('attempt-scoped reservations cover every retry of the configured workers', () => {
  // Two workers run in parallel and Playwright may add two retries, so the
  // per-run creation cap has to cover 2 x 3 attempts.
  delete process.env.E2E_MAX_NEW_ACCOUNTS_PER_RUN;
  delete process.env.E2E_MAX_ACTIVE_ACCOUNTS;
  assert.deepEqual(accountBudgetConfig(2), { maxActiveAccounts: 2, maxNewAccountsPerRun: 6 });
});

test('six attempt reservations of two pool slots fit the per-run cap and the seventh still refuses', async () => {
  await configureBudget(6);
  process.env.E2E_MAX_ACTIVE_ACCOUNTS = '2';
  // Two slots, three attempts each; a retry re-leases its own slot's row.
  const addresses = [0, 1].flatMap((slot) => [0, 1, 2].map(() => workerAddress(slot)));

  for (const [index, address] of addresses.entries()) {
    await reserveAccount(address, 'worker', `lease-${index}`);
    await releaseWorkerAccount(address);
  }

  await assert.rejects(reserveAccount(workerAddress(0), 'worker', 'lease-overflow'), /new-account budget exhausted/);
  const manifest = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
  assert.equal(manifest.accounts.length, 6);
  assert.deepEqual(manifest.accounts.map(({ status }) => status), Array(6).fill('deleted'));
});

// #287: a refused teardown retains exactly the identities it attempted. The write resolves by
// the captured address *and* subject, never by "the latest record for this email".
const CAPTURED_SUBJECT = '10000000-0000-4000-8000-000000000001';
const LATER_SUBJECT = '20000000-0000-4000-8000-000000000002';
const ledgerState = (accounts, runScope) => ({ version: 1, runScope, config: { maxActiveAccounts: 1, maxNewAccountsPerRun: 2 }, accounts });
const ledgerAccount = (overrides = {}) => ({ email: workerAddress(), subject: CAPTURED_SUBJECT, mode: 'worker',
  status: 'cleanup_pending', leaseId: 'lease-1', leaseGeneration: 'generation-1',
  createdAt: '2026-10-16T05:03:56.709Z', updatedAt: '2026-10-16T05:03:56.709Z', ...overrides });

async function writeLedger(accounts) {
  await configureBudget();
  await writeFile(process.env.E2E_ACCOUNT_BUDGET_PATH,
    `${JSON.stringify(ledgerState(accounts, process.env.E2E_ACCOUNT_RUN_SCOPE), null, 2)}\n`);
}

test('the retention write lands on the captured identity, never on the latest lease of a reused address', async () => {
  const captured = ledgerAccount();
  // A later lease of the same pool address: "the latest record for this email" would be this one.
  const later = ledgerAccount({ subject: LATER_SUBJECT, status: 'in_use', leaseId: 'lease-2',
    leaseGeneration: 'generation-2', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' });
  await writeLedger([captured, later]);

  assert.equal(await retainAttemptedAccount({ email: captured.email, subject: CAPTURED_SUBJECT },
    'service cleanup refused; CleanupCapabilityRefusal: drift'), true);
  const state = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
  assert.deepEqual(state.accounts.map(account => account.status), ['retained', 'in_use']);
  assert.match(state.accounts[0].retainedReason, /service cleanup refused/);
  // The bound is exactly 24 hours after the captured record's own createdAt.
  assert.equal(state.accounts[0].reconcileBy, '2026-10-17T05:03:56.709Z');
  // The newer lease keeps its status and carries no retention reason of its own.
  assert.equal(state.accounts[1].retainedReason, undefined);
  assert.equal(state.accounts[1].reconcileBy, undefined);
});

test('a retention write for a lease that captured no identity writes nothing', async () => {
  await writeLedger([]);
  assert.equal(await retainAttemptedAccount({ email: workerAddress(1) }, 'service cleanup refused'), false);
  assert.equal(await retainAttemptedAccount({ email: workerAddress(1), subject: CAPTURED_SUBJECT }, 'service cleanup refused'), false);
  const state = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
  assert.deepEqual(state.accounts, [], 'a never-created lease is never written retained');
});

test('a later retention write never resurrects a deleted record', async () => {
  const deleted = ledgerAccount({ status: 'deleted', reason: 'released after verified identity absence' });
  await writeLedger([deleted]);
  assert.equal(await retainAttemptedAccount({ email: deleted.email, subject: CAPTURED_SUBJECT }, 'service cleanup refused'), false);
  const state = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
  assert.equal(state.accounts[0].status, 'deleted');
  assert.equal(state.accounts[0].retainedReason, undefined);
});

async function configureBudget(maxNewAccountsPerRun = 2) {
  const directory = await mkdtemp(path.join(tmpdir(), 'anywear-account-budget-'));
  temporaryDirectories.push(directory);
  process.env.E2E_ACCOUNT_BUDGET_PATH = path.join(directory, 'account-budget.json');
  process.env.E2E_ACCOUNT_RUN_SCOPE = `test-${directory.slice(-8)}`;
  process.env.E2E_WORKERS = '1';
  process.env.E2E_MAX_ACTIVE_ACCOUNTS = '1';
  process.env.E2E_MAX_NEW_ACCOUNTS_PER_RUN = String(maxNewAccountsPerRun);
}
