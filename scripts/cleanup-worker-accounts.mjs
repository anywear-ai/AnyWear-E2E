import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { markAccountDeleted, retainAttemptedAccount } from '../tests/support/account-budget.ts';
import { runCleanupOperation } from '../tests/support/service-cleanup-operation.ts';
import { cleanupWorkerAccounts, isAdmittedCleanupWorker, SUBJECT_PATTERN } from '../tests/support/worker-cleanup.ts';
import { cleanupStartGuard } from './cleanup-capability.mjs';
import { assertE2EExecution } from './execution-guard.mjs';
import { parseStrictJson } from './evidence-contract.mjs';

// The ordinary per-run cleanup step of `full` and `smoke` (#217). It transmits the exact
// captured `{runScope, users}` request to the reviewed Service cleanup, deletes only the
// identities whose committed cleanup it can prove, reads their absence back, and marks the
// ledger record `deleted`.
//
// #287: the capability version is the value the job pinned from the deployment, the start
// guard re-checks that pin before every new execution, and a refused or unavailable cleanup is
// a recorded retention — exactly the captured identities this step attempted are marked
// `retained` with the refusal and the 24-hour bound, no attempted record stays
// `cleanup_pending`, a lease that captured no identity is reported as not created, and the step
// still exits non-zero. The `reconcile` operation is what resolves the retention.

const manifestPath = process.env.E2E_ACCOUNT_BUDGET_PATH ?? 'test-results/account-budget.json';

/** The bound the retention reason keeps, matching `retainAttempt` in `worker-cleanup.ts`. */
const MAX_REASON_LENGTH = 300;

async function cognitoIo() {
  const userPoolId = process.env.USER_POOL_ID;
  if (!userPoolId) throw new Error('Missing USER_POOL_ID; Cognito identities were retained');
  const client = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  return {
    async getUser(email) {
      const user = await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
      return { Username: user.Username, UserAttributes: user.UserAttributes };
    },
    async deleteUser(username) {
      assertE2EExecution();
      await client.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username }));
    },
    destroy() { client.destroy(); },
  };
}

/** The captured identities this teardown admitted, which is exactly what it attempted. */
export function attemptedWorkerAccounts(manifest) {
  return manifest.accounts.filter(account => isAdmittedCleanupWorker(account, manifest));
}

/**
 * A worker lease that never captured an identity (#287).
 *
 * Only a lease whose provisioning never completed can state that no identity was created: it
 * never reached `in_use`, and no subject was captured for it. Such a lease is reported as not
 * created and is never written `retained`, so a reader can tell "created and not deleted" from
 * "never created". A lease that claims it was in use without a captured subject is an anomaly,
 * not proof of absence, so it stays in the `skipped` report and fails the step.
 */
export function notCreatedWorkerAccounts(manifest) {
  return manifest.accounts.filter(account => account.mode === 'worker'
    && (account.status === 'reserved' || account.status === 'provisioning')
    && !(typeof account.subject === 'string' && SUBJECT_PATTERN.test(account.subject)));
}

/**
 * The refusal a retention names (#287).
 *
 * The operation throws one generic failure message and keeps the reason in its evidence, so the
 * cause chain is what names the refusal: the transport's typed refusal, the start guard's
 * `CleanupCapabilityRefusal`, or the Service error underneath. The result is sanitized and
 * bounded like every other retention reason.
 */
export function retentionReason(error) {
  const parts = [];
  for (let current = error, depth = 0; current !== undefined && current !== null && depth < 4; depth += 1) {
    if (current instanceof Error) parts.push(`${current.name}: ${current.message}`);
    else parts.push(String(current));
    current = current.cause;
  }
  return `service cleanup refused; ${parts.join(' <- ')}`.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_LENGTH);
}

/**
 * Mark exactly the captured records the cleanup attempted `retained` (#287).
 *
 * The write is subject-guarded by `retainAttemptedAccount`, so it can never land on a newer
 * lease of a reused pool address. The returned list is what the step reports.
 */
export async function markRefusedWorkerAccounts(manifest, reason) {
  const attempted = attemptedWorkerAccounts(manifest);
  const retained = [];
  for (const account of attempted) {
    const record = { email: account.email, subject: account.subject };
    if (await retainAttemptedAccount(record, reason)) retained.push(account.email);
  }
  return { attempted, retained };
}

