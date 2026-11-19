import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CAPABILITY_VERSION_ENV,
  CleanupCapabilityRefusal,
  REFUSAL_REASONS,
  appendResolutionSummary,
  cleanupStartGuard,
  gateVersionArn,
  liveCapabilityIo,
  readVersionPublication,
  resolveVersionArn,
  runCapabilityCli,
  selectVersionPublication,
} from './cleanup-capability.mjs';
import { CLEANUP_VERSION_ARN } from '../tests/support/service-cleanup-operation.ts';

// #287: the resolver's unit surface. Every fixture below constructs a version ARN as a test
// input; no shipped source, workflow or document carries one.
const ACCOUNT = '650880818323';
const versionArn = (version) => `arn:aws:states:ap-east-1:${ACCOUNT}:stateMachine:beta-anywear-tester-cleanup:${version}`;
const stack = ({ name = 'AnyWearRuntimeStack-beta', status = 'UPDATE_COMPLETE', outputs } = {}) => ({
  StackName: name,
  StackId: `arn:aws:cloudformation:ap-east-1:${ACCOUNT}:stack/${name}/8f1e0c60`,
  StackStatus: status,
  Outputs: outputs ?? [{ OutputKey: 'CleanupOperationCleanupStateMachineVersionArn18053210', OutputValue: versionArn(2) }],
});
const describeStacks = (...rows) => ({ Stacks: rows });
const capabilityIo = (value) => ({
  calls: [],
  async aws(args) {
    this.calls.push(args);
    return typeof value === 'function' ? value(args) : value;
  },
});
const source = readFileSync(new URL('./cleanup-capability.mjs', import.meta.url), 'utf8');

/** Assert one refusal: its closed reason, the value shown, the stack and the grammar. */
async function assertRefusal(promise, { reason, values = [], includes = [] }) {
  const refusal = await promise.then(
    () => assert.fail(`a refusal was expected (${reason})`),
    (error) => error,
  );
  assert.ok(refusal instanceof CleanupCapabilityRefusal, `expected a typed refusal, received ${refusal?.name}`);
  assert.ok(REFUSAL_REASONS.includes(refusal.reason), `refusal reason ${refusal.reason} is outside the closed vocabulary`);
  assert.equal(refusal.reason, reason);
  assert.ok(refusal.message.includes(`(${reason})`), 'the refusal names its reason');
  assert.ok(refusal.message.includes('stack=AnyWearRuntimeStack-beta'), 'the refusal names the stack');
  assert.ok(refusal.message.includes(`grammar=${CLEANUP_VERSION_ARN.source}`), 'the refusal names the grammar it applied');
  for (const value of values) assert.ok(refusal.message.includes(JSON.stringify(value)), `the refusal names the value ${value}`);
  for (const text of includes) assert.ok(refusal.message.includes(text), `the refusal names ${text}`);
  return refusal;
}

test('the version ARN is selected by output value, and a renamed key still selects', () => {
  const publication = selectVersionPublication([stack()]);
  assert.deepEqual(publication, {
    versionArn: versionArn(2),
    stackName: 'AnyWearRuntimeStack-beta',
    outputKey: 'CleanupOperationCleanupStateMachineVersionArn18053210',
  });
  // The output key is CDK-generated and never read: the same value under an unrelated key is
  // still selected, and the reported source follows the value it selected.
  const renamed = selectVersionPublication([stack({ outputs: [
    { OutputKey: 'VpcId', OutputValue: 'vpc-0a1b2c3d4e5f60718' },
    { OutputKey: 'SomethingEntirelyDifferent', OutputValue: versionArn(11) },
  ] })]);
  assert.equal(renamed.versionArn, versionArn(11));
  assert.equal(renamed.outputKey, 'SomethingEntirelyDifferent');
  // Only the exactly-one-value rule can select: a version-shaped value that is not the
  // published one is ignored, never preferred.
  assert.equal(selectVersionPublication([stack({ outputs: [
    { OutputKey: 'StateMachineArn', OutputValue: `arn:aws:states:ap-east-1:${ACCOUNT}:stateMachine:beta-anywear-tester-cleanup` },
    { OutputKey: 'Version', OutputValue: versionArn(3) },
  ] })]).versionArn, versionArn(3));
});

