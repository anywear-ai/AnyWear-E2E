import assert from 'node:assert/strict';
import test from 'node:test';
import { collectSseReplicaAttribution, SSE_ATTRIBUTION_LIMITS, validateSseReplicaAttribution } from './sse-replica-attribution.mjs';

const START = Date.parse('2026-10-05T00:00:00.000Z');
const WINDOW = { startTime: new Date(START).toISOString(), endTime: new Date(START + 60_000).toISOString() };
const RESOURCE_IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const REQUEST_IDS = ['sse-request-one', 'sse-request-two'];
const STREAM_IDS = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
// Issue 277's owner-scoped aggregate stream: one stream per caller, no resource
// identity, so it never matches a request in `expectedRequests`.
const OWNER_REQUEST_ID = 'sse-owner-request';
const OWNER_STREAM_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TASK_IDS = ['a'.repeat(32), 'b'.repeat(32)];
const IMAGE_DIGEST = `sha256:${'c'.repeat(64)}`;
const SERVICE_COMMIT = 'd'.repeat(40);
const ACCOUNT = '650880818323';
const REGION = 'ap-east-1';
const CLUSTER = 'beta-anywear';
const SERVICE = 'beta-api';
const TASK_DEFINITION_ARN = `arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/api:12`;
const TASK_ARNS = TASK_IDS.map((id) => `arn:aws:ecs:${REGION}:${ACCOUNT}:task/${CLUSTER}/${id}`);

function input(overrides = {}) {
  const image = `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/team/api.image@${IMAGE_DIGEST}`;
  const binding = {
    stage: 'beta', accountId: ACCOUNT, region: REGION,
    clusterArn: `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/${CLUSTER}`,
    serviceArn: `arn:aws:ecs:${REGION}:${ACCOUNT}:service/${CLUSTER}/${SERVICE}`,
    serviceCommit: SERVICE_COMMIT, imageDigest: IMAGE_DIGEST,
  };
  const definition = {
    taskDefinitionArn: TASK_DEFINITION_ARN,
    containerDefinitions: [{
      name: 'ApiContainer', image,
      environment: [{ name: 'SERVICE_COMMIT_SHA', value: SERVICE_COMMIT }],
      logConfiguration: { logDriver: 'awslogs', options: {
        'awslogs-group': '/anywear/beta/api', 'awslogs-region': REGION, 'awslogs-stream-prefix': 'api',
      } },
    }],
  };
  const tasks = TASK_ARNS.map((taskArn) => ({
    taskArn, clusterArn: binding.clusterArn, group: `service:${SERVICE}`,
    lastStatus: 'RUNNING', desiredStatus: 'RUNNING', taskDefinitionArn: TASK_DEFINITION_ARN,
    containers: [{ name: 'ApiContainer', lastStatus: 'RUNNING', image, imageDigest: IMAGE_DIGEST }],
  }));
  return {
    binding, tasks, taskDefinitions: [{ taskDefinition: definition }],
    expectedRequests: REQUEST_IDS.map((sourceRequestId, index) => ({
      sourceRequestId, taskType: index === 0 ? 'auto-tagging' : 'vto', resourceId: RESOURCE_IDS[index],
    })),
    window: WINDOW,
    ...overrides,
  };
}

function line(event, requestIndex, timestamp = START + 1000 + requestIndex * 1000, extra = {}) {
  const request = input().expectedRequests[requestIndex];
  const fields = {
    component: 'task-status-sse', stage: 'beta', event, time: timestamp,
    ...(['stream_open', 'stream_snapshot', 'stream_close'].includes(event) ? {
      requestId: REQUEST_IDS[requestIndex], streamId: STREAM_IDS[requestIndex],
      taskType: request.taskType, resourceId: request.resourceId,
    } : {}),
    ...(event === 'stream_snapshot' ? { stateVersion: 1, terminal: false } : {}),
    ...(event === 'stream_open' || event === 'stream_close' ? { activeStreams: 1 } : {}),
    ...(event === 'stream_close' ? { reason: 'client_abort' } : {}),
    ...extra,
  };
  return { timestamp, message: JSON.stringify({ level: 30, time: timestamp, msg: 'SSE operational event', ...fields }) };
}

