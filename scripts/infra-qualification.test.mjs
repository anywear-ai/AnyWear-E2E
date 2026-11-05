import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertEqual, byteHash, canonicalJson, contentHash, parseStrictJson,
} from './evidence-contract.mjs';
import { qualificationFixture } from './fixtures/infra-qualification.mjs';
import { assertE2EExecution } from './execution-guard.mjs';
import { liveObservationIo, observePlatform } from './infra-observation.mjs';
import {
  SERVICE_RELEASE_ASSET_NAMES,
  buildQualificationRecord, validateObservation, verifyQualificationForPromotion,
} from './qualification-record.mjs';

// The observation reads the reviewed account from the execution environment and verifies
// it against the STS caller, exactly as the protected workflow provides it.
process.env.AWS_ACCOUNT_ID = '650880818323';

const now = new Date('2026-10-08T00:20:00.000Z');
const qualify = (f) => buildQualificationRecord(f.input, f.expected, f.evidence, now, f.environment, f.report);
const ACCOUNT = '650880818323';
const CLIENT_HOST = 'client123.cloudfront.net';
// The unchanged pre-change fixture template: the compatibility test pins its hash.
const DEFAULT_TEMPLATE = { Resources: { Shared: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'beta' } } } };

const defaultParameters = () => [
  { Name: '/anywear/beta/api_base_url', Value: 'https://api.example.com', Type: 'String', Version: 1 },
  { Name: '/anywear/beta/api_security_group_id', Value: 'sg-1', Type: 'String', Version: 2 },
  { Name: '/anywear/beta/auto_tagging_dlq_name', Value: 'beta-anywear-auto-tagging-dlq', Type: 'String', Version: 3 },
];
const defaultQueues = () => [
  'https://sqs.ap-east-1.amazonaws.com/650880818323/beta-anywear-auto-tagging',
  'https://sqs.ap-east-1.amazonaws.com/650880818323/beta-anywear-auto-tagging-dlq',
  'https://sqs.ap-east-1.amazonaws.com/650880818323/beta-anywear-vto',
  'https://sqs.ap-east-1.amazonaws.com/650880818323/beta-anywear-vto-dlq',
];
const defaultDistributions = () => [
  { Id: 'E1', DomainName: 'client123.cloudfront.net', Status: 'Deployed', Enabled: true, Aliases: { Items: ['other.example.com'] } },
  { Id: 'E2', DomainName: 'api123.cloudfront.net', Status: 'Deployed', Enabled: true, Aliases: { Items: [] } },
  { Id: 'E3', DomainName: 'admin123.cloudfront.net', Status: 'Deployed', Enabled: true, Aliases: { Items: [] } },
];

// The AWS CLI double for the authenticated platform observation. Every read the
// observation performs is answered here, and a test can fail or change exactly one
// answer so the observation's own refusals are exercised without AWS. Every list is
// paginated (`pageSize` rows per page, token flags included), so the observation's
// bounded pagination loop runs on the fixture path too. `calls` records the exact
// `{args, region}` of every read, so a test can assert which region each regional call
// actually used. `handlers` overrides one command by `service action` key.
function observationIo({
  account = ACCOUNT,
  stackStatus = 'UPDATE_COMPLETE',
  secondStatus = stackStatus,
  secondUpdatedTime = '2026-10-07T00:00:00.000Z',
  listStatus = () => stackStatus,
  stackSummaries = (region) => (region === 'ap-east-1'
    ? ['AnyWearFoundationStack', 'AnyWearPlatformStack-beta'] : ['AnyWearBillingStack-beta']),
  describeArn = ({ region, name }) => `arn:aws:cloudformation:${region}:${account}:stack/${name}/id`,
  stackTemplates = {},
  parameters = defaultParameters(),
  functionNames = ['beta-anywear-post-confirmation-sync', 'beta-anywear-pre-sign-up'],
  functionArn = (name) => `arn:aws:lambda:ap-east-1:${account}:function:${name}`,
  functionState = 'Active',
  functionUpdateStatus = 'Successful',
  queueUrls = defaultQueues(),
  queueAttributes = () => ({}),
  distributions = defaultDistributions(),
  pageSize = 2,
  handlers = {},
  calls = [],
} = {}) {
  const listPass = new Map();
  const describePass = new Map();
  const pages = (rows) => (args) => {
    const flag = args.includes('--next-token') ? '--next-token' : '--marker';
    const index = args.indexOf(flag);
    const token = index >= 0 ? args[index + 1] : undefined;
    const page = token === undefined ? 0 : Number(token);
    const slice = rows.slice(page * pageSize, (page + 1) * pageSize);
    const next = (page + 1) * pageSize < rows.length ? String(page + 1) : undefined;
    return { slice, next };
  };
  const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];
  const byAction = {
    'sts get-caller-identity': () => ({ Account: account }),
    'cloudformation list-stacks': (args, region) => {
      const pass = listPass.get(region) ?? 0;
      listPass.set(region, pass + 1);
      const { slice, next } = pages(stackSummaries(region, pass))(args);
      // A summary may be a bare name (mapped through `listStatus`) or an explicit
      // `{StackName, StackStatus}` row, so the live stop/start history — several rows
      // for one stack name with mixed statuses — can be reproduced exactly.
      return { StackSummaries: slice.map((entry) => (typeof entry === 'string'
        ? { StackName: entry, StackStatus: listStatus(entry) }
        : { StackName: entry.StackName, StackStatus: entry.StackStatus })),
        ...(next ? { NextToken: next } : {}) };
    },
    'cloudformation describe-stacks': (args, region) => {
      const key = valueAfter(args, '--stack-name');
      const name = key.includes(':stack/') ? key.split('/')[1] : key;
      const pass = describePass.get(name) ?? 0;
      describePass.set(name, pass + 1);
      return { Stacks: [{
        StackName: name,
        StackId: describeArn({ region, name }),
        StackStatus: pass === 0 ? stackStatus : secondStatus,
        LastUpdatedTime: pass === 0 ? '2026-10-07T00:00:00.000Z' : secondUpdatedTime,
      }] };
    },
    'cloudformation get-template': (args) => {
      const key = valueAfter(args, '--stack-name');
      const name = key.split('/')[1];
      return { TemplateBody: JSON.stringify(stackTemplates[name] ?? DEFAULT_TEMPLATE) };
    },
    'ssm get-parameters-by-path': (args) => {
      // #228 step 1b: the reader states --no-with-decryption explicitly so the request
      // context carries WithDecryption: false for the reviewed grant's Bool condition.
      assert.ok(args.includes('--no-with-decryption'),
        'the stage-input read must pass --no-with-decryption explicitly');
      const { slice, next } = pages(parameters)(args);
      return { Parameters: slice, ...(next ? { NextToken: next } : {}) };
    },
    'lambda list-functions': (args) => {
      const { slice, next } = pages(functionNames)(args);
      return { Functions: slice.map((FunctionName) => ({ FunctionName })),
        ...(next ? { NextMarker: next } : {}) };
    },
    'lambda get-function': (args) => {
      const name = valueAfter(args, '--function-name');
      return { Configuration: {
        FunctionArn: functionArn(name), State: functionState, LastUpdateStatus: functionUpdateStatus,
        CodeSha256: Buffer.from('e'.repeat(64), 'hex').toString('base64'),
        FunctionName: name, Runtime: 'nodejs24.x', Handler: 'index.handler',
        Role: 'arn:aws:iam::650880818323:role/beta-anywear-lambda', MemorySize: 512, Timeout: 30, Architectures: ['arm64'],
      } };
    },
    'sqs list-queues': (args) => {
      const { slice, next } = pages(queueUrls)(args);
      return { QueueUrls: slice, ...(next ? { NextToken: next } : {}) };
    },
    'sqs get-queue-attributes': (args) => {
      const url = valueAfter(args, '--queue-url');
      const name = url.split('/').filter(Boolean).pop();
      const attributes = {
        QueueArn: `arn:aws:sqs:ap-east-1:${account}:${name}`,
        VisibilityTimeout: '900',
        ...(!name.endsWith('-dlq') ? {
          RedrivePolicy: JSON.stringify({ maxReceiveCount: 3, deadLetterTargetArn: `arn:aws:sqs:ap-east-1:${account}:${name}-dlq` }),
        } : {}),
        ...queueAttributes(name),
      };
      return { Attributes: attributes };
    },
    'cloudfront list-distributions': (args) => {
      const { slice, next } = pages(distributions)(args);
      return { DistributionList: {
        Items: slice, IsTruncated: Boolean(next), ...(next ? { NextMarker: next } : {}),
      } };
    },
  };
  const merged = { ...byAction, ...handlers };
  return {
    async aws(args, awsRegion) {
      calls.push({ args: [...args], region: awsRegion });
      const [service, action] = args;
      const handler = merged[`${service} ${action}`];
      if (!handler) throw new Error(`unexpected AWS call ${args.join(' ')}`);
      return handler(args, awsRegion);
    },
  };
}

