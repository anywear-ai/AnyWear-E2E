import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { validateBetaAdmissionPolicy, verifyBetaAdmissionEligibility } from './beta-admission-eligibility.mjs';

const sourceSha = 'a'.repeat(40);
// The eight stable Beta worker-pool rows (issue #213). A qualification run with two
// workers and offset 0 leases rows 0 and 1.
const pool = Array.from({ length: 8 }, (_, slot) => `e2e-beta-worker-${slot}-chromium@anywear.local`);
const required = (offset = 0) => [pool[offset], pool[offset + 1]];
const human = 'human@example.com';

function environment(patch = {}) {
  return {
    GITHUB_REPOSITORY: 'anywear-ai/AnyWear-E2E', GITHUB_REPOSITORY_ID: '1317091305',
    GITHUB_REPOSITORY_OWNER: 'anywear-ai', GITHUB_REPOSITORY_OWNER_ID: '352675702',
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_SHA: sourceSha, GITHUB_WORKFLOW_SHA: sourceSha,
    GITHUB_WORKFLOW_REF: 'anywear-ai/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main',
    GITHUB_RUN_ID: '123456789', GITHUB_RUN_ATTEMPT: '1',
    E2E_STAGE: 'beta', ENABLE_BETA_MUTATION: 'true', E2E_WORKERS: '2', E2E_OPERATION: 'full',
    E2E_CLEANUP_SERVICE_SHA: 'b'.repeat(40),
    AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', E2E_AWS_ACCOUNT: '650880818323',
    E2E_AWS_PRINCIPAL_ARN: 'arn:aws:sts::650880818323:assumed-role/beta-e2e-qualification-role/e2e-123456789-1',
    ...patch,
  };
}

function response({ testers = [...required(), human], value } = {}) {
  return {
    Parameter: {
      Name: '/anywear/beta/tester_allowlist',
      Type: 'String',
      Value: value ?? JSON.stringify(testers),
      Version: 7,
    },
  };
}

function reader(payload = JSON.stringify(response())) {
  const calls = [];
  return {
    calls,
    execute(command, args, options) {
      calls.push({ command, args, options });
      if (payload instanceof Error) throw payload;
      return payload;
    },
  };
}

test('the pre-flight reads only the tester allowlist under the dedicated guarded executor', () => {
  const input = environment();
  const io = reader(JSON.stringify(response({ testers: [...required(), human] })));
  assert.deepEqual(verifyBetaAdmissionEligibility(input, { execute: io.execute, sourceSha }), {
    versions: { tester_allowlist: 7 },
  });
  assert.deepEqual(io.calls, [{ command: 'aws', args: [
    'ssm', 'get-parameter', '--name', '/anywear/beta/tester_allowlist',
    '--region', 'ap-east-1', '--output', 'json', '--no-cli-pager',
  ], options: { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], env: input } }]);
});