/** The teardown failed and its retention is written: the step must still exit non-zero. */
export class WorkerCleanupRetentionError extends Error {
  constructor(error, { retained, notCreated }) {
    super(error instanceof Error ? error.message : String(error));
    this.name = 'WorkerCleanupRetention';
    this.cause = error;
    this.retained = retained;
    this.notCreated = notCreated;
  }
}

export async function runCapturedWorkerCleanup(manifest, environment, io, {
  operation = runCleanupOperation, capabilityIo,
} = {}) {
  const beforeStart = cleanupStartGuard({ environment, io: capabilityIo });
  try {
    return await cleanupWorkerAccounts(manifest, { ...io, runServiceCleanup: async inputs => {
      const result = await operation(inputs, environment, undefined, { beforeStart });
      if (result?.operation?.proof_status !== 'verified') {
        throw new Error('Service cleanup did not prove the committed result; identities retained');
      }
      return true;
    } });
  } catch (error) {
    // A refused teardown is a retention, not a deferral (#287): record every captured identity
    // it attempted before the step fails, so the reconcile operation has a bound to resolve.
    const retention = await markRefusedWorkerAccounts(manifest, retentionReason(error));
    throw new WorkerCleanupRetentionError(error, {
      retained: retention.retained,
      notCreated: notCreatedWorkerAccounts(manifest).map(account => account.email),
    });
  }
}

/**
 * The ledger half of the cleanup: every worker the request admitted reached a verified delete
 * and absence readback, so its record becomes `deleted`. The predicate is the same one the
 * request used, so an unproven retained record is never marked. `markAccountDeleted` rewrites
 * only status and `updatedAt`, which keeps the original retention reason and bound.
 */
export async function markRepairedWorkerAccounts(manifest) {
  const admitted = attemptedWorkerAccounts(manifest);
  for (const account of admitted) await markAccountDeleted(account.email);
  return admitted;
}

/** A worker record the step left non-deleted with a captured identity: neither cleaned nor already deleted. */
export function skippedWorkerAccounts(manifest, admitted) {
  const notCreated = notCreatedWorkerAccounts(manifest);
  return manifest.accounts.filter(account => account.mode === 'worker'
    && account.status !== 'deleted' && !admitted.includes(account) && !notCreated.includes(account));
}

async function main() {
  try {
    assertE2EExecution();
    let manifest;
    try { manifest = parseStrictJson(await readFile(manifestPath)); }
    catch (error) {
      if (error?.code === 'ENOENT') process.exit(0);
      throw error;
    }
    const io = await cognitoIo();
    try {
      const count = await runCapturedWorkerCleanup(manifest, process.env, { ...io }, {
        operation: async (...args) => { assertE2EExecution(); const result = await runCleanupOperation(...args); assertE2EExecution(); return result; },
      });
      const admitted = await markRepairedWorkerAccounts(manifest);
      // A record that is neither cleaned nor already `deleted` was skipped. Report it and
      // fail the step: the identity and its reason stay in the manifest for reconcile.
      const skipped = skippedWorkerAccounts(manifest, admitted);
      process.stdout.write(`Cleaned ${count} exact E2E worker identity record(s).\n`);
      const notCreated = notCreatedWorkerAccounts(manifest).map(account => account.email);
      if (notCreated.length > 0) {
        process.stdout.write(`Reported ${notCreated.length} worker lease(s) as not created: ${notCreated.join(', ')}\n`);
      }
      if (skipped.length > 0) {
        process.stderr.write(`Cleanup left ${skipped.length} worker record(s) non-deleted: ${skipped.map(account => `${account.email} (${account.status})`).join(', ')}\n`);
        process.exitCode = 1;
      }
    } finally {
      io.destroy();
    }
  } catch (error) {
    if (error instanceof WorkerCleanupRetentionError) {
      process.stdout.write(`Retained ${error.retained.length} captured E2E worker identity record(s) for the reconcile operation.\n`);
      if (error.notCreated.length > 0) {
        process.stdout.write(`Reported ${error.notCreated.length} worker lease(s) as not created: ${error.notCreated.join(', ')}\n`);
      }
    }
    console.error(error instanceof Error ? error.message : 'E2E worker cleanup failed; identities were retained');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
