import {
  assertCapturedCognitoAbsence,
  deleteCapturedCognitoIdentity,
  type CapturedIdentity,
  type CognitoCleanupIo,
} from './cognito-cleanup.ts';
import { isBetaWorkerEmailForScope } from './beta-address.ts';
import type { AttemptBusinessCleanupOutcome } from './attempt-cleanup-registry.ts';

export interface WorkerAccountRecord {
  email: string;
  subject?: string;
  mode: 'worker' | 'ephemeral';
  status: string;
}

export interface WorkerAccountManifest {
  version: 1;
  runScope: string;
  accounts: WorkerAccountRecord[];
}

export interface ServiceCleanupInputs {
  action: 'cleanup';
  emails: '[]';
  cleanup_json: string;
}

export interface WorkerCleanupIo extends CognitoCleanupIo {
  // false means the dispatch command could not start a Service workflow. Once
  // dispatch succeeds, failures must reject and keep the lease retained.
  runServiceCleanup(inputs: ServiceCleanupInputs): Promise<boolean | void>;
}

/** Attempt teardown outcome, using the ordinary cleanup operation vocabulary. */
export type WorkerTeardownResult = 'passed' | 'failed' | 'partial';

/**
 * Scope state of one test attempt.
 *
 * `released` is the only state that returns the allowlisted address to the pool; `none`
 * means the attempt never held the lease, so it owns no scope to dispose of and must not
 * touch a record written by another attempt. `retained` keeps the address out of the pool
 * with its identity in place until the `reconcile` operation resolves it (#217).
 */
export type WorkerAttemptScope = 'none' | 'released' | 'retained';

export interface WorkerAttemptTeardown {
  email: string;
  /** Confirmed Cognito subject this attempt captured, when it reached confirmation. */
  subject?: string;
  /** This attempt actually held the ledger lease. */
  reserved: boolean;
  /** Provisioning completed: the attempt's identity is confirmed and owned. */
  provisioned: boolean;
  /**
   * The attempt's own business-cleanup declaration, read from the attempt-keyed
   * registry. Omitted or unreadable means `undeclared`, which fails closed: the
   * attempt's scope is retained with its identity in place rather than
   * released on an assumption.
   */
  businessCleanup?: AttemptBusinessCleanupOutcome;
}

export interface WorkerLeaseDisposition {
  email: string;
  scope: WorkerAttemptScope;
  teardownResult: WorkerTeardownResult;
  reason?: string;
}

export interface WorkerLeaseIo extends CognitoCleanupIo {
  /** Terminal ledger transition; only a verified absence may reach it. */
  releaseWorkerAccount(email: string): Promise<void>;
  /** Keeps the address and its identity for the reconcile operation to resolve. */
  retainWorkerAccount(email: string, reason: string): Promise<void>;
  /**
   * The attempt's business-cleanup declaration. `releaseWorkerLease` passes its
   * own `businessCleanup` input when the caller has one; this reader is the
   * attempt-keyed lookup the fixture wiring uses, and a read failure is reported
   * as `undeclared` so the lease fails closed.
   */
  readAttemptBusinessCleanup?(): AttemptBusinessCleanupOutcome;
}

const MAX_REASON_LENGTH = 300;

function sanitizedReason(reason: string): string {
  return reason.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_LENGTH);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUserNotFound(error: unknown): boolean {
  return error instanceof Error && (error.name === 'UserNotFoundException' || /UserNotFoundException/.test(error.message));
}

async function retainAttempt(
  email: string,
  io: WorkerLeaseIo,
  reason: string,
  teardownResult: Exclude<WorkerTeardownResult, 'passed'>,
): Promise<WorkerLeaseDisposition> {
  const sanitized = sanitizedReason(reason);
  try {
    await io.retainWorkerAccount(email, sanitized);
  } catch (error) {
    // Fail closed either way: the record keeps an active status (so the address
    // stays out of the pool) and the refusal is reported on the teardown gate.
    return {
      email,
      scope: 'retained',
      teardownResult,
      reason: sanitizedReason(`${sanitized}; retained record refused: ${errorMessage(error)}`),
    };
  }
  return { email, scope: 'retained', teardownResult, reason: sanitized };
}

/**
 * Read the attempt's declaration through the injected reader, when the attempt
 * itself did not supply one. An unreadable declaration is `undeclared`, never an
 * implicit release.
 */