function lifecycle(requestIndex, options = {}) {
  return [line('stream_open', requestIndex), line('stream_snapshot', requestIndex, START + 1100 + requestIndex * 1000, options.snapshotExtra),
    ...(options.close === false ? [] : [line('stream_close', requestIndex, START + 1200 + requestIndex * 1000, options.closeExtra)])];
}

// The owner-scoped events the Service emits for `GET /wardrobe/status/stream`
// (issue 277). They carry counts only: no taskType and no resourceId.
function ownerLine(event, timestamp = START + 1500, extra = {}) {
  const fields = {
    component: 'task-status-sse', stage: 'beta', event, time: timestamp,
    scope: 'owner', requestId: OWNER_REQUEST_ID, streamId: OWNER_STREAM_ID,
    ...(['owner_stream_open', 'owner_stream_close'].includes(event) ? { activeStreams: 1 } : {}),
    ...(event === 'owner_stream_snapshot' ? { frames: 2, inFlight: 1 } : {}),
    ...(event === 'owner_stream_close' ? { reason: 'client_abort' } : {}),
    ...extra,
  };
  return { timestamp, message: JSON.stringify({ level: 30, time: timestamp, msg: 'SSE operational event', ...fields }) };
}

function pageReader(byStream, { enforceDerivedStreams = true } = {}) {
  const calls = [];
  const readPage = async (query) => {
    calls.push(query);
    if (enforceDerivedStreams) {
      assert.equal(query.logGroup, '/anywear/beta/api');
      assert.match(query.logStream, /^api\/ApiContainer\/[a-f0-9]{32}$/);
      assert.equal(query.startTime, START);
      assert.equal(query.endTime, START + 60_000);
    }
    const pages = byStream.get(query.logStream) ?? [];
    const index = query.nextToken === undefined ? 0 : Number(query.nextToken);
    const events = Array.isArray(pages[0]) ? pages : [pages];
    return index < events.length
      ? { events: events[index], nextForwardToken: String(index + 1) }
      : { events: [], nextForwardToken: String(index) };
  };
  return { readPage, calls };
}

function captures(eventsByTask) {
  const streams = TASK_ARNS.map((arn) => `api/ApiContainer/${arn.split('/').at(-1)}`);
  return new Map(streams.map((stream, index) => [stream, eventsByTask[index] ?? []]));
}

test('collector binds immutable Beta sources and emits exact per-request replica evidence', async () => {
  const source = input();
  const { readPage, calls } = pageReader(captures([lifecycle(0), lifecycle(1)]));
  const evidence = await collectSseReplicaAttribution(source, readPage);

  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.type, 'anywear.sse-replica-attribution');
  assert.deepEqual(evidence.distinctApiTaskArns, [...TASK_ARNS].sort());
  assert.deepEqual(evidence.attributions.map(({ requestId, taskArn, expectedLogStream }) => ({ requestId, taskArn, expectedLogStream })), [
    { requestId: REQUEST_IDS[0], taskArn: TASK_ARNS[0], expectedLogStream: `api/ApiContainer/${TASK_IDS[0]}` },
    { requestId: REQUEST_IDS[1], taskArn: TASK_ARNS[1], expectedLogStream: `api/ApiContainer/${TASK_IDS[1]}` },
  ]);
  assert.equal(evidence.attributions[0].close.reason, 'client_abort');
  assert.equal(new Set(calls.map((query) => query.logStream)).size, 2);
  assert.equal(calls.length, 4);
  assert.strictEqual(validateSseReplicaAttribution(evidence, source), evidence);
});