test('strict JSON rejects escaped duplicate keys, invalid UTF-8/Unicode and non-JSON values', () => {
  for (const source of ['{"a":1,"\\u0061":2}', '{"a":{"x":1,"x":2}}', '1e999', '"\\ud800"', '\u00a0{}', '{"a":1,}', '[1,]']) {
    assert.throws(() => parseStrictJson(source));
  }
  assert.throws(() => parseStrictJson(Buffer.from([0xc0, 0xaf])));
  const proto = parseStrictJson('{"__proto__":{"unexpected":true}}');
  assert.equal(Object.hasOwn(proto, '__proto__'), true);
  assert.equal({}.unexpected, undefined);
  assert.equal(canonicalJson(parseStrictJson('{"z":1,"a":2}')), '{"a":2,"z":1}');
});

// #180/#228: the observation is E2E's own authenticated discovery of the deployed
// surface — every `AnyWear*` stack in the two observation regions, the published stage
// prefix, every `beta-anywear-*` Lambda and queue, and the Client distribution. It is
// producer-free: no Infra commit, no deployment record, no committed name list.
test('observes the live platform itself: discovered stacks, stage inputs, Lambdas, queues and the Client domain', async () => {
  const platform = await observePlatform({ io: observationIo(), clientHost: CLIENT_HOST });
  assert.deepEqual(platform.stacks, [
    { name: 'AnyWearBillingStack-beta', region: 'us-east-1', template_sha256: contentHash(DEFAULT_TEMPLATE) },
    { name: 'AnyWearFoundationStack', region: 'ap-east-1', template_sha256: contentHash(DEFAULT_TEMPLATE) },
    { name: 'AnyWearPlatformStack-beta', region: 'ap-east-1', template_sha256: contentHash(DEFAULT_TEMPLATE) },
  ]);
  for (const row of platform.stacks) {
    assert.deepEqual(Object.keys(row).sort(), ['name', 'region', 'template_sha256']);
    assert.equal(row.producer_repository, undefined);
  }
  assert.deepEqual(platform.inputs.map(({ parameter, version }) => ({ parameter, version })), [
    { parameter: '/anywear/beta/api_base_url', version: '1' },
    { parameter: '/anywear/beta/api_security_group_id', version: '2' },
    { parameter: '/anywear/beta/auto_tagging_dlq_name', version: '3' },
  ]);
  assert.equal(platform.inputs[0].value_sha256, byteHash('https://api.example.com'));
  assert.equal(platform.schema_sha256, contentHash(platform.inputs.map(({ parameter, version }) => ({ parameter, version }))));
  assert.deepEqual(platform.lambdas.map(({ name }) => name), ['beta-anywear-post-confirmation-sync', 'beta-anywear-pre-sign-up']);
  assert.deepEqual(platform.queues.map(({ name }) => name), [
    'beta-anywear-auto-tagging', 'beta-anywear-auto-tagging-dlq', 'beta-anywear-vto', 'beta-anywear-vto-dlq',
  ]);
  assert.deepEqual(platform.queues.find(({ name }) => name === 'beta-anywear-auto-tagging'),
    { name: 'beta-anywear-auto-tagging', queueVisibilitySeconds: 900, maxReceives: 3 });
  assert.deepEqual(platform.queues.find(({ name }) => name === 'beta-anywear-auto-tagging-dlq'),
    { name: 'beta-anywear-auto-tagging-dlq', queueVisibilitySeconds: 900, maxReceives: null });
  assert.equal(platform.client_domain, CLIENT_HOST);

  const f = qualificationFixture();
  const observation = {
    collected_at: '2026-10-08T00:00:00.000Z',
    client: { url: `https://${platform.client_domain}`, source_commit: f.clientSha, built_at: '2026-10-07T00:00:00.000Z' },
    service: { url: 'https://api123.cloudfront.net', service_commit: f.serviceSha, image_digest: f.image },
    platform,
    authenticated: true,
  };
  assert.equal(validateObservation(observation, 'observed'), observation);
});