function readBusinessCleanup(io: WorkerLeaseIo): AttemptBusinessCleanupOutcome | undefined {
  if (!io.readAttemptBusinessCleanup) return undefined;
  try {
    return io.readAttemptBusinessCleanup();
  } catch {
    return undefined;
  }
}

/**
 * The attempt's business-cleanup decision, read before any identity work.
 *
 * A released lease claims that the attempt is finished with everything it
 * created, so an attempt that cannot show a committed business cleanup is
 * retained instead — with its identity in place. `undeclared` is deliberate:
 * a missing declaration is an anomaly, not proof that the attempt created
 * nothing.
 */
function businessCleanupBlock(
  declaration: AttemptBusinessCleanupOutcome | undefined,
): { reason: string; teardownResult: Exclude<WorkerTeardownResult, 'passed'> } | undefined {
  if (declaration?.state === 'closed' || declaration?.state === 'none') {
    if (declaration.teardownResult === 'passed') return undefined;
    // `none` is the explicit opt-out, so a non-passed declaration is `closed`.
    return {
      reason: 'teardown: business cleanup ' + declaration.teardownResult
        + (declaration.reason ? '; ' + declaration.reason : ''),
      teardownResult: declaration.teardownResult ?? 'failed',
    };
  }
  if (declaration?.state === 'open') {
    return {
      reason: 'teardown: the attempt\'s business cleanup did not commit',
      teardownResult: 'partial',
    };
  }
  return {
    reason: 'teardown: the attempt declared no business-cleanup outcome',
    teardownResult: 'partial',
  };
}

/**
 * Ordinary per-attempt teardown of one worker lease.
 *
 * The attempt's exact confirmed identity is verified against the captured
 * email/subject, deleted through the reviewed captured-identity path, and its
 * absence is then read back. Only a proven absence releases the address, and
 * only a released address may be re-reserved with a fresh lease generation.
 * Every other outcome — a business cleanup that did not commit, a missing or
 * unreadable declaration, refused ownership, deletion failure, an unverified
 * absence, or provisioning that never confirmed ownership — retains this
 * attempt's scope and keeps the address out of the pool. No live identity is
 * ever reported terminal, and this never deletes or releases a record that
 * belongs to another attempt.
 */
export async function releaseWorkerLease(
  attempt: WorkerAttemptTeardown,
  io: WorkerLeaseIo,
): Promise<WorkerLeaseDisposition> {
  if (!attempt.reserved) {
    return { email: attempt.email, scope: 'none', teardownResult: 'passed' };
  }

  // Before any Cognito call: the attempt's own business cleanup decides whether
  // its identity may be disposed of at all. A failure here can only remove a
  // release and add a retention; it never authorizes a delete.
  const businessCleanup = businessCleanupBlock(
    attempt.businessCleanup ?? readBusinessCleanup(io),
  );
  if (businessCleanup) {
    return retainAttempt(attempt.email, io, businessCleanup.reason, businessCleanup.teardownResult);
  }

  const identity: CapturedIdentity | undefined = attempt.provisioned && attempt.subject
    ? { email: attempt.email, sub: attempt.subject }
    : undefined;
  if (!identity) {
    return retainAttempt(attempt.email, io, attempt.provisioned
      ? 'teardown: confirmed Cognito subject was not captured; identity ownership is unverified'
      : 'teardown: provisioning did not complete; identity ownership is unverified', 'failed');
  }

  try {
    await deleteCapturedCognitoIdentity(identity, io);
  } catch (error) {
    return retainAttempt(attempt.email, io, `teardown: captured identity verification or deletion refused: ${errorMessage(error)}`, 'failed');
  }

  // Absence readback: a returned user (the same or a foreign identity) keeps the
  // address out of the pool, and an unreadable state is reported as partial.
  try {
    await io.getUser(identity.email);
    return retainAttempt(attempt.email, io, 'teardown: Cognito identity is still present after deletion', 'failed');
  } catch (error) {
    if (!isUserNotFound(error)) {
      return retainAttempt(attempt.email, io, `teardown: absence readback was uncertain: ${errorMessage(error)}`, 'partial');
    }
  }

  try {
    await io.releaseWorkerAccount(attempt.email);
  } catch (error) {
    return {
      email: attempt.email,
      scope: 'retained',
      teardownResult: 'failed',
      reason: sanitizedReason(`teardown: verified absence could not be released: ${errorMessage(error)}`),
    };
  }
  return { email: attempt.email, scope: 'released', teardownResult: 'passed' };
}

