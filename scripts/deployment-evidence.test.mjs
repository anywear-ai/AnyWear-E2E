import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SERVICE_RELEASE_ASSET_NAMES,
  assertStableObservation,
  collectDeploymentEvidence,
  serviceArtifactsTag,
  validateObservation,
} from './deployment-evidence.mjs';
import { readMinimumSupportedClient } from './minimum-supported-client.mjs';

// #358: the gate's deployment-evidence core, moved out of the deleted qualification ledger.
// These cases hold the two things the gate still reads from the live system - the Client and
// Service identities, and the committed Client floor - plus the before/after stability check
// and the frozen Service release identity. Nothing here executes a deployed scenario, reads
// AWS or writes a record.

const floor = readMinimumSupportedClient();
const sha = (letter) => letter.repeat(40);
const image = `sha256:${'c'.repeat(64)}`;

function liveFetcher({ client, service }) {
  return async (url) => new Response(JSON.stringify(url.pathname === '/build-metadata.json' ? client : service), { status: 200 });
}

const liveClient = (overrides = {}) => ({
  component: 'AnyWear-Client',
  schema_version: 3,
  source_commit: sha('a'),
  client_version: floor.version,
  built_at: '2026-10-07T00:00:00.000Z',
  ...overrides,
});
const liveService = (overrides = {}) => ({
  status: 'ok',
  service_commit: sha('b'),
  image_digest: image,
  minimum_client_version: floor.version,
  ...overrides,
});
const collect = (client = liveClient(), service = liveService(), expected = {}, minimumSupportedClient = floor) =>
  collectDeploymentEvidence({
    clientUrl: 'https://client123.cloudfront.net',
    serviceUrl: 'https://api123.cloudfront.net',
    runId: '123',
    minimumSupportedClient,
  }, expected, liveFetcher({ client, service }));

// One observation of the live tuple, in the shape `collect-deployment-evidence.mjs` writes.
// It carries no `platform` member: #358 removed the full-resource snapshot with the ledger.
function observation({ collectedAt = '2026-10-08T00:00:00.000Z', clientSha = sha('a'), serviceSha = sha('b'), digest = image } = {}) {
  return {
    collected_at: collectedAt,
    client: { url: 'https://client123.cloudfront.net', source_commit: clientSha, built_at: '2026-10-07T00:00:00.000Z' },
    service: { url: 'https://api123.cloudfront.net', service_commit: serviceSha, image_digest: digest },
    authenticated: true,
  };
}

test('collects only the live identities and the committed floor', async () => {
  const collected = await collect(liveClient({ client_version: floor.version + 4 }));
  assert.deepEqual(collected.client, {
    url: 'https://client123.cloudfront.net',
    source_commit: sha('a'),
    built_at: '2026-10-07T00:00:00.000Z',
  });
  assert.deepEqual(collected.service, {
    url: 'https://api123.cloudfront.net',
    service_commit: sha('b'),
    image_digest: image,
  });
  assert.equal(collected.client_version, floor.version + 4);
  assert.equal(collected.minimum_client_version, floor.version);
  await assert.doesNotReject(collect(liveClient(), liveService(), {
    service_commit: sha('b'),
    client_commit: sha('a'),
  }));
});

test('refuses a live identity that differs from the dispatch expectation and names both values', async () => {
  const expectedService = sha('f');
  await assert.rejects(collect(liveClient(), liveService(), { service_commit: expectedService }),
    new RegExp(`Deployed Service service_commit mismatch[^\\n]*expected ${expectedService} \\(dispatch input\\), observed ${sha('b')} \\(live\\)`));
  const expectedClient = sha('f');
  await assert.rejects(collect(liveClient(), liveService(), { client_commit: expectedClient }),
    new RegExp(`Deployed Client source_commit mismatch[^\\n]*expected ${expectedClient} \\(dispatch input\\), observed ${sha('a')} \\(live\\)`));
});