// #228 acceptance: the discovery walks every list to exhaustion with new tokens, so a
// member added beyond the first page is still observed. The double pages at `pageSize`
// rows, and the expanded fixture forces a second page on every list.
test('pagination walks each discovery list to exhaustion with fresh tokens', async () => {
  const calls = [];
  const platform = await observePlatform({
    io: observationIo({
      stackSummaries: (region) => (region === 'ap-east-1'
        ? ['AnyWearFoundationStack', 'AnyWearPlatformStack-beta', 'AnyWearRuntimeStack-beta']
        : ['AnyWearBillingStack-beta']),
      parameters: [
        ...defaultParameters(),
        { Name: '/anywear/beta/tester_allowlist', Value: 'allow@anywear.local', Type: 'String', Version: 4 },
      ],
      functionNames: ['beta-anywear-post-confirmation-sync', 'beta-anywear-pre-sign-up', 'beta-anywear-new-worker'],
      queueUrls: [...defaultQueues(), 'https://sqs.ap-east-1.amazonaws.com/650880818323/beta-anywear-new-queue'],
      distributions: [...defaultDistributions(), { Id: 'E4', DomainName: 'extra.cloudfront.net', Status: 'Deployed', Enabled: true, Aliases: { Items: [] } }],
      pageSize: 2,
      calls,
    }),
    clientHost: CLIENT_HOST,
  });
  assert.deepEqual(platform.stacks.map(({ name }) => name),
    ['AnyWearBillingStack-beta', 'AnyWearFoundationStack', 'AnyWearPlatformStack-beta', 'AnyWearRuntimeStack-beta']);
  assert.ok(platform.inputs.some(({ parameter }) => parameter === '/anywear/beta/tester_allowlist'));
  assert.ok(platform.lambdas.some(({ name }) => name === 'beta-anywear-new-worker'));
  assert.ok(platform.queues.some(({ name }) => name === 'beta-anywear-new-queue'));
  for (const [service, action, flag] of [
    ['cloudformation', 'list-stacks', '--next-token'],
    ['ssm', 'get-parameters-by-path', '--next-token'],
    ['lambda', 'list-functions', '--marker'],
    ['sqs', 'list-queues', '--next-token'],
    ['cloudfront', 'list-distributions', '--marker'],
  ]) {
    const reads = calls.filter(({ args }) => args[0] === service && args[1] === action);
    assert.ok(reads.some(({ args }) => args.includes(flag)), `${service} ${action} must page with ${flag}`);
  }
});

// #228 acceptance: a stage parameter, an `AnyWear*` stack, a `beta-anywear-*` Lambda and
// queue added to the fixture appear in the observation output with no source change —
// the discovered surface, not a committed list, is what the observation records.
test('a stage parameter, stack, Lambda and queue added to the fixture appear with no source change', async () => {
  const platform = await observePlatform({
    io: observationIo({
      stackSummaries: (region) => (region === 'ap-east-1'
        ? ['AnyWearFoundationStack', 'AnyWearPlatformStack-beta', 'AnyWearEgressStack-beta']
        : ['AnyWearBillingStack-beta']),
      parameters: [
        ...defaultParameters(),
        { Name: '/anywear/beta/qweather_api_host', Value: 'api.qweather.example', Type: 'String', Version: 7 },
      ],
      functionNames: ['beta-anywear-post-confirmation-sync', 'beta-anywear-pre-sign-up', 'beta-anywear-post-build-hook'],
      queueUrls: [...defaultQueues(), 'https://sqs.ap-east-1.amazonaws.com/650880818323/beta-anywear-outbox'],
    }),
    clientHost: CLIENT_HOST,
  });
  assert.deepEqual(platform.stacks.map(({ name }) => name), [
    'AnyWearBillingStack-beta', 'AnyWearEgressStack-beta', 'AnyWearFoundationStack', 'AnyWearPlatformStack-beta',
  ]);
  assert.deepEqual(platform.inputs.map(({ parameter }) => parameter), [
    '/anywear/beta/api_base_url', '/anywear/beta/api_security_group_id', '/anywear/beta/auto_tagging_dlq_name', '/anywear/beta/qweather_api_host',
  ]);
  assert.deepEqual(platform.lambdas.map(({ name }) => name),
    ['beta-anywear-post-build-hook', 'beta-anywear-post-confirmation-sync', 'beta-anywear-pre-sign-up']);
  assert.deepEqual(platform.queues.map(({ name }) => name), [
    'beta-anywear-auto-tagging', 'beta-anywear-auto-tagging-dlq', 'beta-anywear-outbox', 'beta-anywear-vto', 'beta-anywear-vto-dlq',
  ]);
});

