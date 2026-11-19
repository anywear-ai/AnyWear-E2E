import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { STABLE_WORKER_EMAIL_PATTERN } from './beta-address.ts';

export type AccountMode = 'worker' | 'ephemeral';
/**
 * The account state model (#217).
 *
 * `retained` replaced the terminal `quarantined` state: a teardown that cannot prove
 * deletion records the identity `retained` with a reason and a `reconcileBy` bound, fails
 * its own run exactly as before, and is resolved by the `reconcile` operation inside that
 * bound. There is no terminal state that only an operator can clear.
 */
export type AccountStatus =
  | 'reserved'
  | 'provisioning'
  | 'in_use'
  | 'cleanup_pending'
  | 'deleted'
  | 'retained';

export interface AccountBudgetConfig {
  maxActiveAccounts: number;
  maxNewAccountsPerRun: number;
}

interface AccountRecord {
  email: string;
  subject?: string;
  mode: AccountMode;
  status: AccountStatus;
  leaseId: string;
  leaseGeneration: string;
  createdAt: string;
  updatedAt: string;
  reason?: string;
  /** The bounded reason a retained scope kept its identity (#217). */
  retainedReason?: string;
  /** The instant the reconciler must have resolved this identity by (#217). */
  reconcileBy?: string;
}

interface AccountBudgetState {
  version: 1;
  runScope: string;
  config: AccountBudgetConfig;
  accounts: AccountRecord[];
}

/**
 * The statuses that consume the active-account budget (#217).
 *
 * `retained` is deliberately absent: it is not a capacity gate. A retained identity consumes no
 * active budget, so it cannot exhaust a later run's budget, while its own address stays out of
 * the pool — the per-address guard in `reserveAccount` refuses the lease and names the retained
 * reason — until the reconcile operation deletes the identity. `maxNewAccountsPerRun` still
 * counts every attempt, retained or not.
 */
const ACTIVE_STATUSES = new Set<AccountStatus>([
  'reserved',
  'provisioning',
  'in_use',
  'cleanup_pending',
]);

/** The bound a retained identity must be reconciled inside (#217). */
export const RECONCILE_BOUND_MS = 24 * 60 * 60_000;

/** A record as a pre-#217 manifest wrote it: the removed status is still a string. */
type LegacyAccountRecord = Omit<AccountRecord, 'status'> & { status: string };

/**
 * Read a manifest written before #217, which recorded the removed `quarantined` state and a
 * `maxQuarantinedAccounts` budget. The state is read as `retained` and the reason is kept;
 * the removed budget key is dropped so a historical manifest is still writable.
 *
 * The bound is anchored to the record's own `createdAt`, not to the instant it is read, so a
 * historical record states when its run's leftover became late rather than when a later
 * reader noticed it.
 */
function normalizeState(state: AccountBudgetState): AccountBudgetState {
  const accounts = (state.accounts as unknown as LegacyAccountRecord[]).map((account): AccountRecord => {
    if (account.status !== 'quarantined') return account as AccountRecord;
    const { reason, ...rest } = account;
    return {
      ...rest,
      status: 'retained',
      retainedReason: rest.retainedReason ?? reason,
      reconcileBy: rest.reconcileBy ?? new Date(Date.parse(rest.createdAt) + RECONCILE_BOUND_MS).toISOString(),
    };
  });
  const { maxQuarantinedAccounts: _removed, ...config } = state.config as AccountBudgetConfig & { maxQuarantinedAccounts?: number };
  void _removed;
  return { ...state, config, accounts };
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function accountBudgetConfig(workers: number): AccountBudgetConfig {
  // Every attempt of every worker reserves its own lease, so the per-run cap has
  // to cover the retries Playwright may schedule for one test: the suite runs
  // `workers` attempts in parallel and up to three attempts (initial + two
  // retries) per test slot.
  const config = {
    maxActiveAccounts: positiveInteger('E2E_MAX_ACTIVE_ACCOUNTS', workers),
    maxNewAccountsPerRun: positiveInteger('E2E_MAX_NEW_ACCOUNTS_PER_RUN', workers * 3),
  };
  if (config.maxActiveAccounts < workers) {
    throw new Error('E2E_MAX_ACTIVE_ACCOUNTS must be at least E2E_WORKERS');
  }
  if (config.maxNewAccountsPerRun < config.maxActiveAccounts) {
    throw new Error('E2E_MAX_NEW_ACCOUNTS_PER_RUN must be at least E2E_MAX_ACTIVE_ACCOUNTS');
  }
  return config;
}

function budgetPath(): string {
  return process.env.E2E_ACCOUNT_BUDGET_PATH
    ?? path.join(process.cwd(), 'test-results', 'account-budget.json');
}

function configuredWorkers(): number {
  const value = Number(process.env.E2E_WORKERS ?? 1);
  if (!Number.isInteger(value) || value < 1 || value > 8) {
    throw new Error('E2E_WORKERS must be an integer between 1 and 8');
  }
  return value;
}

export function accountRunScope(): string {
  return process.env.E2E_ACCOUNT_RUN_SCOPE
    ?? (process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}-0000000000000000`
      : `local-${process.pid}`);
}

function now(): string {
  return new Date().toISOString();
}

async function acquireLock(lockPath: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  await mkdir(path.dirname(lockPath), { recursive: true });
  while (Date.now() < deadline) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: now() }));
      await handle.close();
      return;
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      try {
        const lock = await stat(lockPath);
        if (Date.now() - lock.mtimeMs > 10 * 60_000) await rm(lockPath, { force: true });
      } catch (statError: unknown) {
        if (!(statError instanceof Error) || !('code' in statError) || statError.code !== 'ENOENT') throw statError;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timed out waiting for account budget lock: ${lockPath}`);
}

