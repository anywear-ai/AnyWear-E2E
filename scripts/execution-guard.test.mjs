import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertE2EExecution, E2E_OPERATIONS, qualificationSessionName } from './execution-guard.mjs';
// `package.json` is outside this change's scope (#266 E1), so the new evidence-contract
// tests are registered through this already-registered core test file instead of by
// editing the `test:core` list.
import './evidence-contract.test.mjs';

// #217: attribution follows the creator, so the guard is what makes every identity's creator
// nameable. A credential step that assumed the qualification role under any other session
// could create an identity no reconcile can attribute, so the guard refuses it before the
// first AWS call.
const SHA = 'a'.repeat(40);
const SERVICE_SHA = 'b'.repeat(40);
const RUN_ID = '39985391384';
const ATTEMPT = '2';

function environment(overrides = {}) {
  return {
    GITHUB_REPOSITORY: 'anywear-ai/AnyWear-E2E',
    GITHUB_REPOSITORY_ID: '1317091305',
    GITHUB_REPOSITORY_OWNER: 'anywear-ai',
    GITHUB_REPOSITORY_OWNER_ID: '352675702',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    E2E_STAGE: 'beta',
    ENABLE_BETA_MUTATION: 'true',
    E2E_OPERATION: 'reconcile',
    GITHUB_SHA: SHA,
    GITHUB_WORKFLOW_SHA: SHA,
    GITHUB_WORKFLOW_REF: 'anywear-ai/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main',
    GITHUB_RUN_ID: RUN_ID,
    GITHUB_RUN_ATTEMPT: ATTEMPT,
    AWS_ACCOUNT_ID: '650880818323',
    AWS_REGION: 'ap-east-1',
    E2E_CLEANUP_SERVICE_SHA: SERVICE_SHA,
    E2E_AWS_ACCOUNT: '650880818323',
    E2E_AWS_PRINCIPAL_ARN: `arn:aws:sts::650880818323:assumed-role/beta-e2e-qualification-role/e2e-${RUN_ID}-${ATTEMPT}`,
    ...overrides,
  };
}

const sourceSha = { sourceSha: SHA };

test('the credential session names the run and attempt that created each identity', () => {
  assert.equal(qualificationSessionName(environment()), `e2e-${RUN_ID}-${ATTEMPT}`);
  assert.equal(assertE2EExecution(environment(), sourceSha), true);
  // Every operation that can create or delete an identity is covered by the same guard.
  for (const operation of E2E_OPERATIONS) {
    assert.equal(assertE2EExecution(environment({ E2E_OPERATION: operation }), sourceSha), true, operation);
  }
});

test('the guard refuses an authenticated principal under a different role session', () => {
  const different = [
    // The action's default session name: no run, no attribution.
    'arn:aws:sts::650880818323:assumed-role/beta-e2e-qualification-role/GitHubActions',
    // Another run's session: the identity would be attributed to that run.
    'arn:aws:sts::650880818323:assumed-role/beta-e2e-qualification-role/e2e-39985391384-1',
    // Another attempt.
    'arn:aws:sts::650880818323:assumed-role/beta-e2e-qualification-role/e2e-39985391384-3',
    // The role itself, not an assumed-role session.
    'arn:aws:iam::650880818323:role/beta-e2e-qualification-role',
    // A suffix that only ends with the session name after a different role.
    `arn:aws:sts::650880818323:assumed-role/other-role/e2e-${RUN_ID}-${ATTEMPT}`,
    '',
  ];
  for (const arn of different) {
    assert.throws(() => assertE2EExecution(environment({ E2E_AWS_PRINCIPAL_ARN: arn }), sourceSha), /Authenticated dedicated E2E principal required/, arn);
  }
  // The account is part of the proof: a principal ARN alone cannot name another account.
  assert.throws(() => assertE2EExecution(environment({ E2E_AWS_ACCOUNT: '111111111111' }), sourceSha), /Authenticated dedicated E2E principal required/);
});