test('every refusal is fail-closed and names the value, the stack and the grammar', async () => {
  // unset: no pinned value at all.
  await assertRefusal(gateVersionArn(undefined, capabilityIo(describeStacks(stack()))), {
    reason: 'unset', includes: ['value=<absent>'],
  });
  await assertRefusal(gateVersionArn('', capabilityIo(describeStacks(stack()))), {
    reason: 'unset', includes: ['value=<absent>'],
  });
  // malformed: the pinned value exists but is not the reviewed grammar.
  for (const malformedValue of [
    `arn:aws:states:ap-east-1:${ACCOUNT}:stateMachine:beta-anywear-tester-cleanup:0`,
    `arn:aws:states:ap-east-1:${ACCOUNT}:stateMachine:beta-anywear-tester-cleanup:07`,
    `arn:aws:states:ap-east-1:${ACCOUNT}:stateMachine:beta-anywear-tester-cleanup:live`,
    'arn:aws:states:ap-east-1:123456789012:stateMachine:beta-anywear-tester-cleanup:2',
    'arn:aws:states:us-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup:2',
    'arn:aws:states:ap-east-1:650880818323:stateMachine:other-cleanup:2',
  ]) {
    await assertRefusal(gateVersionArn(malformedValue, capabilityIo(describeStacks(stack()))), {
      reason: 'malformed', values: [malformedValue],
    });
  }
  // absent: the stack is missing entirely, or publishes no output matching the grammar.
  await assertRefusal(readVersionPublication(capabilityIo(describeStacks())), {
    reason: 'absent', includes: ['value=<absent>'],
  });
  await assertRefusal(readVersionPublication(capabilityIo(describeStacks(stack({ name: 'AnyWearPlatformStack-beta' })))), {
    reason: 'absent', includes: ['observed stacks: AnyWearPlatformStack-beta'],
  });
  await assertRefusal(readVersionPublication(capabilityIo(describeStacks(stack({ outputs: [
    { OutputKey: 'StateMachineArn', OutputValue: 'not-a-version-arn' },
  ] })))), {
    reason: 'absent', includes: ['value=<absent>', 'observed output keys: StateMachineArn'],
  });
  // in-flight: a deployment mid-update cannot state which version it publishes.
  for (const status of ['UPDATE_IN_PROGRESS', 'CREATE_IN_PROGRESS', 'UPDATE_ROLLBACK_COMPLETE', 'DELETE_COMPLETE']) {
    await assertRefusal(readVersionPublication(capabilityIo(describeStacks(stack({ status })))), {
      reason: 'in-flight', includes: [status, 'value=<absent>'],
    });
  }
  // ambiguous: two published values match, or the one publisher answered twice.
  await assertRefusal(readVersionPublication(capabilityIo(describeStacks(stack({ outputs: [
    { OutputKey: 'A', OutputValue: versionArn(2) },
    { OutputKey: 'B', OutputValue: versionArn(3) },
  ] })))), { reason: 'ambiguous', values: [versionArn(2), versionArn(3)] });
  await assertRefusal(readVersionPublication(capabilityIo(describeStacks(stack(), stack()))), {
    reason: 'ambiguous',
  });
  // drift: the pinned value is not the one the stack publishes now, and both are named.
  await assertRefusal(gateVersionArn(versionArn(7), capabilityIo(describeStacks(stack()))), {
    reason: 'drift', values: [versionArn(7), versionArn(2)],
  });
  // malformed on the published side is decided by the value alone: a value that names a state
  // machine but fails the grammar is refused as malformed, never silently treated as absent.
  const publishedMalformed = `arn:aws:states:ap-east-1:${ACCOUNT}:stateMachine:beta-anywear-tester-cleanup:0`;
  await assertRefusal(readVersionPublication(capabilityIo(describeStacks(stack({ outputs: [
    { OutputKey: 'AnUnrelatedName', OutputValue: publishedMalformed },
  ] })))), { reason: 'malformed', values: [publishedMalformed] });
});