test('an owner-scoped stream lifecycle is tolerated and changes no attribution evidence', async () => {
  const source = input();
  const baseline = await collectSseReplicaAttribution(source, pageReader(captures([lifecycle(0), lifecycle(1)])).readPage);

  // The owner-scoped lifecycle interleaves with the per-request one in the same
  // captured stream. It must be parsed strictly and then ignored, so the evidence
  // is exactly what the same capture without it yields.
  const interleaved = [
    line('stream_open', 0),
    ownerLine('owner_stream_open', START + 1050),
    line('stream_snapshot', 0, START + 1100),
    ownerLine('owner_stream_snapshot', START + 1150),
    line('stream_close', 0, START + 1200),
    ownerLine('owner_stream_close', START + 1250),
  ];
  const evidence = await collectSseReplicaAttribution(source, pageReader(captures([interleaved, lifecycle(1)])).readPage);

  assert.deepEqual(evidence, baseline);
  assert.deepEqual(evidence.distinctApiTaskArns, [...TASK_ARNS].sort());
  assert.equal(evidence.attributions.length, 2);
});

test('owner-scoped events stay strict about their name, fields, scope, counters and close reason', async (t) => {
  const refused = async (event, extra, pattern) => {
    const { readPage } = pageReader(captures([[ownerLine(event, START + 1050, extra)], lifecycle(1)]));
    await assert.rejects(collectSseReplicaAttribution(input(), readPage), pattern);
  };

  await t.test('unknown owner event name', () => refused('owner_stream_reconnect', {}, /Foreign or unknown SSE operational event/));
  await t.test('unexpected owner field', () => refused('owner_stream_open', { resourceId: RESOURCE_IDS[0] }, /Unexpected or missing operational event fields/));
  await t.test('non-owner scope', () => refused('owner_stream_open', { scope: 'resource' }, /Invalid owner stream scope/));
  await t.test('invalid close reason', () => refused('owner_stream_close', { reason: 'owner_done' }, /Invalid stream close reason/));
  await t.test('invalid owner counter', () => refused('owner_stream_snapshot', { frames: -1 }, /Invalid frames/));
  await t.test('invalid owner identity', () => refused('owner_stream_open', { streamId: 'not-a-uuid' }, /Invalid stream ID/));
});

test('collector accepts exact page and ECR repository bounds', async () => {
  const source = input();
  const image = `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/team/api.image@${IMAGE_DIGEST}`;
  source.taskDefinitions[0].taskDefinition.containerDefinitions[0].image = image;
  source.tasks.forEach((task) => { task.containers[0].image = image; });
  const padded = Array.from({ length: SSE_ATTRIBUTION_LIMITS.eventsPerStream - 3 }, (_, index) => ({
    timestamp: START + index, message: '{"level":30,"msg":"routine request"}',
  }));
  const events = [...padded, ...lifecycle(0)];
  const { readPage } = pageReader(captures([events, lifecycle(1)]));
  const evidence = await collectSseReplicaAttribution(source, readPage);
  assert.equal(evidence.attributions.length, 2);
});