async function withLockedState<T>(operation: (state: AccountBudgetState) => Promise<T>): Promise<T> {
  const filePath = budgetPath();
  const lockPath = `${filePath}.lock`;
  await acquireLock(lockPath);
  try {
    let state: AccountBudgetState;
    try {
      state = normalizeState(JSON.parse(await readFile(filePath, 'utf8')) as AccountBudgetState);
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      state = { version: 1, runScope: accountRunScope(), config: accountBudgetConfig(configuredWorkers()), accounts: [] };
    }
    const expectedConfig = accountBudgetConfig(configuredWorkers());
    if (state.runScope !== accountRunScope()) {
      throw new Error('E2E account budget manifest belongs to a different run');
    }
    if (JSON.stringify(state.config) !== JSON.stringify(expectedConfig)) {
      throw new Error('E2E account budget configuration changed during a run');
    }
    const result = await operation(state);
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, filePath);
    return result;
  } finally {
    await rm(lockPath, { force: true });
  }
}

function activeCount(state: AccountBudgetState): number {
  return state.accounts.filter((account) => ACTIVE_STATUSES.has(account.status)).length;
}

function newAccountCount(state: AccountBudgetState): number {
  return state.accounts.length;
}

function latestAccountRecord(state: AccountBudgetState, email: string): AccountRecord | undefined {
  for (let index = state.accounts.length - 1; index >= 0; index -= 1) {
    const account = state.accounts[index];
    if (account.email === email) return account;
  }
  return undefined;
}

/**
 * The generation guard's refusal, named so a retry of a held or retained slot
 * reports what happened instead of a bare collision.
 *
 * The guard itself is unchanged: an active record with a foreign generation is
 * still refused, nothing is written, and the message text is byte-for-byte the
 * same so existing evidence, log comparisons and Beta-log reading stay
 * comparable. The diagnosis lives in the error's identity and its structured
 * fields; `reason` is the refused record's own recorded retention reason, already
 * sanitized and bounded by `retainAccount`.
 */
export class AccountLeaseRefusalError extends Error {
  readonly code = 'E2E_ACCOUNT_LEASE_REFUSED';
  readonly email: string;
  readonly leaseGeneration: string;
  readonly reason?: string;

  constructor(email: string, leaseGeneration: string, reason?: string) {
    super(`Account already has an active lease: ${email}`);
    this.name = 'AccountLeaseRefusalError';
    this.email = email;
    this.leaseGeneration = leaseGeneration;
    if (reason) this.reason = reason;
  }
}