// #228 step 1a: the live account's legitimate stop/start history. `list-stacks` returns
// one row per stack occurrence, so the same name appears many times with mixed statuses;
// every `DELETE_COMPLETE` row is dropped before the reviewed set (never described, never
// recorded), and exactly the live rows are recorded.
test('the live stop/start history is dropped before the reviewed set and only the live rows are recorded', async () => {
  const liveHistory = () => {
    const runtime = [
      { StackName: 'AnyWearRuntimeStack-beta', StackStatus: 'UPDATE_COMPLETE' },
      ...Array.from({ length: 6 }, () => ({ StackName: 'AnyWearRuntimeStack-beta', StackStatus: 'DELETE_COMPLETE' })),
    ];
    const egress = [
      { StackName: 'AnyWearEgressStack-beta', StackStatus: 'UPDATE_COMPLETE' },
      { StackName: 'AnyWearEgressStack-beta', StackStatus: 'DELETE_COMPLETE' },
    ];
    const workload = Array.from({ length: 2 }, () => ({ StackName: 'AnyWearWorkloadStack-beta', StackStatus: 'DELETE_COMPLETE' }));
    return [
      { StackName: 'AnyWearFoundationStack', StackStatus: 'UPDATE_COMPLETE' },
      { StackName: 'AnyWearPlatformStack-beta', StackStatus: 'UPDATE_COMPLETE' },
      ...runtime, ...egress, ...workload,
    ];
  };
  const calls = [];
  const platform = await observePlatform({
    io: observationIo({
      stackSummaries: (region) => (region === 'ap-east-1' ? liveHistory() : ['AnyWearBillingStack-beta']),
      pageSize: 3,
      calls,
    }),
    clientHost: CLIENT_HOST,
  });
  assert.deepEqual(platform.stacks.map(({ name }) => name), [
    'AnyWearBillingStack-beta', 'AnyWearEgressStack-beta', 'AnyWearFoundationStack',
    'AnyWearPlatformStack-beta', 'AnyWearRuntimeStack-beta',
  ]);
  // The deleted history rows are never described: one describe per live row per pass.
  const describes = calls.filter(({ args }) => args[0] === 'cloudformation' && args[1] === 'describe-stacks');
  assert.equal(describes.length, 10);
  assert.equal(describes.some(({ args }) => String(args).includes('AnyWearWorkloadStack-beta')), false);
});

// #228 step 1a: the reviewed set must contain at most one row per stack name. A
// duplicated non-DELETE_COMPLETE row for one name — on one page or across pages — is
// refused naming the stack; only `DELETE_COMPLETE` rows may repeat.
test('a duplicated non-DELETE_COMPLETE row for one stack name is refused naming the stack', async () => {
  // Within one page: two live rows for one name on the same page.
  await assert.rejects(observePlatform({
    io: observationIo({
      stackSummaries: () => [
        { StackName: 'AnyWearFoundationStack', StackStatus: 'UPDATE_COMPLETE' },
        { StackName: 'AnyWearPlatformStack-beta', StackStatus: 'UPDATE_COMPLETE' },
        { StackName: 'AnyWearPlatformStack-beta', StackStatus: 'UPDATE_COMPLETE' },
      ],
      pageSize: 4,
    }),
    clientHost: CLIENT_HOST,
  }), /CloudFormation list-stacks in ap-east-1 lists AnyWearPlatformStack-beta more than once/);
  // Across pages: the two live rows land on different pages.
  await assert.rejects(observePlatform({
    io: observationIo({
      stackSummaries: () => [
        { StackName: 'AnyWearFoundationStack', StackStatus: 'UPDATE_COMPLETE' },
        { StackName: 'AnyWearPlatformStack-beta', StackStatus: 'UPDATE_COMPLETE' },
        { StackName: 'AnyWearEgressStack-beta', StackStatus: 'UPDATE_COMPLETE' },
        { StackName: 'AnyWearPlatformStack-beta', StackStatus: 'UPDATE_COMPLETE' },
      ],
      pageSize: 3,
    }),
    clientHost: CLIENT_HOST,
  }), /CloudFormation list-stacks in ap-east-1 lists AnyWearPlatformStack-beta more than once/);
  // Two rows for one name where one is DELETE_COMPLETE stays the normal history: the
  // live row is recorded and the deleted row is dropped.
  const platform = await observePlatform({
    io: observationIo({
      stackSummaries: (region) => (region === 'ap-east-1' ? [
        { StackName: 'AnyWearFoundationStack', StackStatus: 'UPDATE_COMPLETE' },
        { StackName: 'AnyWearPlatformStack-beta', StackStatus: 'UPDATE_COMPLETE' },
        { StackName: 'AnyWearRuntimeStack-beta', StackStatus: 'DELETE_COMPLETE' },
      ] : ['AnyWearBillingStack-beta']),
    }),
    clientHost: CLIENT_HOST,
  });
  assert.equal(platform.stacks.some(({ name }) => name === 'AnyWearRuntimeStack-beta'), false);
});

// #228: unchanged fixture content keeps byte-identical hashes. The template content and
// the [{parameter, version}] rows below are the pre-change fixture, and the hashes are
// the values the pre-change derivation produced for them.
test('template_sha256 and schema_sha256 of unchanged fixture content stay byte-identical to the pre-change values', async () => {
  const platform = await observePlatform({ io: observationIo(), clientHost: CLIENT_HOST });
  for (const row of platform.stacks) {
    assert.equal(row.template_sha256, '464a8021cee726a2d01f4cc21da77d814a0ca6cbfef78ccb93c5e5620053bfb5');
  }
  assert.equal(platform.schema_sha256, '1a3790fedd149074b4d705e2f7e27e70765e9cd503246e4080136c0ea772922c');
  assert.equal(platform.schema_sha256, contentHash(platform.inputs.map(({ parameter, version }) => ({ parameter, version }))));
  const f = qualificationFixture();
  assert.equal(f.evidence.before.platform.schema_sha256, '1a3790fedd149074b4d705e2f7e27e70765e9cd503246e4080136c0ea772922c');
});