test('a gate refusal prints both ARNs to stderr and exits non-zero without a stdout value', async () => {
  const stdout = [];
  const stderr = [];
  const exit = await runCapabilityCli(['gate'], {
    environment: { [CAPABILITY_VERSION_ENV]: versionArn(7) },
    io: capabilityIo(describeStacks(stack())),
    write: (text) => stdout.push(text),
    writeError: (text) => stderr.push(text),
  });
  assert.equal(exit, 1);
  assert.deepEqual(stdout, [], 'a refused gate prints no value a caller could capture');
  const message = stderr.join('');
  assert.ok(message.includes(versionArn(7)), 'the refusal names the pinned value');
  assert.ok(message.includes(versionArn(2)), 'the refusal names the value the stack publishes now');
  assert.ok(message.includes('(drift)'));
  assert.ok(message.includes('AnyWearRuntimeStack-beta'));

  // The same command on the matching pin succeeds and states what it compared.
  const acceptedStdout = [];
  assert.equal(await runCapabilityCli(['gate'], {
    environment: { [CAPABILITY_VERSION_ENV]: versionArn(2) },
    io: capabilityIo(describeStacks(stack())),
    write: (text) => acceptedStdout.push(text),
    writeError: (text) => stderr.push(text),
  }), 0);
  assert.ok(acceptedStdout.join('').includes(versionArn(2)));
});

test('resolve prints the ARN to stdout only and appends the value and its source to the summary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-cleanup-capability-'));
  const summaryPath = join(directory, 'step-summary.md');
  try {
    const stdout = [];
    const stderr = [];
    const exit = await runCapabilityCli(['resolve'], {
      environment: { GITHUB_STEP_SUMMARY: summaryPath },
      io: capabilityIo(describeStacks(stack())),
      write: (text) => stdout.push(text),
      writeError: (text) => stderr.push(text),
    });
    assert.equal(exit, 0);
    assert.deepEqual(stderr, []);
    assert.deepEqual(stdout, [`${versionArn(2)}\n`], 'stdout is the ARN only');
    const summary = await readFile(summaryPath, 'utf8');
    assert.ok(summary.includes(versionArn(2)), 'the summary names the resolved value');
    assert.ok(summary.includes('AnyWearRuntimeStack-beta'), 'the summary names the stack it came from');
    assert.ok(summary.includes('CleanupOperationCleanupStateMachineVersionArn18053210'), 'the summary names the output it came from');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  // Outside a workflow step there is no summary to append to, and that is not a failure.
  assert.equal(appendResolutionSummary({ versionArn: versionArn(2), stackName: 'AnyWearRuntimeStack-beta', outputKey: 'Key' }, {}), false);
});

test('a resolved or refused read never leaves a partial value on stdout', async () => {
  const stdout = [];
  const stderr = [];
  const exit = await runCapabilityCli(['resolve'], {
    io: capabilityIo(describeStacks(stack({ status: 'UPDATE_IN_PROGRESS' }))),
    write: (text) => stdout.push(text),
    writeError: (text) => stderr.push(text),
  });
  assert.equal(exit, 1);
  assert.deepEqual(stdout, []);
  assert.ok(stderr.join('').includes('(in-flight)'));
  // An unknown command is a usage error, not a silent success.
  const usage = [];
  assert.equal(await runCapabilityCli(['verify'], { io: capabilityIo(describeStacks(stack())), write: () => {}, writeError: (text) => usage.push(text) }), 1);
  assert.match(usage.join(''), /Usage: node scripts\/cleanup-capability\.mjs/);
});