test('refuses a live floor that disagrees with the committed file and tells the operator to sync it', async () => {
  const observed = floor.version + 1;
  await assert.rejects(collect(liveClient(), liveService({ minimum_client_version: observed })),
    new RegExp(`Deployed Service minimum_client_version ${observed} differs from minimum-supported-client\\.json version ${floor.version}[^\\n]*sync minimum-supported-client\\.json`));
  await assert.rejects(collect(liveClient({ client_version: 0 }), liveService({ minimum_client_version: 1 }), {}, { version: 1 }),
    /Deployed Client client_version 0 is below minimum-supported-client\.json version 1/);
  await assert.rejects(collect(liveClient({ schema_version: 2 })),
    /schema_version is 2, expected 3/);
  await assert.rejects(collect(liveClient({ component: 'Other' })),
    /Client build metadata component is "Other", expected "AnyWear-Client"/);
  await assert.rejects(collect(liveClient(), liveService({ status: 'down' })),
    /Deployed Service \/health status is "down", expected "ok"/);
  await assert.rejects(collect(liveClient(), liveService({ minimum_client_version: '0' })),
    /minimum_client_version must be a non-negative safe integer/);
  const { minimum_client_version: ignored, ...withoutFloor } = liveService();
  void ignored;
  await assert.rejects(collect(liveClient(), withoutFloor), /minimum_client_version must be a non-negative safe integer/);
});

test('refuses a floor file that still names a Client commit', async () => {
  // #256: the committed manifest states the reviewed floor version only. A leftover `sha`
  // from the deleted oldest-Client leg is refused by the exact-key check, never read as a
  // no-op that would leave a stale reference in the live path.
  await assert.rejects(collect(liveClient(), liveService(), {}, { version: floor.version, sha: sha('a') }),
    /minimum-supported-client\.json\.sha is unknown/);
});

test('requires a stable observation and refuses each changed identity by name', () => {
  const before = observation();
  const after = observation({ collectedAt: '2026-10-08T00:10:00.000Z' });
  assert.doesNotThrow(() => assertStableObservation(before, structuredClone(after)));
  for (const [label, mutate, pattern] of [
    ['client source', (o) => { o.client.source_commit = sha('f'); }, /Deployed Client identity mismatch/],
    ['service commit', (o) => { o.service.service_commit = sha('e'); }, /Deployed Service identity mismatch/],
    ['service image', (o) => { o.service.image_digest = `sha256:${'f'.repeat(64)}`; }, /Deployed Service identity mismatch/],
  ]) {
    const changed = structuredClone(after);
    mutate(changed);
    assert.throws(() => assertStableObservation(before, changed), pattern, label);
  }
});

test('refuses an observation that is unauthenticated or wrongly shaped', () => {
  for (const [label, mutate, pattern] of [
    ['authenticated false', (o) => { o.authenticated = false; }, /must state authenticated: true/],
    ['authenticated string', (o) => { o.authenticated = 'true'; }, /must state authenticated: true/],
    ['unknown member', (o) => { o.schema_version = 1; }, /observation\.schema_version is unknown/],
    ['retired platform member', (o) => { o.platform = { stacks: [] }; }, /observation\.platform is unknown/],
    ['bad collected_at', (o) => { o.collected_at = 'yesterday'; }, /collected_at must be an ISO timestamp/],
    ['bad built_at', (o) => { o.client.built_at = 'sometime'; }, /client\.built_at must be an ISO timestamp/],
    ['plain-http url', (o) => { o.client.url = 'http://client123.cloudfront.net'; }, /client\.url must use HTTPS/],
    ['malformed image digest', (o) => { o.service.image_digest = 'sha256:abc'; }, /malformed/],
    ['missing service commit', (o) => { delete o.service.service_commit; }, /observation service\.service_commit is required/],
  ]) {
    const candidate = observation();
    mutate(candidate);
    assert.throws(() => validateObservation(candidate, 'observation'), pattern, label);
  }
  assert.equal(validateObservation(observation(), 'observation').authenticated, true);
});

test('freezes the four Service release asset names and derives the release tag from the commit', () => {
  // #193: the gate accepts exactly the four released assets. The Service publishes these
  // names, the release read verifies each digest, and an extra legacy asset is ignored.
  assert.deepEqual([...SERVICE_RELEASE_ASSET_NAMES], [
    'pre-sign-up.zip',
    'post-confirmation.zip',
    'runtime-policy.json',
    'service-schema.json',
  ]);
  assert.equal(serviceArtifactsTag(sha('b')), `service-artifacts-${sha('b')}`);
  assert.throws(() => serviceArtifactsTag('main'), /malformed/);
});