test('reads each stack template in the stack\'s own region', async () => {
  const calls = [];
  await observePlatform({ io: observationIo({ calls }), clientHost: CLIENT_HOST });
  const templates = calls.filter(({ args }) => args[0] === 'cloudformation' && args[1] === 'get-template');
  // One template read per stack per discovery pass, so the closing re-read covers it.
  assert.equal(templates.length, 6);
  for (const call of templates) {
    const stackArn = call.args[call.args.indexOf('--stack-name') + 1];
    const arnRegion = /^arn:aws:cloudformation:([a-z0-9-]+):/.exec(stackArn)?.[1];
    const stackName = stackArn.split('/')[1];
    assert.equal(call.region, arnRegion, `get-template for ${stackName} must use the region in its stack ARN`);
  }
  const templateFor = (name) => templates.find(({ args }) => args.some((arg) => typeof arg === 'string' && arg.includes(name)));
  assert.equal(templateFor('AnyWearBillingStack-beta')?.region, 'us-east-1');
  assert.equal(templateFor('AnyWearFoundationStack')?.region, 'ap-east-1');
  assert.equal(templateFor('AnyWearPlatformStack-beta')?.region, 'ap-east-1');
  for (const call of calls.filter(({ args }) => args[0] === 'cloudformation' && args[1] === 'describe-stacks')) {
    const key = call.args[call.args.indexOf('--stack-name') + 1];
    const stackName = key.includes(':stack/') ? key.split('/')[1] : key;
    const expected = stackName === 'AnyWearBillingStack-beta' ? 'us-east-1' : 'ap-east-1';
    assert.equal(call.region, expected, `describe-stacks for ${stackName} must use its listed region`);
  }
});

test('refuses a stack, account, Lambda, queue or distribution that is not the reviewed discovered one', async () => {
  // The foreign-account guard keeps its message: an observation taken under another
  // account cannot be recorded as Beta.
  await assert.rejects(observePlatform({ io: observationIo({ account: '111111111111' }), clientHost: CLIENT_HOST }),
    /Platform observation requires the Beta account 650880818323 \(observed 111111111111\)/);
  // A non-terminal AnyWear* stack is a deployment crossing the window; DELETE_COMPLETE
  // rows are the one ignored status.
  await assert.rejects(observePlatform({ io: observationIo({ listStatus: () => 'UPDATE_IN_PROGRESS' }), clientHost: CLIENT_HOST }),
    /is not in a terminal state \(observed UPDATE_IN_PROGRESS\)/);
  const withDeletedEgress = await observePlatform({
    io: observationIo({
      stackSummaries: (region) => (region === 'ap-east-1'
        ? ['AnyWearEgressStack-beta', 'AnyWearFoundationStack', 'AnyWearPlatformStack-beta']
        : ['AnyWearBillingStack-beta']),
      listStatus: (name) => (name === 'AnyWearEgressStack-beta' ? 'DELETE_COMPLETE' : 'UPDATE_COMPLETE'),
    }),
    clientHost: CLIENT_HOST,
  });
  assert.equal(withDeletedEgress.stacks.some(({ name }) => name === 'AnyWearEgressStack-beta'), false);
  // A foreign account/region entry inside a list is refused by name, never silently
  // dropped.
  await assert.rejects(observePlatform({
    io: observationIo({ describeArn: () => 'arn:aws:cloudformation:ap-east-1:111111111111:stack/AnyWearFoundationStack/id' }),
    clientHost: CLIENT_HOST,
  }), /CloudFormation stack AnyWearFoundationStack belongs to foreign account 111111111111/);
  await assert.rejects(observePlatform({
    io: observationIo({ describeArn: () => 'arn:aws:cloudformation:eu-west-1:650880818323:stack/AnyWearFoundationStack/id' }),
    clientHost: CLIENT_HOST,
  }), /CloudFormation stack AnyWearFoundationStack ARN region eu-west-1 differs from its list region ap-east-1/);
  await assert.rejects(observePlatform({
    io: observationIo({ functionArn: () => 'arn:aws:lambda:ap-east-1:111111111111:function:beta-anywear-pre-sign-up' }),
    clientHost: CLIENT_HOST,
  }), /Actual Lambda identity\/update state unproven for beta-anywear-post-confirmation-sync/);
  await assert.rejects(observePlatform({ io: observationIo({ functionState: 'Pending' }), clientHost: CLIENT_HOST }),
    /Actual Lambda identity\/update state unproven/);
  await assert.rejects(observePlatform({ io: observationIo({ functionUpdateStatus: 'Failed' }), clientHost: CLIENT_HOST }),
    /Actual Lambda identity\/update state unproven/);
  await assert.rejects(observePlatform({
    io: observationIo({ queueUrls: ['https://sqs.ap-east-1.amazonaws.com/111111111111/beta-anywear-vto',
      'https://sqs.ap-east-1.amazonaws.com/650880818323/beta-anywear-auto-tagging'] }),
    clientHost: CLIENT_HOST,
  }), /Foreign queue URL observation for beta-anywear-vto/);
  await assert.rejects(observePlatform({
    io: observationIo({ queueAttributes: (name) => (name === 'beta-anywear-vto'
      ? { QueueArn: 'arn:aws:sqs:ap-east-1:111111111111:beta-anywear-vto' } : {}) }),
    clientHost: CLIENT_HOST,
  }), /Foreign queue observation for beta-anywear-vto/);
  await assert.rejects(observePlatform({
    io: observationIo({ queueAttributes: (name) => (name === 'beta-anywear-vto' ? { RedrivePolicy: 'not-json' } : {}) }),
    clientHost: CLIENT_HOST,
  }), /Deployed beta-anywear-vto queue redrive policy is unreadable/);
  // A SecureString under the stage path is refused: the reader never decrypts.
  await assert.rejects(observePlatform({
    io: observationIo({ parameters: [
      { Name: '/anywear/beta/api_base_url', Value: 'https://api.example.com', Type: 'String', Version: 1 },
      { Name: '/anywear/beta/secret_value', Value: 'masked', Type: 'SecureString', Version: 1 },
    ] }),
    clientHost: CLIENT_HOST,
  }), /SSM parameter \/anywear\/beta\/secret_value is a SecureString/);
  // A deployment that crosses the observation is refused instead of being recorded as one state.
  await assert.rejects(observePlatform({ io: observationIo({ secondUpdatedTime: '2026-10-07T00:01:00.000Z' }), clientHost: CLIENT_HOST }),
    /CloudFormation stack AnyWearFoundationStack changed during the authenticated observation/);
  // A stack added or removed between the two discovery passes is refused and named.
  await assert.rejects(observePlatform({
    io: observationIo({
      stackSummaries: (region, pass) => (region === 'ap-east-1'
        ? (pass === 0 ? ['AnyWearFoundationStack', 'AnyWearPlatformStack-beta'] : ['AnyWearFoundationStack', 'AnyWearPlatformStack-beta', 'AnyWearRuntimeStack-beta'])
        : ['AnyWearBillingStack-beta']),
    }),
    clientHost: CLIENT_HOST,
  }), /Platform discovery mismatch at <root>\.stacks/);
  await assert.rejects(observePlatform({
    io: observationIo({
      stackSummaries: (region, pass) => (region === 'ap-east-1'
        ? (pass === 0 ? ['AnyWearFoundationStack', 'AnyWearPlatformStack-beta'] : ['AnyWearPlatformStack-beta'])
        : ['AnyWearBillingStack-beta']),
    }),
    clientHost: CLIENT_HOST,
  }), /Platform discovery mismatch at <root>\.stacks/);
  // The client domain: no match, several matches, a disabled or not-Deployed one.
  await assert.rejects(observePlatform({ io: observationIo({ distributions: defaultDistributions().slice(1) }), clientHost: CLIENT_HOST }),
    /Client domain discovery found 0 CloudFront distributions serving client123\.cloudfront\.net/);
  await assert.rejects(observePlatform({
    io: observationIo({ distributions: [...defaultDistributions(),
      { Id: 'E4', DomainName: 'client123.cloudfront.net', Status: 'Deployed', Enabled: true, Aliases: { Items: [] } }] }),
    clientHost: CLIENT_HOST,
  }), /Client domain discovery found 2 CloudFront distributions serving client123\.cloudfront\.net/);
  await assert.rejects(observePlatform({
    io: observationIo({ distributions: [{ Id: 'E1', DomainName: CLIENT_HOST, Status: 'InProgress', Enabled: true, Aliases: { Items: [] } }] }),
    clientHost: CLIENT_HOST,
  }), /not deployed and enabled \(Status InProgress, Enabled true\)/);
  await assert.rejects(observePlatform({
    io: observationIo({ distributions: [{ Id: 'E1', DomainName: CLIENT_HOST, Status: 'Deployed', Enabled: false, Aliases: { Items: [] } }] }),
    clientHost: CLIENT_HOST,
  }), /not deployed and enabled \(Status Deployed, Enabled false\)/);
});