// #266: the qualification workflow ref is owner-relative. The same protected entry is
// accepted from either owner during the transfer window, and any other workflow file is
// refused even in the right repository.
test('the qualification workflow ref is owner-relative across the transfer window', () => {
  for (const [repository, login, id] of [
    ['anywear-ai/AnyWear-E2E', 'anywear-ai', '352675702'],
    ['git-malu/AnyWear-E2E', 'git-malu', '11473072'],
  ]) {
    const io = reader();
    assert.deepEqual(verifyBetaAdmissionEligibility(environment({
      GITHUB_REPOSITORY: repository,
      GITHUB_REPOSITORY_OWNER: login,
      GITHUB_REPOSITORY_OWNER_ID: id,
      GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/beta-qualification.yml@refs/heads/main`,
    }), { execute: io.execute, sourceSha }), { versions: { tester_allowlist: 7 } }, repository);
  }
  for (const [patch, workflowRef] of [
    [{ GITHUB_REPOSITORY: 'anywear-ai/AnyWear-E2E' }, 'anywear-ai/AnyWear-E2E/.github/workflows/integration.yml@refs/heads/main'],
    [{ GITHUB_REPOSITORY: 'anywear-ai/AnyWear-E2E' }, 'anywear-ai/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/candidate'],
    [{ GITHUB_REPOSITORY: 'git-malu/AnyWear-E2E' }, 'anywear-ai/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main'],
  ]) {
    const io = reader();
    assert.throws(() => verifyBetaAdmissionEligibility(environment({ ...patch, GITHUB_WORKFLOW_REF: workflowRef }),
      { execute: io.execute, sourceSha }), /protected workflow\/source/, workflowRef);
    assert.deepEqual(io.calls, [], 'the refusal happens before any SSM read');
  }
});

test('the required addresses follow the run\'s worker slot offset', () => {
  // Offset 2 leases rows 2 and 3, so rows 0 and 1 need not be listed.
  const io = reader(JSON.stringify(response({ testers: [...required(2)] })));
  assert.doesNotThrow(() => verifyBetaAdmissionEligibility(environment({ E2E_WORKER_SLOT_OFFSET: '2' }), { execute: io.execute, sourceSha }));
  // With offset 2, a list holding only rows 0 and 1 is refused.
  const missing = reader(JSON.stringify(response({ testers: [...required(0)] })));
  assert.throws(() => verifyBetaAdmissionEligibility(environment({ E2E_WORKER_SLOT_OFFSET: '2' }), { execute: missing.execute, sourceSha }),
    /missing .*worker-2-chromium@anywear\.local, .*worker-3-chromium@anywear\.local/);
});

test('missing or foreign dedicated identity and untrusted dispatch fail before any cloud access', () => {
  for (const patch of [
    { E2E_AWS_ACCOUNT: undefined }, { E2E_AWS_ACCOUNT: '111111111111' },
    { E2E_AWS_PRINCIPAL_ARN: undefined },
    { E2E_AWS_PRINCIPAL_ARN: 'arn:aws:sts::650880818323:assumed-role/beta-infra-deployment-role/fixture' },
    { E2E_AWS_PRINCIPAL_ARN: 'arn:aws:iam::650880818323:user/local-admin' },
    { GITHUB_REPOSITORY: 'foreign/AnyWear-E2E' }, { GITHUB_REPOSITORY_ID: '1' },
    { GITHUB_REF: 'refs/heads/candidate' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_WORKFLOW_SHA: 'c'.repeat(40) },
    { GITHUB_WORKFLOW_REF: 'anywear-ai/AnyWear-E2E/.github/workflows/integration.yml@refs/heads/main' },
    { E2E_STAGE: 'dev' }, { ENABLE_BETA_MUTATION: 'false' },
    { E2E_OPERATION: undefined }, { E2E_OPERATION: 'observe' },
    { AWS_ACCOUNT_ID: '111111111111' }, { AWS_REGION: 'us-east-1' },
    { E2E_CLEANUP_SERVICE_SHA: undefined }, { GITHUB_RUN_ID: undefined },
  ]) {
    const io = reader();
    assert.throws(() => verifyBetaAdmissionEligibility(environment(patch), { execute: io.execute, sourceSha }));
    assert.deepEqual(io.calls, [], JSON.stringify(patch));
  }
  const io = reader();
  assert.throws(() => verifyBetaAdmissionEligibility(environment(), { execute: io.execute, sourceSha: 'c'.repeat(40) }), /checkout/);
  assert.deepEqual(io.calls, []);
});

test('the qualification requires exactly two workers and a valid offset before any SSM read', () => {
  for (const E2E_WORKERS of [undefined, '', '1', '3', '02', '2.0']) {
    const io = reader();
    assert.throws(() => verifyBetaAdmissionEligibility(environment({ E2E_WORKERS }), { execute: io.execute, sourceSha }), /exactly 2 workers/);
    assert.deepEqual(io.calls, []);
  }
  // An offset that cannot fit two workers inside the eight-slot pool refuses before the
  // read, so an out-of-range value can never select an address the pool does not list.
  for (const offset of ['7', '8', '-1', '1.5', '02', 'x']) {
    const io = reader();
    assert.throws(() => verifyBetaAdmissionEligibility(environment({ E2E_WORKER_SLOT_OFFSET: offset }), { execute: io.execute, sourceSha }), /SLOT_OFFSET/);
    assert.deepEqual(io.calls, []);
  }
  // The retired single-slot `measure` operation is no longer an accepted operation, so it
  // is refused by the execution guard before any admission read.
  for (const E2E_OPERATION of ['measure', 'instrumentation', 'observe']) {
    const io = reader();
    assert.throws(() => verifyBetaAdmissionEligibility(environment({ E2E_OPERATION, E2E_WORKERS: '1' }), { execute: io.execute, sourceSha }));
    assert.deepEqual(io.calls, []);
  }
});

test('every pool address this run can lease must be an exact member of the allowlist', () => {
  for (const [testers, pattern] of [
    [[], /missing e2e-beta-worker-0-chromium@anywear\.local, e2e-beta-worker-1-chromium@anywear\.local/],
    [[pool[0]], /missing e2e-beta-worker-1-chromium@anywear\.local/],
    [[pool[1]], /missing e2e-beta-worker-0-chromium@anywear\.local/],
    [[human, ...pool.slice(0, 1)], /worker-1-chromium/],
    // The stable family is exact: a canonical near-miss is not a member.
    [[pool[0], 'e2e-beta-worker-01-chromium@anywear.local'], /worker-1-chromium/],
    [[pool[0], 'e2e-beta-worker-1-chromium@anywear.local.evil.example'], /worker-1-chromium/],
  ]) {
    assert.throws(() => validateBetaAdmissionPolicy(response({ testers }), required()), pattern, JSON.stringify(testers));
  }
  // A list of the whole pool still passes with unrelated human testers beside it.
  assert.doesNotThrow(() => validateBetaAdmissionPolicy(response({ testers: [...pool, human] }), required(0)));
  assert.doesNotThrow(() => validateBetaAdmissionPolicy(response({ testers: [human, ...required()] }), required()));
  // The caller must name the addresses it is proving; an empty requirement proves nothing.
  assert.throws(() => validateBetaAdmissionPolicy(response(), []), /at least one leaseable/);
});

test('the allowlist shape, normalization and canonical bytes are enforced', () => {
  const invalid = [
    ['not json', /malformed tester allowlist JSON/],
    ['[', /malformed tester allowlist JSON/],
    ['{} trailing', /malformed tester allowlist JSON/],
    ['{"x":1}', /valid tester email list/],
    ['null', /valid tester email list/],
    ['{}', /valid tester email list/],
    ['"email"', /valid tester email list/],
    [JSON.stringify([...required(), null]), /valid tester email list/],
    [JSON.stringify([...required(), 1]), /valid tester email list/],
    [JSON.stringify([...required(), '']), /canonical unique tester emails/],
    [JSON.stringify([...required(), 'not-an-email']), /canonical unique tester emails/],
    [JSON.stringify([...required(), 'human*@example.com']), /canonical unique tester emails/],
    [JSON.stringify([...required(), 'human@example-.com']), /canonical unique tester emails/],
    [JSON.stringify([...required(), `${'a'.repeat(250)}@example.com`]), /canonical unique tester emails/],
    [JSON.stringify([...required(), human, human]), /canonical unique tester emails/],
    [JSON.stringify([...required(), ` ${human.toUpperCase()} `]), /canonical unique tester emails/],
    [JSON.stringify([...required(), human.toUpperCase()]), /canonical unique tester emails/],
    [`${JSON.stringify([...required(), human])}\n`, /canonical tester list bytes/],
    [` ${JSON.stringify([...required(), human])}`, /canonical tester list bytes/],
    [JSON.stringify([...required(), human], null, 2), /canonical tester list bytes/],
  ];
  for (const [value, message] of invalid) {
    assert.throws(() => validateBetaAdmissionPolicy(response({ value }), required()), message, value);
  }
  // At most 50 exact emails, each within the SSM value bound.
  const many = Array.from({ length: 48 }, (_, index) => `human${index}@example.com`);
  assert.doesNotThrow(() => validateBetaAdmissionPolicy(response({ testers: [...required(), ...many] }), required()));
  assert.throws(() => validateBetaAdmissionPolicy(response({ testers: [...required(), ...many, 'extra@example.com'] }), required()),
    /valid tester email list/);
  const oversized = Array.from({ length: 50 }, (_, index) => `${String(index).padStart(3, '0')}${'a'.repeat(246)}@example.com`);
  assert.throws(() => validateBetaAdmissionPolicy(response({ testers: oversized }), required()), /malformed tester allowlist parameter|canonical unique/);
});

test('a malformed parameter record never supplies a permissive default', () => {
  const valid = () => response().Parameter;
  for (const patch of [
    { Name: '/anywear/prod/tester_allowlist' }, { Name: undefined },
    { Type: 'SecureString' }, { Type: undefined },
    { Version: undefined }, { Version: 0 }, { Version: 1.5 }, { Version: '7' }, { Version: -1 },
  ]) {
    assert.throws(() => validateBetaAdmissionPolicy({ Parameter: { ...valid(), ...patch } }, required()),
      /malformed tester allowlist parameter/, JSON.stringify(patch));
  }
  for (const responseValue of [null, undefined, {}, { Parameter: null }, { Parameter: {} }, { Parameter: 'x' }]) {
    assert.throws(() => validateBetaAdmissionPolicy(responseValue, required()), /malformed tester allowlist parameter/);
  }
  assert.throws(() => validateBetaAdmissionPolicy(response({ value: 'x'.repeat(4097) }), required()), /malformed tester allowlist parameter/);
  assert.throws(() => validateBetaAdmissionPolicy({ Parameter: { ...valid(), Value: false } }, required()), /malformed tester allowlist parameter/);
});

test('a malformed list or a missing pool address refuses with no account-creation side effect', async () => {
  for (const payload of [
    JSON.stringify(response({ value: 'not json' })),
    JSON.stringify(response({ testers: [pool[0]] })),
    JSON.stringify(response({ testers: [] })),
  ]) {
    const io = reader(payload);
    assert.throws(() => verifyBetaAdmissionEligibility(environment(), { execute: io.execute, sourceSha }));
    // Exactly the one read that establishes the refusal: no Cognito, no account, no
    // mutation. The refusal happens before the fixture exists, not after a partial create.
    assert.equal(io.calls.length, 1);
    assert.deepEqual(io.calls[0].args.slice(0, 2), ['ssm', 'get-parameter']);
    assert.ok(io.calls.every(({ command, args }) => command === 'aws' && args[0] === 'ssm' && args[1] === 'get-parameter'));
  }
  // The pre-flight cannot create an account even accidentally: it imports no identity or
  // account-provisioning module.
  const source = await readFile(new URL('./beta-admission-eligibility.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /cognito|AdminCreateUser|AdminConfirmSignUp|reserveAccount|provisionConfirmedTestAccount/i);
});

test('unavailable or malformed CLI JSON produces a bounded diagnostic without raw output or secrets', () => {
  const sensitive = 'fixture-secret-that-must-not-appear';
  const duplicate = JSON.stringify(response()).replace('"Version":7', '"Version":7,"Version":7');
  for (const payload of [new Error(sensitive), sensitive, '', '{} trailing', duplicate,
    Buffer.from([0xc0, 0xaf]), JSON.stringify({ Parameters: [], InvalidParameters: [] })]) {
    const io = reader(payload);
    let failure;
    try { verifyBetaAdmissionEligibility(environment(), { execute: io.execute, sourceSha }); }
    catch (error) { failure = error; }
    assert.ok(failure);
    assert.match(failure.message, /Beta admission eligibility/);
    assert.doesNotMatch(failure.message, new RegExp(sensitive));
    assert.equal(failure.cause, undefined);
    assert.equal(io.calls.length, 1);
  }
});

test('workflow runs mandatory eligibility after principal verification and before account setup or suite', async () => {
  const workflow = await readFile(new URL('../.github/workflows/beta-qualification.yml', import.meta.url), 'utf8');
  const steps = workflow.split(/\r?\n {6}- name: /).slice(1);
  // #163: one qualify entry carries the deployed operations. `full` is the release gate and
  // `smoke` is the deployed diagnostic; both lease pool accounts, so both prove the
  // allowlist first. `reconcile` creates no account and has no eligibility step.
  for (const operation of ['full', 'smoke']) {
    const job = operation === 'full'
      ? workflow.slice(workflow.indexOf('\n  full:\n'), workflow.indexOf('\n  smoke:\n'))
      : workflow.slice(workflow.indexOf('\n  smoke:\n'), workflow.indexOf('\n  record:\n'));
    const jobSteps = job.split(/\r?\n {6}- name: /).slice(1);
    const eligibility = jobSteps.findIndex((step) => step.startsWith('Require Beta admission eligibility\n')
      || step.startsWith('Require Beta admission eligibility\r\n'));
    assert.ok(eligibility > jobSteps.findIndex((step) => step.startsWith('Verify dedicated E2E principal')), `${operation} verifies its principal first`);
    assert.ok(eligibility < jobSteps.findIndex((step) => step.startsWith(operation === 'full'
      ? 'Run the release-gating business regression suite'
      : 'Run deployed Beta smoke tests')), `${operation} proves eligibility before the suite`);
    assert.match(jobSteps[eligibility], /run: node scripts\/beta-admission-eligibility\.mjs\s*$/);
    assert.doesNotMatch(jobSteps[eligibility], /\bif:|continue-on-error:/);
    assert.match(job, /E2E_WORKERS: 2\r?\n/);
  }
  assert.ok(steps.length > 0);
  // The worker fixture reserves (and so leases a pool address) only after Playwright starts
  // in that later step, and never before the pre-flight has run.
  const fixture = await readFile(new URL('../tests/support/fixtures.ts', import.meta.url), 'utf8');
  assert.ok(fixture.indexOf('await reserveTestAccount(') < fixture.indexOf('await provisionConfirmedTestAccount('));
  // The retired measurement operation left no job, input, script or suite behind.
  for (const retired of [/\bmeasure\b/, /sizing_stage/, /test:instrumentation/, /BETA_SIZING_STAGE/]) {
    assert.ok(!retired.test(workflow), `the workflow must not reference ${retired}`);
  }
});

test('the real CLI exits nonzero for a malformed or incomplete allowlist without external commands or success output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-admission-eligibility-'));
  const callsFile = join(directory, 'calls.jsonl');
  const transport = join(directory, 'transport.mjs');
  const preload = join(directory, 'preload.mjs');
  const execute = promisify(execFile);
  try {
    await writeFile(transport, `
import { appendFileSync } from 'node:fs';
export function execFileSync(command, args) {
  appendFileSync(process.env.TEST_ADMISSION_CALLS, JSON.stringify([command, ...args]) + '\\n');
  if (command === 'git' && args.at(-1) === 'HEAD') return process.env.GITHUB_SHA;
  if (command !== 'aws' || args[0] !== 'ssm' || args[1] !== 'get-parameter') throw new Error('External commands blocked');
  if (process.env.TEST_ADMISSION_UNAVAILABLE === 'true') throw new Error('fixture-secret');
  return process.env.TEST_ADMISSION_RESPONSE;
}
`);
    await writeFile(preload, `
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'node:child_process') return { url: ${JSON.stringify(pathToFileURL(transport).href)}, shortCircuit: true };
  return nextResolve(specifier, context);
} });
globalThis.fetch = async () => { throw new Error('Network blocked'); };
`);
    const isolated = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: directory, TMP: directory,
      NODE_OPTIONS: '', AWS_EC2_METADATA_DISABLED: 'true', ...environment(),
      TEST_ADMISSION_CALLS: callsFile, TEST_ADMISSION_RESPONSE: JSON.stringify(response()) };
    for (const [patch, message] of [
      [{ TEST_ADMISSION_RESPONSE: JSON.stringify(response({ value: 'not json' })) }, /malformed tester allowlist JSON/],
      [{ TEST_ADMISSION_RESPONSE: JSON.stringify(response({ testers: [pool[0]] })) }, /missing e2e-beta-worker-1-chromium@anywear\.local/],
      [{ TEST_ADMISSION_RESPONSE: JSON.stringify(response({ testers: [] })) }, /missing e2e-beta-worker-0-chromium@anywear\.local/],
      [{ TEST_ADMISSION_RESPONSE: JSON.stringify(response({ testers: [...required(), human.toUpperCase()] })) }, /canonical unique tester emails/],
      [{ TEST_ADMISSION_UNAVAILABLE: 'true' }, /could not read valid SSM policy/],
      [{ TEST_ADMISSION_RESPONSE: 'not json' }, /could not read valid SSM policy/],
      [{ E2E_WORKER_SLOT_OFFSET: '7' }, /SLOT_OFFSET/],
      [{ E2E_AWS_PRINCIPAL_ARN: 'arn:aws:iam::650880818323:user/local-admin' }, /dedicated E2E principal/],
    ]) {
      await writeFile(callsFile, '');
      let failure;
      try {
        await execute(process.execPath, ['--import', pathToFileURL(preload).href,
          fileURLToPath(new URL('./beta-admission-eligibility.mjs', import.meta.url))], {
          env: { ...isolated, ...patch }, timeout: 10_000, maxBuffer: 64 * 1024,
        });
      } catch (error) { failure = error; }
      assert.ok(failure, 'An ineligible allowlist must fail the mandatory workflow step');
      assert.equal(failure.code, 1);
      assert.match(failure.stderr, message);
      assert.doesNotMatch(failure.stderr, /fixture-secret|human@example\.com/);
      assert.equal(failure.stdout, '', 'The CLI must not claim eligibility on failure');
      const calls = (await readFile(callsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      assert.ok(calls.every(call => call[0] === 'git' || (call[0] === 'aws' && call[1] === 'ssm' && call[2] === 'get-parameter')));
      assert.equal(calls.filter(call => call[0] === 'aws').length, patch.E2E_AWS_PRINCIPAL_ARN || patch.E2E_WORKER_SLOT_OFFSET ? 0 : 1,
        'a refusal before the read performs no AWS call, and one read otherwise');
    }
    const success = await execute(process.execPath, ['--import', pathToFileURL(preload).href,
      fileURLToPath(new URL('./beta-admission-eligibility.mjs', import.meta.url))], {
      env: isolated, timeout: 10_000, maxBuffer: 64 * 1024,
    });
    assert.match(success.stdout, /^Verified the Beta tester allowlist admits every worker-pool address this run can lease\.$/m);
    assert.doesNotMatch(success.stdout, /human@example\.com|e2e-beta-worker-/);
    assert.equal(success.stderr, '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