/**
 * Separate attempt teardown gate.
 *
 * The worker fixture raises this after the attempt so a failed teardown fails
 * the run on its own gate. It carries only teardown vocabulary: the product
 * result the attempt already recorded is independent and is never rewritten.
 */
export function workerLeaseGateError(disposition: WorkerLeaseDisposition): Error | undefined {
  if (disposition.scope === 'released' || disposition.scope === 'none') return undefined;
  return new Error(`Worker lease teardown gate failed (${disposition.teardownResult}, ${disposition.scope}): ${disposition.reason ?? 'unknown reason'}`);
}

const RUN_SCOPE_PATTERN = /^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-[a-f0-9]{16}$/;
/**
 * A captured Cognito subject, the immutable identity the cleanup request binds (#287). The
 * teardown reads the same grammar to tell a lease that captured an identity — which may be
 * retained — from one that never created anything.
 */
export const SUBJECT_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/**
 * One eligibility rule for the cleanup request and the ledger transition.
 *
 * A `cleanup_pending` record is the ordinary case. A `retained` record is admitted only
 * when the ownership its retention kept can still be proven: a captured UUID-shaped subject
 * and an address in this manifest's own run scope. An unproven retained record stays out of
 * the list — the validation below is all-or-nothing, so admitting it would throw and block a
 * proven record's cleanup in the same manifest.
 */
export function isAdmittedCleanupWorker(account: WorkerAccountRecord, manifest: WorkerAccountManifest): boolean {
  if (account.mode !== 'worker') return false;
  if (account.status === 'cleanup_pending') return true;
  return account.status === 'retained'
    && typeof account.subject === 'string' && SUBJECT_PATTERN.test(account.subject)
    && isBetaWorkerEmailForScope(account.email, manifest.runScope);
}

export function createServiceCleanupInputs(manifest: WorkerAccountManifest): ServiceCleanupInputs | undefined {
  if (manifest.version !== 1 || !RUN_SCOPE_PATTERN.test(manifest.runScope) || !Array.isArray(manifest.accounts)) {
    throw new Error('E2E worker cleanup requires a valid bounded account manifest');
  }

  const activeWorkers = manifest.accounts.filter((account) => isAdmittedCleanupWorker(account, manifest));
  // This run's scoped addresses, or the stable rows a pre-#129 manifest still
  // names. Either way the address must belong to this manifest's own run scope,
  // so a captured identity can never be cleaned up under another run's request.
  if (activeWorkers.some((account) => !isBetaWorkerEmailForScope(account.email, manifest.runScope)
    || typeof account.subject !== 'string' || !SUBJECT_PATTERN.test(account.subject))) {
    throw new Error('E2E worker cleanup requires captured Beta worker emails and subjects');
  }
  if (activeWorkers.length > 8
    || new Set(activeWorkers.map((account) => account.email)).size !== activeWorkers.length
    || new Set(activeWorkers.map((account) => account.subject?.toLowerCase())).size !== activeWorkers.length) {
    throw new Error('E2E worker cleanup manifest contains duplicate or excessive identities');
  }
  if (activeWorkers.length === 0) return undefined;

  const request = {
    runScope: manifest.runScope,
    users: activeWorkers.map(({ email, subject }) => ({ sub: subject as string, email })),
  };
  const cleanupJson = JSON.stringify(request);
  if (Buffer.byteLength(cleanupJson, 'utf8') > 16_384) {
    throw new Error('E2E worker cleanup payload exceeds the Service limit');
  }

  return { action: 'cleanup', emails: '[]', cleanup_json: cleanupJson };
}

export async function cleanupWorkerAccounts(
  manifest: WorkerAccountManifest,
  io: WorkerCleanupIo,
): Promise<number | undefined> {
  const inputs = createServiceCleanupInputs(manifest);
  if (!inputs) return 0;

  const dispatched = await io.runServiceCleanup(inputs);
  if (dispatched === false) return undefined;
  const identities: CapturedIdentity[] = JSON.parse(inputs.cleanup_json).users;
  // Deletion is not terminal by itself: the identity is only cleared when a fresh
  // read of the captured address proves its absence. A returned identity or an
  // unreadable readback rejects, so the caller never marks the record `deleted`.
  for (const identity of identities) {
    await deleteCapturedCognitoIdentity(identity, io);
    await assertCapturedCognitoAbsence(identity, io);
  }
  return identities.length;
}