test('an empty discovered set per service is a loud failure naming the service and region', async () => {
  await assert.rejects(observePlatform({
    io: observationIo({ stackSummaries: () => [] }),
    clientHost: CLIENT_HOST,
  }), /CloudFormation discovery found no AnyWear\* stacks in ap-east-1/);
  await assert.rejects(observePlatform({
    io: observationIo({ stackSummaries: (region) => (region === 'ap-east-1' ? ['AnyWearFoundationStack'] : []) }),
    clientHost: CLIENT_HOST,
  }), /CloudFormation discovery found no AnyWear\* stacks in us-east-1/);
  await assert.rejects(observePlatform({ io: observationIo({ parameters: [] }), clientHost: CLIENT_HOST }),
    /SSM discovery found no parameters under \/anywear\/beta\//);
  await assert.rejects(observePlatform({ io: observationIo({ functionNames: [] }), clientHost: CLIENT_HOST }),
    /Lambda discovery found no beta-anywear-\* functions in ap-east-1/);
  await assert.rejects(observePlatform({ io: observationIo({ queueUrls: [] }), clientHost: CLIENT_HOST }),
    /SQS discovery found no beta-anywear-\* queues in ap-east-1/);
});

test('a looping or unbounded list read is refused', async () => {
  await assert.rejects(observePlatform({
    io: observationIo({
      handlers: {
        'lambda list-functions': (args) => ({
          Functions: [{ FunctionName: args.includes('--marker')
            ? 'beta-anywear-post-confirmation-sync' : 'beta-anywear-pre-sign-up' }],
          NextMarker: '1',
        }),
      },
    }),
    clientHost: CLIENT_HOST,
  }), /Lambda list-functions pagination token repeated/);
  await assert.rejects(observePlatform({
    io: observationIo({
      handlers: {
        'lambda list-functions': (args) => ({
          Functions: [
            { FunctionName: 'beta-anywear-pre-sign-up' }, { FunctionName: 'beta-anywear-post-confirmation-sync' },
          ],
          NextMarker: args.includes('--marker') ? undefined : '1',
        }),
      },
    }),
    clientHost: CLIENT_HOST,
  }), /Lambda list-functions lists beta-anywear-pre-sign-up more than once/);
  await assert.rejects(observePlatform({
    io: observationIo({ functionNames: Array.from({ length: 101 }, (_, index) => `beta-anywear-f${String(index).padStart(3, '0')}`), pageSize: 2 }),
    clientHost: CLIENT_HOST,
  }), /Lambda list-functions exceeded the 50-page pagination bound/);
  await assert.rejects(observePlatform({
    io: observationIo({ handlers: {
      'cloudfront list-distributions': () => ({ DistributionList: { Items: defaultDistributions(), IsTruncated: true } }),
    } }),
    clientHost: CLIENT_HOST,
  }), /CloudFront list-distributions is truncated without a next token/);
});

test('a changed deployed template is a different content identity', async () => {
  const original = await observePlatform({ io: observationIo(), clientHost: CLIENT_HOST });
  const changed = await observePlatform({
    io: observationIo({ stackTemplates: {
      'AnyWearFoundationStack': { Resources: { Shared: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'changed' } } } },
    } }),
    clientHost: CLIENT_HOST,
  });
  assert.notEqual(changed.stacks.find(({ name }) => name === 'AnyWearFoundationStack').template_sha256,
    original.stacks.find(({ name }) => name === 'AnyWearFoundationStack').template_sha256);
  assert.equal(changed.stacks.find(({ name }) => name === 'AnyWearPlatformStack-beta').template_sha256,
    original.stacks.find(({ name }) => name === 'AnyWearPlatformStack-beta').template_sha256);
});

