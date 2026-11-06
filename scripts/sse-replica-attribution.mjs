import { isDeepStrictEqual } from 'node:util';

export const SSE_ATTRIBUTION_LIMITS = Object.freeze({
  tasks: 8, requests: 16, windowMs: 600_000, pagesPerStream: 8,
  eventsPerStream: 512, messageBytes: 4096, collectionMs: 30_000,
});

const TYPE = 'anywear.sse-replica-attribution';
const COMPONENT = 'task-status-sse';
const CONTAINER = 'ApiContainer';
const LOG_GROUP = '/anywear/beta/api';
const REQUEST_ID = /^[a-zA-Z0-9._:-]{1,128}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TASK_TYPES = ['auto-tagging', 'vto'];
const CLOSE_REASONS = ['terminal', 'client_abort', 'snapshot_failed', 'heartbeat_failed', 'stream_failed'];
const FAILURE_KINDS = ['not_started', 'timeout', 'notify_failed', 'superseded'];
const ENVELOPE = ['level', 'time', 'pid', 'hostname', 'msg'];
const EVENT_FIELDS = {
  listener_connected: ['listenerGeneration', 'reconnectCount'],
  listener_probe: ['listenerGeneration', 'ready', 'durationMs', 'failureKind', 'activeStreams'],
  listener_hint: ['listenerGeneration', 'taskType', 'taskId', 'resourceId', 'stateVersion'],
  stream_open: ['requestId', 'streamId', 'taskType', 'resourceId', 'activeStreams'],
  stream_snapshot: ['requestId', 'streamId', 'taskType', 'resourceId', 'stateVersion', 'terminal'],
  stream_close: ['requestId', 'streamId', 'taskType', 'resourceId', 'reason', 'activeStreams'],
  // Issue 277's owner-scoped aggregate stream has no resource identity: its
  // evidence carries the owner scope and counts only. These are deliberately
  // not `stream_*` events, so `attributeEvents` keeps ignoring them.
  owner_stream_open: ['requestId', 'streamId', 'scope', 'activeStreams'],
  owner_stream_snapshot: ['requestId', 'streamId', 'scope', 'frames', 'inFlight'],
  owner_stream_close: ['requestId', 'streamId', 'scope', 'reason', 'activeStreams'],
};

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function keys(value, required, optional, label) {
  object(value, label);
  if (required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new Error(`Unexpected or missing ${label} fields`);
  }
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${label}`);
  return value;
}

function match(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function utc(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`Invalid ${label} UTC time`);
  return Date.parse(value);
}

function boundedArray(value, maximum, label, minimum = 1) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`Invalid bounded ${label}`);
  return value;
}

function unique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
}

function validatedInput(input) {
  keys(input, ['binding', 'tasks', 'taskDefinitions', 'expectedRequests', 'window'], ['requireClosed'], 'collector input');
  if (input.requireClosed !== undefined && typeof input.requireClosed !== 'boolean') throw new Error('Invalid requireClosed');
  const binding = input.binding;
  keys(binding, ['stage', 'accountId', 'region', 'clusterArn', 'serviceArn', 'serviceCommit', 'imageDigest'], [], 'source binding');
  if (binding.stage !== 'beta') throw new Error('Source binding must be Beta');
  match(binding.accountId, /^\d{12}$/, 'account ID');
  match(binding.region, /^[a-z]{2}-[a-z]+-\d$/, 'region');
  match(binding.serviceCommit, /^[a-f0-9]{40}$/, 'Service source commit');
  match(binding.imageDigest, DIGEST, 'immutable image digest');
  const arnPrefix = `arn:aws:ecs:${binding.region}:${binding.accountId}:`;
  if (typeof binding.clusterArn !== 'string' || !binding.clusterArn.startsWith(`${arnPrefix}cluster/`)) throw new Error('Foreign cluster ARN');
  const cluster = binding.clusterArn.slice(`${arnPrefix}cluster/`.length);
  match(cluster, /^[a-zA-Z0-9_-]{1,255}$/, 'cluster name');
  if (typeof binding.serviceArn !== 'string' || !binding.serviceArn.startsWith(`${arnPrefix}service/${cluster}/`)) throw new Error('Foreign service ARN');
  const service = binding.serviceArn.slice(`${arnPrefix}service/${cluster}/`.length);
  match(service, /^[a-zA-Z0-9_-]{1,255}$/, 'service name');
  keys(input.window, ['startTime', 'endTime'], [], 'capture window');
  const startTime = utc(input.window.startTime, 'window start');
  const endTime = utc(input.window.endTime, 'window end');
  if (endTime <= startTime || endTime - startTime > SSE_ATTRIBUTION_LIMITS.windowMs) throw new Error('Unbounded capture window');
  const requests = boundedArray(input.expectedRequests, SSE_ATTRIBUTION_LIMITS.requests, 'expected requests').map((request) => {
    keys(request, ['sourceRequestId', 'taskType', 'resourceId'], [], 'expected request');
    match(request.sourceRequestId, REQUEST_ID, 'source request ID');
    match(request.resourceId, UUID, 'resource ID');
    if (!TASK_TYPES.includes(request.taskType)) throw new Error('Invalid task type');
    return { ...request };
  });
  unique(requests.map((request) => request.sourceRequestId), 'source request IDs');
  const definitions = new Map();
  for (const captured of boundedArray(input.taskDefinitions, SSE_ATTRIBUTION_LIMITS.tasks, 'task definitions')) {
    keys(captured, ['taskDefinition'], [], 'captured task definition');
    const definition = object(captured.taskDefinition, 'task definition');
    if (typeof definition.taskDefinitionArn !== 'string' || !definition.taskDefinitionArn.startsWith(`${arnPrefix}task-definition/`)
      || !/^[a-zA-Z0-9_-]+:[1-9][0-9]*$/.test(definition.taskDefinitionArn.slice(`${arnPrefix}task-definition/`.length))) throw new Error('Foreign task definition ARN');
    if (definitions.has(definition.taskDefinitionArn)) throw new Error('Duplicate task definition');
    const containers = boundedArray(definition.containerDefinitions, 16, 'definition containers').filter((entry) => entry.name === CONTAINER);
    if (containers.length !== 1) throw new Error('Ambiguous API container definition');
    const container = containers[0];
    const commits = boundedArray(container.environment, 128, 'container environment').filter((entry) => entry.name === 'SERVICE_COMMIT_SHA');
    if (commits.length !== 1 || commits[0].value !== binding.serviceCommit) throw new Error('Service source commit drift');
    const repository = '(?:[a-z0-9]+(?:[._-][a-z0-9]+)*)(?:/(?:[a-z0-9]+(?:[._-][a-z0-9]+)*))*';
    const image = match(container.image, new RegExp(`^${binding.accountId}\\.dkr\\.ecr\\.${binding.region}\\.amazonaws\\.com/${repository}@sha256:[a-f0-9]{64}$`), 'immutable API image URI');
    if (!image.endsWith(`@${binding.imageDigest}`)) throw new Error('Task definition image digest drift');
    const log = object(container.logConfiguration, 'awslogs configuration');
    if (log.logDriver !== 'awslogs' || log.secretOptions?.length) throw new Error('Unexpected API log driver or secrets');
    const options = object(log.options, 'awslogs options');
    if (options['awslogs-group'] !== LOG_GROUP || options['awslogs-region'] !== binding.region
      || options['awslogs-stream-prefix'] !== 'api') throw new Error('Foreign awslogs configuration');
    definitions.set(definition.taskDefinitionArn, { image, used: false });
  }
  const taskBindings = boundedArray(input.tasks, SSE_ATTRIBUTION_LIMITS.tasks, 'current API tasks', 2).map((task) => {
    object(task, 'captured task');
    const taskArn = match(task.taskArn, new RegExp(`^${arnPrefix}task/${cluster}/[a-f0-9]{32}$`), 'task ARN');
    if (task.clusterArn !== binding.clusterArn || task.group !== `service:${service}` || task.lastStatus !== 'RUNNING'
      || task.desiredStatus !== 'RUNNING') throw new Error('Foreign or non-running API task');
    const definition = definitions.get(task.taskDefinitionArn);
    if (!definition) throw new Error('Missing exact task definition join');
    definition.used = true;
    const containers = boundedArray(task.containers, 16, 'task containers').filter((entry) => entry.name === CONTAINER);
    if (containers.length !== 1 || containers[0].lastStatus !== 'RUNNING'
      || containers[0].imageDigest !== binding.imageDigest || containers[0].image !== definition.image) throw new Error('API container source or digest drift');
    return { taskArn, taskDefinitionArn: task.taskDefinitionArn, logGroup: LOG_GROUP,
      expectedLogStream: `api/${CONTAINER}/${taskArn.split('/').at(-1)}` };
  });
  unique(taskBindings.map((task) => task.taskArn), 'API task ARNs');
  if ([...definitions.values()].some((definition) => !definition.used)) throw new Error('Foreign unused task definition');
  return { binding: { ...binding }, requests, taskBindings, window: { ...input.window }, startTime, endTime, requireClosed: input.requireClosed === true };
}

function parseOperational(event, config) {
  object(event, 'log event');
  keys(event, ['timestamp', 'message'], ['ingestionTime'], 'log event');
  integer(event.timestamp, 'log timestamp', 1);
  if (event.timestamp < config.startTime || event.timestamp > config.endTime) throw new Error('Log timestamp outside capture window');
  if (event.ingestionTime !== undefined) integer(event.ingestionTime, 'ingestion time', 1);
  if (typeof event.message !== 'string' || Buffer.byteLength(event.message, 'utf8') > SSE_ATTRIBUTION_LIMITS.messageBytes) throw new Error('Oversized or malformed log message');
  let parsed;
  try { parsed = JSON.parse(event.message); } catch {
    if (event.message.includes(COMPONENT) || config.requests.some((request) => event.message.includes(request.sourceRequestId))) throw new Error('Malformed run-owned operational log');
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  if (parsed.component !== COMPONENT) {
    if (config.requests.some((request) => request.sourceRequestId === parsed.requestId) && parsed.event?.startsWith('stream_')) throw new Error('Foreign stream event component');
    return;
  }
  const fields = EVENT_FIELDS[parsed.event];
  if (!fields || parsed.stage !== 'beta') throw new Error('Foreign or unknown SSE operational event');
  const required = ['component', 'stage', 'event', 'time', ...fields.filter((field) => field !== 'failureKind')];
  keys(parsed, required, [...ENVELOPE.filter((field) => field !== 'time'), ...(parsed.event === 'listener_probe' ? ['failureKind'] : [])], 'operational event');
  integer(parsed.time, 'Pino time', 1);
  if (Math.abs(parsed.time - event.timestamp) > 5000) throw new Error('Pino and CloudWatch time mismatch');
  if (parsed.msg !== undefined && parsed.msg !== 'SSE operational event') throw new Error('Unexpected operational message label');
  if (parsed.level !== undefined) integer(parsed.level, 'Pino level');
  if (parsed.pid !== undefined) integer(parsed.pid, 'Pino PID', 1);
  if (parsed.hostname !== undefined) match(parsed.hostname, /^[a-zA-Z0-9._-]{1,255}$/, 'Pino hostname');
  for (const field of ['activeStreams', 'reconnectCount', 'listenerGeneration', 'stateVersion', 'frames', 'inFlight']) {
    if (Object.hasOwn(parsed, field)) integer(parsed[field], field, field === 'stateVersion' ? 1 : 0);
  }
  if (parsed.event.startsWith('stream_')) {
    match(parsed.requestId, REQUEST_ID, 'request ID');
    match(parsed.streamId, UUID, 'stream ID');
  }
  // The owner-scoped events must stay exactly as strict as the per-request ones:
  // a literal owner scope and the same bounded identities, with no resource or
  // task field to loosen them.
  if (parsed.event.startsWith('owner_stream_')) {
    if (parsed.scope !== 'owner') throw new Error('Invalid owner stream scope');
    match(parsed.requestId, REQUEST_ID, 'request ID');
    match(parsed.streamId, UUID, 'stream ID');
  }
  if (Object.hasOwn(parsed, 'taskType') && !TASK_TYPES.includes(parsed.taskType)) throw new Error('Invalid operational task type');
  for (const field of ['taskId', 'resourceId']) if (Object.hasOwn(parsed, field)) match(parsed[field], UUID, field);
  if (Object.hasOwn(parsed, 'terminal') && typeof parsed.terminal !== 'boolean') throw new Error('Invalid terminal flag');
  if ((parsed.event === 'stream_close' || parsed.event === 'owner_stream_close') && !CLOSE_REASONS.includes(parsed.reason)) throw new Error('Invalid stream close reason');
  if (parsed.event === 'listener_probe') {
    if (typeof parsed.ready !== 'boolean' || !Number.isFinite(parsed.durationMs) || parsed.durationMs < 0
      || parsed.durationMs > SSE_ATTRIBUTION_LIMITS.windowMs || (parsed.ready ? parsed.failureKind !== undefined : !FAILURE_KINDS.includes(parsed.failureKind))) throw new Error('Invalid listener probe');
  }
  return { ...Object.fromEntries(['component', 'stage', 'event', ...fields].filter((field) => Object.hasOwn(parsed, field)).map((field) => [field, parsed[field]])),
    time: new Date(event.timestamp).toISOString() };
}

async function readBoundedStream(readPage, task, config, deadline) {
  const events = [];
  const seenTokens = new Set();
  let nextToken;
  let previousTimestamp = -1;
  for (let page = 0; page < SSE_ATTRIBUTION_LIMITS.pagesPerStream; page += 1) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error('SSE log collection deadline exceeded');
    let timer;
    let response;
    try {
      response = await Promise.race([
        Promise.resolve().then(() => readPage({ logGroup: task.logGroup, logStream: task.expectedLogStream,
          startTime: config.startTime, endTime: config.endTime, nextToken })),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SSE log collection deadline exceeded')), remaining); }),
      ]);
    } finally { clearTimeout(timer); }
    keys(response, ['events', 'nextForwardToken'], [], 'log page');
    boundedArray(response.events, SSE_ATTRIBUTION_LIMITS.eventsPerStream, 'page events', 0);
    match(response.nextForwardToken, /^[\x21-\x7e]{1,1024}$/, 'forward pagination token');
    if (response.nextForwardToken === nextToken) {
      if (response.events.length) throw new Error('Repeated pagination token with new events');
      return events;
    }
    if (seenTokens.has(response.nextForwardToken)) throw new Error('Pagination token cycle');
    seenTokens.add(response.nextForwardToken);
    if (events.length + response.events.length > SSE_ATTRIBUTION_LIMITS.eventsPerStream) throw new Error('SSE log event limit saturated');
    for (const event of response.events) {
      const operational = parseOperational(event, config);
      if (event.timestamp < previousTimestamp) throw new Error('Log event time regressed');
      previousTimestamp = event.timestamp;
      events.push({ operational });
    }
    nextToken = response.nextForwardToken;
  }
  throw new Error('SSE log pagination incomplete at page limit');
}

function attributeEvents(captures, config) {
  const requestMap = new Map(config.requests.map((request) => [request.sourceRequestId, request]));
  const entries = new Map();
  const streamOwners = new Map();
  for (const { task, events } of captures) {
    for (const { operational: event } of events) {
      if (!event?.event.startsWith('stream_')) continue;
      const request = requestMap.get(event.requestId);
      const owner = streamOwners.get(event.streamId);
      if (owner && (owner.requestId !== event.requestId || owner.taskArn !== task.taskArn)) throw new Error('Stream/task attribution collision');
      if (!request) continue;
      if (event.taskType !== request.taskType || event.resourceId !== request.resourceId) throw new Error('Foreign request resource or task type');
      let entry = entries.get(event.requestId);
      if (entry && (entry.taskArn !== task.taskArn || entry.streamId !== event.streamId)) throw new Error('Request attribution is ambiguous');
      if (event.event === 'stream_open') {
        if (entry) throw new Error('Duplicate or post-close stream open');
        entry = { ...task, requestId: event.requestId, sourceRequestId: request.sourceRequestId,
          streamId: event.streamId, taskType: event.taskType, resourceId: event.resourceId, time: event.time,
          snapshots: [], lifecycleComplete: false };
        entries.set(event.requestId, entry);
        streamOwners.set(event.streamId, entry);
      } else {
        if (!entry) throw new Error('Stream snapshot or close without an explicit open');
        if (entry.close) throw new Error('Stream event after close');
        if (event.event === 'stream_snapshot') {
          const previous = entry.snapshots.at(-1);
          if (previous?.terminal || (previous && event.stateVersion <= previous.stateVersion)) throw new Error('Snapshot after terminal or state version regression');
          entry.snapshots.push({ stateVersion: event.stateVersion, terminal: event.terminal, time: event.time });
        } else {
          const terminalSnapshot = entry.snapshots.at(-1)?.terminal === true;
          if ((event.reason === 'terminal') !== terminalSnapshot) throw new Error('Stream close reason does not match its terminal snapshot');
          entry.close = { reason: event.reason, time: event.time };
          entry.lifecycleComplete = true;
        }
      }
    }
  }
  const attributions = config.requests.map((request) => entries.get(request.sourceRequestId));
  if (attributions.some((entry) => !entry || (config.requireClosed && !entry.close))) throw new Error('Missing exact stream attribution or required close');
  const distinctApiTaskArns = [...new Set(attributions.map((entry) => entry.taskArn))].sort();
  if (distinctApiTaskArns.length < 2) throw new Error('Replica attribution requires two distinct current API tasks');
  return { schemaVersion: 1, type: TYPE, sourceBinding: config.binding, window: config.window, attributions, distinctApiTaskArns };
}

export async function collectSseReplicaAttribution(input, readPage) {
  const config = validatedInput(input);
  if (typeof readPage !== 'function') throw new Error('A captured log page reader is required');
  const deadline = performance.now() + SSE_ATTRIBUTION_LIMITS.collectionMs;
  const captures = [];
  for (const task of config.taskBindings) captures.push({ task, events: await readBoundedStream(readPage, task, config, deadline) });
  const evidence = attributeEvents(captures, config);
  return validateSseReplicaAttribution(evidence, input);
}

export function validateSseReplicaAttribution(evidence, input) {
  const config = validatedInput(input);
  keys(evidence, ['schemaVersion', 'type', 'sourceBinding', 'window', 'attributions', 'distinctApiTaskArns'], [], 'attribution evidence');
  if (evidence.schemaVersion !== 1 || evidence.type !== TYPE || !isDeepStrictEqual(evidence.sourceBinding, config.binding)
    || !isDeepStrictEqual(evidence.window, config.window)) throw new Error('Attribution source or window drift');
  boundedArray(evidence.attributions, SSE_ATTRIBUTION_LIMITS.requests, 'attributions');
  if (evidence.attributions.length !== config.requests.length) throw new Error('Missing or extra request attribution');
  unique(evidence.attributions.map((entry) => entry.requestId), 'attributed request IDs');
  unique(evidence.attributions.map((entry) => entry.streamId), 'attributed stream IDs');
  const eventTime = (value) => {
    const timestamp = utc(value, 'attribution');
    if (timestamp < config.startTime || timestamp > config.endTime) throw new Error('Attribution time outside capture window');
    return timestamp;
  };
  for (const entry of evidence.attributions) {
    keys(entry, ['taskArn', 'taskDefinitionArn', 'logGroup', 'expectedLogStream', 'requestId', 'sourceRequestId', 'streamId',
      'taskType', 'resourceId', 'time', 'snapshots', 'lifecycleComplete'], ['close'], 'attribution');
    const task = config.taskBindings.find((task) => task.taskArn === entry.taskArn);
    const request = config.requests.find((request) => request.sourceRequestId === entry.sourceRequestId);
    if (!task || !request || entry.requestId !== entry.sourceRequestId || entry.taskType !== request.taskType || entry.resourceId !== request.resourceId
      || Object.keys(task).some((field) => entry[field] !== task[field])) throw new Error('Foreign task or request attribution');
    match(entry.streamId, UUID, 'attributed stream ID');
    let time = eventTime(entry.time);
    let previous;
    for (const snapshot of boundedArray(entry.snapshots, SSE_ATTRIBUTION_LIMITS.eventsPerStream - 1, 'snapshots', 0)) {
      keys(snapshot, ['stateVersion', 'terminal', 'time'], [], 'snapshot');
      integer(snapshot.stateVersion, 'snapshot version', 1);
      const timestamp = eventTime(snapshot.time);
      if (typeof snapshot.terminal !== 'boolean' || timestamp < time || previous?.terminal
        || (previous && snapshot.stateVersion <= previous.stateVersion)) throw new Error('Snapshot time or version regression');
      time = timestamp;
      previous = snapshot;
    }
    if (entry.close) {
      keys(entry.close, ['reason', 'time'], [], 'stream close');
      if (!CLOSE_REASONS.includes(entry.close.reason) || eventTime(entry.close.time) < time
        || ((entry.close.reason === 'terminal') !== (previous?.terminal === true))) throw new Error('Invalid stream close proof');
    }
    if (entry.lifecycleComplete !== Boolean(entry.close) || (config.requireClosed && !entry.close)) throw new Error('Invalid lifecycle completion claim');
  }
  const distinct = [...new Set(evidence.attributions.map((entry) => entry.taskArn))].sort();
  if (distinct.length < 2 || !isDeepStrictEqual(distinct, evidence.distinctApiTaskArns)) throw new Error('Distinct API task attribution is not exact');
  return evidence;
}