test('the start guard refuses a pin the stack no longer publishes, and a refusal starts nothing', async () => {
  const stale = cleanupStartGuard({ environment: { [CAPABILITY_VERSION_ENV]: versionArn(7) }, io: capabilityIo(describeStacks(stack())) });
  await assertRefusal(stale(), { reason: 'drift', values: [versionArn(7), versionArn(2)] });

  const current = cleanupStartGuard({ environment: { [CAPABILITY_VERSION_ENV]: versionArn(2) }, io: capabilityIo(describeStacks(stack())) });
  assert.deepEqual(await current(), { versionArn: versionArn(2), stackName: 'AnyWearRuntimeStack-beta', outputKey: 'CleanupOperationCleanupStateMachineVersionArn18053210' });

  // No pin at all is the same fail-closed answer: the start guard never lets an unset pin start.
  await assertRefusal(cleanupStartGuard({ environment: {}, io: capabilityIo(describeStacks(stack())) })(), {
    reason: 'unset', includes: ['value=<absent>'],
  });
});

test('the live seam is one bounded cloudformation describe-stacks read and nothing else', async () => {
  const calls = [];
  const io = liveCapabilityIo({
    environment: {},
    execute: (command, args, options) => {
      calls.push({ command, args, options });
      return JSON.stringify(describeStacks(stack()));
    },
  });
  assert.equal(await resolveVersionArn(io), versionArn(2));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'aws');
  assert.deepEqual(calls[0].args, [
    'cloudformation', 'describe-stacks', '--stack-name', 'AnyWearRuntimeStack-beta',
    '--region', 'ap-east-1', '--output', 'json', '--no-cli-pager',
  ]);
  assert.equal(calls[0].options.timeout > 0, true, 'the read is bounded by a timeout');
  assert.equal(typeof calls[0].options.maxBuffer, 'number');

  // A denied or failed read keeps the line that identifies it, and never becomes a guess.
  const failing = liveCapabilityIo({
    environment: {},
    execute: () => { throw Object.assign(new Error('Command failed'), { stderr: Buffer.from('AccessDenied: not authorized to perform cloudformation:DescribeStacks\nline two\n') }); },
  });
  await assert.rejects(readVersionPublication(failing), (error) => error instanceof Error
    && /AWS read failed for cloudformation describe-stacks/.test(error.message)
    && /AccessDenied/.test(error.message));
  // A response without a readable stack list is an error, not an absent publication.
  await assert.rejects(readVersionPublication(liveCapabilityIo({ environment: {}, execute: () => '{}' })), /returned no readable stack list/);
});

test('the resolver has one source for the grammar and no committed version ARN', () => {
  // The grammar is imported from the operation, never restated: the resolver is the read half
  // of one constant, so the read and the transport cannot disagree about a version ARN.
  assert.match(source, /import \{ CLEANUP_VERSION_ARN \} from '\.\.\/tests\/support\/service-cleanup-operation\.ts';/);
  assert.equal(source.includes('arn:aws:states'), false, 'the shipped resolver may not carry a version-ARN literal');
  assert.equal(source.includes('beta-anywear-tester-cleanup:'), false);
  // No new grant: the resolver's only AWS call is the stack read the qualification role
  // already holds, and it never lists versions, reads SSM or starts anything.
  const awsCalls = [...source.matchAll(/'(cloudformation|stepfunctions|ssm|ec2|iam|sts|kms)', '([a-z-]+)'/g)].map((match) => `${match[1]} ${match[2]}`);
  assert.deepEqual([...new Set(awsCalls)], ['cloudformation describe-stacks']);
  for (const forbidden of ['list-state-machine-versions', 'start-execution', 'StartExecutionCommand', 'get-parameter', 'secretsmanager', 'actions/variables']) {
    assert.equal(source.includes(forbidden), false, `the resolver must not use ${forbidden}`);
  }
});