test('the live AWS seam names the denied read instead of failing silently', async () => {
  const io = liveObservationIo({
    execute: () => { const error = new Error('Command failed'); error.stderr = Buffer.from('An error occurred (AccessDenied) when calling the ListStacks operation'); throw error; },
  });
  await assert.rejects(async () => io.aws(['cloudformation', 'list-stacks']),
    /AWS read failed for cloudformation list-stacks: An error occurred \(AccessDenied\)/);
});

test('the record is self-contained: only the v4 members, and the live tuple inside them', () => {
  const record = qualify(qualificationFixture());
  assert.equal(record.schema_version, 4);
  assert.deepEqual(Object.keys(record).sort(), [
    'environment', 'expected', 'integrity', 'observations', 'operation', 'qualification_id', 'qualified_at',
    'record_type', 'result', 'revisions', 'schema_version', 'service_artifacts', 'test', 'workflow',
  ]);
  // #193: the release identity is the tag's target commit plus exactly the four released
  // assets; the manifest members v3 carried are gone.
  assert.deepEqual(Object.keys(record.service_artifacts).sort(), ['assets', 'release_id', 'repository', 'tag', 'target_commit']);
  assert.deepEqual(Object.keys(record.service_artifacts.assets), [...SERVICE_RELEASE_ASSET_NAMES]);
  assert.equal(record.service_artifacts.target_commit, record.revisions.service.sha);
  assert.deepEqual(Object.keys(record.revisions).sort(), ['client', 'e2e', 'service']);
  assert.deepEqual(Object.keys(record.observations).sort(), ['after', 'before']);
  for (const phase of ['before', 'after']) {
    assert.deepEqual(Object.keys(record.observations[phase]).sort(), ['authenticated', 'client', 'collected_at', 'platform', 'service']);
    // #228: the platform member is the discovered shape; `queue_config_sha256` is gone.
    assert.deepEqual(Object.keys(record.observations[phase].platform).sort(),
      ['client_domain', 'inputs', 'lambdas', 'queues', 'schema_sha256', 'stacks']);
  }
  // The serialized record is the whole tuple: Client, Service, image, platform content,
  // stage inputs, Lambdas, queues, distribution and the floor.
  const serialized = JSON.stringify(record);
  assert.ok(serialized.includes(record.revisions.client.sha));
  assert.ok(serialized.includes(record.revisions.service.sha));
  assert.ok(serialized.includes(record.revisions.service.image_digest));
  assert.ok(serialized.includes(record.service_artifacts.tag));
  assert.ok(serialized.includes(`"minimum_client_version":${record.revisions.service.minimum_client_version}`));
  assert.ok(serialized.includes(record.observations.after.platform.schema_sha256));
  assert.ok(serialized.includes(record.observations.after.platform.client_domain));
  assert.ok(serialized.includes('"queueVisibilitySeconds"'));
  assert.equal(serialized.includes('"compatibility"'), false);
  assert.equal(serialized.includes('"deployment"'), false);
  assert.equal(serialized.includes('"infra"'), false);
  assert.equal(serialized.includes('queue_config_sha256'), false);
});

test('the stage-input schema hash is content identity derived from the inputs', () => {
  const f = qualificationFixture();
  const inputs = structuredClone(f.evidence.before.platform.inputs);
  assert.equal(contentHash(inputs.map(({ parameter, version }) => ({ parameter, version }))),
    f.evidence.before.platform.schema_sha256);
  const valueChanged = structuredClone(inputs);
  valueChanged[0].value_sha256 = 'a'.repeat(64);
  assert.equal(contentHash(valueChanged.map(({ parameter, version }) => ({ parameter, version }))),
    contentHash(inputs.map(({ parameter, version }) => ({ parameter, version }))));
  const versionChanged = structuredClone(inputs);
  versionChanged[0].version = String(Number(versionChanged[0].version) + 1);
  assert.notEqual(contentHash(versionChanged.map(({ parameter, version }) => ({ parameter, version }))),
    contentHash(inputs.map(({ parameter, version }) => ({ parameter, version }))));
});

test('promotion requires the exact unexpired artifact and completed-success E2E attempt, beyond the self-checksum', () => {
  const record = qualify(qualificationFixture());
  const recordBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  const trustedRun = { id: 123, run_attempt: 1, repository: { full_name: 'anywear-ai/AnyWear-E2E' }, path: '.github/workflows/beta-qualification.yml',
    head_sha: record.revisions.e2e.sha, head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
    run_started_at: '2026-10-07T23:59:00Z', updated_at: '2026-10-08T00:25:00Z' };
  const trustedArtifact = { id: 90, name: 'beta-qualification-123-1', expired: false, expires_at: '2026-10-09T00:00:00Z',
    created_at: '2026-10-08T00:21:00Z', workflow_run: { id: 123, head_sha: trustedRun.head_sha } };
  const expected = { artifact_id: 90, record_sha256: byteHash(recordBytes), e2e_sha: trustedRun.head_sha, run_id: 123, run_attempt: 1 };
  const context = { trustedRun, trustedArtifact, expected, recordBytes, now: now.getTime() };
  assert.equal(verifyQualificationForPromotion(record, context), true);
  // #193: a historical v3 record is refused by the v4 consumer even with otherwise valid
  // run/artifact metadata; the checksum it carries cannot make it current.
  const legacy = { ...structuredClone(record), schema_version: 3 };
  const legacyBytes = Buffer.from(`${JSON.stringify(legacy, null, 2)}\n`);
  assert.throws(() => verifyQualificationForPromotion(legacy, {
    ...context, recordBytes: legacyBytes, expected: { ...expected, record_sha256: byteHash(legacyBytes) },
  }), /Unsupported qualification record schema: observed schema_version 3/);
  assert.throws(() => verifyQualificationForPromotion(record), /authenticated run\/artifact metadata/);
  assert.throws(() => verifyQualificationForPromotion(record, { ...context, trustedArtifact: { ...trustedArtifact, expired: true } }));
  assert.throws(() => verifyQualificationForPromotion(record, { ...context, trustedRun: { ...trustedRun, conclusion: 'failure' } }));
  assert.throws(() => verifyQualificationForPromotion(record, { ...context, expected: { ...expected, record_sha256: 'a'.repeat(64) } }));
  assert.throws(() => verifyQualificationForPromotion(record, { ...context, trustedArtifact: { ...trustedArtifact, name: 'beta-qualification-123-2' } }));
});