test('collector rejects source drift, foreign tasks, and invalid attribution', async (t) => {
  await t.test('mutable or mismatched image digest', async () => {
    const source = input();
    source.taskDefinitions[0].taskDefinition.containerDefinitions[0].image = `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/team/api:latest`;
    const { readPage } = pageReader(captures([lifecycle(0), lifecycle(1)]));
    await assert.rejects(collectSseReplicaAttribution(source, readPage), /immutable API image URI/);
  });
  await t.test('foreign running-task service group', async () => {
    const source = input();
    source.tasks[0].group = 'service:other';
    const { readPage } = pageReader(captures([lifecycle(0), lifecycle(1)]));
    await assert.rejects(collectSseReplicaAttribution(source, readPage), /Foreign or non-running API task/);
  });
  await t.test('owned request with a foreign resource', async () => {
    const foreign = line('stream_open', 0, START + 1000, { resourceId: RESOURCE_IDS[1] });
    const { readPage } = pageReader(captures([[foreign], lifecycle(1)]));
    await assert.rejects(collectSseReplicaAttribution(input(), readPage), /Foreign request resource or task type/);
  });
  await t.test('duplicate request on another replica', async () => {
    const duplicate = line('stream_open', 0, START + 5000, { streamId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
    const { readPage } = pageReader(captures([lifecycle(0), [...lifecycle(1), duplicate]]));
    await assert.rejects(collectSseReplicaAttribution(input(), readPage), /Request attribution is ambiguous/);
  });
  await t.test('invalid state-version order', async () => {
    const rows = [line('stream_open', 0), line('stream_snapshot', 0, START + 1100, { stateVersion: 2 }),
      line('stream_snapshot', 0, START + 1150, { stateVersion: 1 })];
    const { readPage } = pageReader(captures([rows, lifecycle(1)]));
    await assert.rejects(collectSseReplicaAttribution(input(), readPage), /state version regression/);
  });
});

test('collector rejects out-of-window, malformed, and saturated log pages', async (t) => {
  await t.test('foreign CloudWatch timestamp', async () => {
    const { readPage } = pageReader(captures([[line('stream_open', 0, START - 1)], lifecycle(1)]));
    await assert.rejects(collectSseReplicaAttribution(input(), readPage), /outside capture window/);
  });
  await t.test('malformed run-owned operational event', async () => {
    const malformed = { timestamp: START + 1000, message: `not-json ${REQUEST_IDS[0]}` };
    const { readPage } = pageReader(captures([[malformed], lifecycle(1)]));
    await assert.rejects(collectSseReplicaAttribution(input(), readPage), /Malformed run-owned operational log/);
  });
  await t.test('more than the per-stream event limit', async () => {
    const saturated = Array.from({ length: SSE_ATTRIBUTION_LIMITS.eventsPerStream + 1 }, () => ({
      timestamp: START + 1, message: '{"level":30,"msg":"routine request"}',
    }));
    const pages = [saturated.slice(0, SSE_ATTRIBUTION_LIMITS.eventsPerStream), saturated.slice(SSE_ATTRIBUTION_LIMITS.eventsPerStream)];
    const { readPage } = pageReader(captures([pages, lifecycle(1)]));
    await assert.rejects(collectSseReplicaAttribution(input(), readPage), /event limit saturated/);
  });
  await t.test('page reader is constrained to the derived API streams', async () => {
    const { readPage, calls } = pageReader(captures([lifecycle(0), lifecycle(1)]));
    await collectSseReplicaAttribution(input(), readPage);
    assert.deepEqual([...new Set(calls.map((query) => query.logStream))], TASK_IDS.map((id) => `api/ApiContainer/${id}`));
  });
});

test('evidence validator rejects fabricated close claims and altered source bindings', async () => {
  const source = input();
  const { readPage } = pageReader(captures([lifecycle(0), lifecycle(1, { close: false })]));
  const evidence = await collectSseReplicaAttribution(source, readPage);
  const forged = structuredClone(evidence);
  forged.attributions[1].close = { reason: 'terminal', time: new Date(START + 1300).toISOString() };
  forged.attributions[1].lifecycleComplete = true;
  assert.throws(() => validateSseReplicaAttribution(forged, source), /Invalid stream close proof/);
  assert.throws(() => validateSseReplicaAttribution(evidence, { ...source, binding: { ...source.binding, serviceCommit: 'e'.repeat(40) } }), /Service source commit drift/);
});

test('terminal snapshots require a terminal close reason', async () => {
  const rows = [line('stream_open', 0), line('stream_snapshot', 0, START + 1100, { terminal: true }),
    line('stream_close', 0, START + 1200, { reason: 'client_abort' })];
  const { readPage } = pageReader(captures([rows, lifecycle(1)]));
  await assert.rejects(collectSseReplicaAttribution(input(), readPage), /close reason does not match its terminal snapshot/);
});

test('requireClosed demands a verified stream close', async () => {
  const source = input({ requireClosed: true });
  const { readPage } = pageReader(captures([lifecycle(0), lifecycle(1, { close: false })]));
  await assert.rejects(collectSseReplicaAttribution(source, readPage), /Missing exact stream attribution or required close/);
});