test('the source-only gate still requires the protected dispatch and the exact source', () => {
  // The credential-free preflight runs before any AWS credential, so it does not assert one.
  assert.equal(assertE2EExecution(environment({ E2E_AWS_PRINCIPAL_ARN: undefined, E2E_AWS_ACCOUNT: undefined }), { ...sourceSha, sourceOnly: true }), true);
  assert.throws(() => assertE2EExecution(environment({ GITHUB_REF: 'refs/heads/issue/217-reconcile' }), sourceSha), /protected main Beta repository/);
  assert.throws(() => assertE2EExecution(environment({ GITHUB_EVENT_NAME: 'schedule' }), sourceSha), /protected main Beta repository/);
  assert.throws(() => assertE2EExecution(environment({ E2E_OPERATION: 'made-up' }), sourceSha), /explicit qualification operation/);
  assert.throws(() => assertE2EExecution(environment(), { sourceSha: 'c'.repeat(40) }), /checkout does not match/);
  assert.throws(() => assertE2EExecution(environment({ GITHUB_RUN_ATTEMPT: '0' }), sourceSha), /Invalid E2E run\/attempt identity/);
});

// #266: the transfer changes the owner half of the run identity and keeps the repository's
// numeric id. The guard identifies the protected repository by that id alone, so the same
// run shape is accepted before and after the transfer, and the workflow ref is matched
// against the run's own GITHUB_REPOSITORY.
test('the guard accepts the protected E2E repository under either owner across the transfer window', () => {
  assert.equal(assertE2EExecution(environment(), sourceSha), true);
  // The pre-transfer identity: the old owner login and owner id with the unchanged E2E
  // repository id. This is the run the dual-subject trust of step 8 must keep working.
  assert.equal(assertE2EExecution(environment({
    GITHUB_REPOSITORY: 'git-malu/AnyWear-E2E',
    GITHUB_REPOSITORY_OWNER: 'git-malu',
    GITHUB_REPOSITORY_OWNER_ID: '11473072',
    GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main',
  }), sourceSha), true);
});

test('the guard still refuses a foreign repository id or a workflow ref for another repository or workflow', () => {
  // The Infra repository id is not the protected E2E repository, whichever owner names it.
  assert.throws(() => assertE2EExecution(environment({ GITHUB_REPOSITORY_ID: '1409047265' }), sourceSha),
    /protected main Beta repository/);
  assert.throws(() => assertE2EExecution(environment({ GITHUB_REPOSITORY_ID: undefined }), sourceSha),
    /protected main Beta repository/);
  // The workflow ref must name the repository the run reports and the entry the operation
  // maps to: another repository and another workflow file are both refused.
  assert.throws(() => assertE2EExecution(environment({
    GITHUB_WORKFLOW_REF: 'other/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main',
  }), sourceSha), /protected workflow\/source/);
  assert.throws(() => assertE2EExecution(environment({
    GITHUB_WORKFLOW_REF: 'anywear-ai/AnyWear-E2E/.github/workflows/integration.yml@refs/heads/main',
  }), sourceSha), /protected workflow\/source/);
});

test('the guard no longer depends on the owner login or the owner id', () => {
  // Nothing reads these variables any more, so an absent or foreign value cannot refuse a
  // run whose repository id is the protected one. This is the whole point of the id-only
  // clause: no run in the transfer window has to carry a particular owner value.
  for (const patch of [
    { GITHUB_REPOSITORY_OWNER: undefined, GITHUB_REPOSITORY_OWNER_ID: undefined },
    { GITHUB_REPOSITORY_OWNER: 'foreign', GITHUB_REPOSITORY_OWNER_ID: '1' },
    { GITHUB_REPOSITORY_OWNER: 'git-malu', GITHUB_REPOSITORY_OWNER_ID: '11473072' },
  ]) {
    assert.equal(assertE2EExecution(environment(patch), sourceSha), true, JSON.stringify(patch));
  }
});