export async function reserveAccount(
  email: string,
  mode: AccountMode,
  leaseGeneration: string,
): Promise<void> {
  // Beta registration admits only allowlisted addresses, so a worker lease may
  // only be taken for one of the eight pool rows. The guard is here, before any
  // identity exists, so a depleted or retained pool fails with this budget
  // error instead of an attempt minting an address the allowlist never lists.
  if (mode === 'worker' && !STABLE_WORKER_EMAIL_PATTERN.test(email)) {
    throw new Error(`E2E account budget leases only the eight Beta worker-pool addresses: ${email}`);
  }
  await withLockedState(async (state) => {
    const existing = latestAccountRecord(state, email);
    if (existing && existing.status !== 'deleted') {
      if (existing.leaseGeneration !== leaseGeneration) {
        throw new AccountLeaseRefusalError(email, existing.leaseGeneration, existing.retainedReason ?? existing.reason);
      }
      return;
    }
    if (activeCount(state) >= state.config.maxActiveAccounts) {
      throw new Error('E2E active account budget exhausted; a retained address is resolved by the reconcile operation');
    }
    if (newAccountCount(state) >= state.config.maxNewAccountsPerRun) {
      throw new Error('E2E new-account budget exhausted; deletion does not restore this quota');
    }
    const timestamp = now();
    state.accounts.push({
      email,
      mode,
      status: 'provisioning',
      leaseId: randomUUID(),
      leaseGeneration,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  });
}

export async function markAccountInUse(email: string): Promise<void> {
  await withLockedState(async (state) => {
    const account = latestAccountRecord(state, email);
    if (!account || account.status === 'deleted') throw new Error(`Unknown E2E account lease: ${email}`);
    account.status = 'in_use';
    account.updatedAt = now();
  });
}

export async function recordAccountSubject(email: string, subject: string): Promise<void> {
  await withLockedState(async (state) => {
    const account = latestAccountRecord(state, email);
    if (!account || account.status === 'deleted') throw new Error(`Unknown E2E account lease: ${email}`);
    if (account.subject && account.subject !== subject) {
      throw new Error(`E2E account subject changed for ${email}`);
    }
    account.subject = subject;
    account.updatedAt = now();
  });
}

export async function markAccountCleanupPending(email: string): Promise<void> {
  await withLockedState(async (state) => {
    const account = latestAccountRecord(state, email);
    if (!account || account.status === 'deleted') return;
    account.status = 'cleanup_pending';
    account.updatedAt = now();
  });
}

export async function markAccountDeleted(email: string): Promise<void> {
  await withLockedState(async (state) => {
    const account = latestAccountRecord(state, email);
    if (!account) return;
    account.status = 'deleted';
    account.updatedAt = now();
  });
}

/**
 * Terminal transition for one verified worker attempt.
 *
 * `deleted` is the only status `reserveAccount` may supersede, so this write — and only
 * this write — returns a pool address to the pool for the next attempt's fresh lease
 * generation. It is reachable only after the attempt's exact identity was deleted and its
 * absence was read back. A retained scope is not released here: its identity is still
 * present, and the reconcile operation is what resolves it and marks it `deleted`.
 */
export async function releaseWorkerAccount(
  email: string,
  reason = 'released after verified identity absence',
): Promise<void> {
  await withLockedState(async (state) => {
    const account = latestAccountRecord(state, email);
    if (!account) return;
    if (account.status === 'retained') {
      throw new Error(`Account scope is retained pending reconcile and cannot be released: ${email}`);
    }
    account.status = 'deleted';
    account.reason = reason;
    account.updatedAt = now();
  });
}

/**
 * Keeps the address out of the pool with a bounded, sanitized reason and the instant the
 * reconciler must have resolved it by (#217).
 *
 * There is no capacity budget: the bound is time, not pool size, so a retained scope can never
 * exhaust a budget that would need an operator to clear. The bound is anchored to this
 * record's own `createdAt` — when the creating run made the identity — not to the instant of
 * this write, so it states when that run's leftover became late. The run that produced the
 * retention still fails its own teardown gate; the reconcile operation resolves the scope and
 * writes `deleted`, which is what returns the address to the pool.
 */
export async function retainAccount(email: string, reason: string): Promise<void> {
  await withLockedState(async (state) => {
    const account = latestAccountRecord(state, email);
    if (!account || account.status === 'deleted') return;
    account.status = 'retained';
    account.retainedReason = reason;
    account.reconcileBy = new Date(Date.parse(account.createdAt) + RECONCILE_BOUND_MS).toISOString();
    account.updatedAt = now();
  });
}

/**
 * Retain exactly one captured identity that a cleanup attempted (#287).
 *
 * `retainAccount` resolves the latest record by email, which for a reused pool address can be a
 * newer lease than the one whose identity the cleanup was asked to delete: the older record
 * would stay `cleanup_pending` and the newer, live lease would be retained under a reason that
 * belongs to a different attempt. This write resolves by the captured pair instead — the pool
 * address **and** the Cognito subject the request bound — so it can only land on the record of
 * the identity that was actually attempted.
 *
 * The bound is anchored to that record's own `createdAt`, never to the instant of this write, so
 * it states when the creating run's leftover became late. A `deleted` record is never
 * resurrected; a record that cannot be found — a lease that captured no identity — is left
 * untouched and reported as not written, so "created and not deleted" stays distinguishable
 * from "never created". Returns whether a record was written.
 */
export async function retainAttemptedAccount(
  identity: { email: string; subject?: string },
  reason: string,
): Promise<boolean> {
  if (typeof identity?.email !== 'string' || typeof identity?.subject !== 'string') return false;
  const subject = identity.subject.toLowerCase();
  let written = false;
  await withLockedState(async (state) => {
    const account = attemptedAccountRecord(state, identity.email, subject);
    if (!account) return;
    account.status = 'retained';
    account.retainedReason = reason;
    account.reconcileBy = new Date(Date.parse(account.createdAt) + RECONCILE_BOUND_MS).toISOString();
    account.updatedAt = now();
    written = true;
  });
  return written;
}

/**
 * The record of one attempted identity: the newest entry for the captured address **and** the
 * captured subject. A subject guard is what makes a reused pool address safe — the newer lease
 * carries a different subject and is never selected.
 */
function attemptedAccountRecord(state: AccountBudgetState, email: string, subject: string): AccountRecord | undefined {
  for (let index = state.accounts.length - 1; index >= 0; index -= 1) {
    const account = state.accounts[index];
    if (account.email !== email) continue;
    if (typeof account.subject !== 'string' || account.subject.toLowerCase() !== subject) continue;
    if (account.status === 'deleted') return undefined;
    return account;
  }
  return undefined;
}