test('execution guard binds protected dispatch/source and the captured dedicated principal', () => {
  const sourceSha = 'a'.repeat(40);
  const env = { GITHUB_REPOSITORY: 'anywear-ai/AnyWear-E2E', GITHUB_REPOSITORY_ID: '1317091305',
    GITHUB_REPOSITORY_OWNER: 'anywear-ai', GITHUB_REPOSITORY_OWNER_ID: '352675702',
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKFLOW_REF: 'anywear-ai/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main',
    GITHUB_WORKFLOW_SHA: sourceSha, GITHUB_SHA: sourceSha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
    E2E_STAGE: 'beta', ENABLE_BETA_MUTATION: 'true', E2E_OPERATION: 'full', AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1',
    E2E_CLEANUP_SERVICE_SHA: 'b'.repeat(40), E2E_AWS_ACCOUNT: '650880818323',
    E2E_AWS_PRINCIPAL_ARN: 'arn:aws:sts::650880818323:assumed-role/beta-e2e-qualification-role/e2e-123-1' };
  assert.equal(assertE2EExecution(env, { sourceSha }), true);
  for (const operation of ['full', 'smoke', 'reconcile']) {
    assert.equal(assertE2EExecution({ ...env, E2E_OPERATION: operation }, { sourceSha }), true);
  }
  // #266: the guard identifies the repository by numeric id only, so a foreign owner login
  // or owner id is no longer a refusal clause; the repository id and the exact workflow ref
  // are.
  for (const patch of [{ ENABLE_BETA_MUTATION: 'false' }, { GITHUB_REPOSITORY_ID: '1' },
    { GITHUB_REF: 'refs/heads/topic' },
    { GITHUB_EVENT_NAME: 'pull_request' }, { E2E_STAGE: 'dev' }, { GITHUB_WORKFLOW_SHA: 'b'.repeat(40) },
    { GITHUB_WORKFLOW_REF: 'anywear-ai/AnyWear-E2E/.github/workflows/integration.yml@refs/heads/main' },
    { GITHUB_WORKFLOW_REF: 'anywear-ai/AnyWear-E2E/.github/workflows/retired-recovery.yml@refs/heads/main' },
    { GITHUB_WORKFLOW_REF: 'anywear-ai/AnyWear-E2E/.github/workflows/runtime-drill.yml@refs/heads/main' },
    { E2E_OPERATION: undefined }, { E2E_OPERATION: '' }, { E2E_OPERATION: 'measure' },
    // #217: the manual recover operation is removed, so the guard refuses it explicitly.
    { E2E_OPERATION: 'recover' },
    { E2E_OPERATION: 'instrumentation' },
    { GITHUB_RUN_ID: '0' }, { GITHUB_RUN_ID: '9007199254740992' }, { GITHUB_RUN_ATTEMPT: '0' },
    { AWS_ACCOUNT_ID: '1' }, { AWS_REGION: 'us-east-1' }, { E2E_CLEANUP_SERVICE_SHA: 'main' },
    { E2E_AWS_ACCOUNT: undefined }, { E2E_AWS_ACCOUNT: '1' }, { E2E_AWS_PRINCIPAL_ARN: undefined },
    { E2E_AWS_PRINCIPAL_ARN: 'arn:aws:sts::650880818323:assumed-role/beta-infra-role/123' },
    { E2E_AWS_PRINCIPAL_ARN: 'arn:aws:sts::111111111111:assumed-role/beta-e2e-qualification-role/123' }]) {
    assert.throws(() => assertE2EExecution({ ...env, ...patch }, { sourceSha }));
  }
  assert.throws(() => assertE2EExecution(env, { sourceSha: 'c'.repeat(40) }), /checkout/);
  const beforeCredentials = { ...env, E2E_AWS_ACCOUNT: undefined, E2E_AWS_PRINCIPAL_ARN: undefined };
  assert.equal(assertE2EExecution(beforeCredentials, { sourceSha, sourceOnly: true }), true);
  assert.throws(() => assertE2EExecution(beforeCredentials, { sourceSha }), /dedicated E2E principal/);
});

// AnyWear #138 stays true after #228: identity is content, never a committed list. A
// changed platform template, input or application identity is refused by name.
test('#138 a changed deployment content is refused and the error names the differing field', () => {
  assert.throws(() => assertEqual({ platform: { template_sha256: 'a'.repeat(64) } }, { platform: { template_sha256: 'b'.repeat(64) } }, 'Record'),
    /Record mismatch at <root>\.platform\.template_sha256: expected "b{64}", observed "a{64}"/);
  const f = qualificationFixture();
  const changed = structuredClone(f);
  changed.evidence.after.platform.lambdas.find(({ name }) => name === 'beta-anywear-post-confirmation-sync').configuration_sha256 = 'f'.repeat(64);
  assert.throws(() => qualify(changed), /Deployed platform identity mismatch/);
  const digestChanged = structuredClone(f);
  digestChanged.evidence.after.service.image_digest = `sha256:${'f'.repeat(64)}`;
  assert.throws(() => qualify(digestChanged), /Deployed Service identity mismatch/);
});
