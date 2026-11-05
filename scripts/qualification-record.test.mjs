import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SERVICE_RELEASE_ASSET_NAMES,
  assertObservationSequence,
  assertStableObservation,
  buildQualificationRecord,
  collectDeploymentEvidence,
  validateObservation,
  verifyQualificationAgainstReport,
  verifyQualificationRecord,
} from './qualification-record.mjs';
import { ENVIRONMENT_VERDICT_PATH, environmentVerdict, qualificationRefusalMessage } from './qualification-environment.mjs';
import { byteHash, contentHash, payloadDigest } from './evidence-contract.mjs';
import { qualificationFixture } from './fixtures/infra-qualification.mjs';

const now = new Date('2026-10-08T00:20:00.000Z');
const qualify = (fixture, overrides = {}) => buildQualificationRecord(
  { ...fixture.input, ...overrides.input },
  'expected' in overrides ? overrides.expected : fixture.expected,
  overrides.evidence ?? fixture.evidence,
  now,
  'environment' in overrides ? overrides.environment : fixture.environment,
  overrides.report ?? fixture.report,
);

const fixture = () => qualificationFixture();
const floor = fixture().floor;

// Re-digesting a hand-edited record proves only that whoever wrote it knew the algorithm.
// Every case below edits a field and recomputes `integrity.payload_sha256`, so the record
// passes its checksum and has to be refused by the verifier's own derivation instead.
function redigest(record) {
  const { integrity: ignored, ...payload } = record;
  void ignored;
  return { ...payload, integrity: { algorithm: 'sha256', payload_sha256: payloadDigest(payload) } };
}

const issuedRecord = (options) => {
  const f = qualificationFixture(options);
  return { fixture: f, record: qualify(f) };
};

function liveFetcher({ client, service }) {
  return async (url) => new Response(JSON.stringify(url.pathname === '/build-metadata.json' ? client : service), { status: 200 });
}

const liveClient = (overrides = {}) => ({
  component: 'AnyWear-Client',
  schema_version: 3,
  source_commit: 'a'.repeat(40),
  client_version: floor.version,
  built_at: '2026-10-07T00:00:00.000Z',
  ...overrides,
});
const liveService = (overrides = {}) => ({
  status: 'ok',
  service_commit: 'b'.repeat(40),
  image_digest: `sha256:${'c'.repeat(64)}`,
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

test('collects only the live identities and the committed floor', async () => {
  const collected = await collect(liveClient({ client_version: floor.version + 4 }));
  assert.deepEqual(collected.client, {
    url: 'https://client123.cloudfront.net',
    source_commit: 'a'.repeat(40),
    built_at: '2026-10-07T00:00:00.000Z',
  });
  assert.deepEqual(collected.service, {
    url: 'https://api123.cloudfront.net',
    service_commit: 'b'.repeat(40),
    image_digest: `sha256:${'c'.repeat(64)}`,
  });
  assert.equal(collected.client_version, floor.version + 4);
  assert.equal(collected.minimum_client_version, floor.version);
  await assert.doesNotReject(collect(liveClient(), liveService(), {
    service_commit: 'b'.repeat(40),
    client_commit: 'a'.repeat(40),
  }));
});

test('refuses a live identity that differs from the dispatch expectation and names both values', async () => {
  const expectedService = 'f'.repeat(40);
  await assert.rejects(collect(liveClient(), liveService(), { service_commit: expectedService }),
    new RegExp(`Deployed Service service_commit mismatch[^\\n]*expected ${expectedService} \\(dispatch input\\), observed ${'b'.repeat(40)} \\(live\\)`));
  const expectedClient = 'f'.repeat(40);
  await assert.rejects(collect(liveClient(), liveService(), { client_commit: expectedClient }),
    new RegExp(`Deployed Client source_commit mismatch[^\\n]*expected ${expectedClient} \\(dispatch input\\), observed ${'a'.repeat(40)} \\(live\\)`));
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
  await assert.rejects(collect(liveClient(), liveService(), {}, { version: floor.version, sha: 'a'.repeat(40) }),
    /minimum-supported-client\.json\.sha is unknown/);
});

test('creates and verifies a checksummed passing v4 record from the live tuple', () => {
  const f = fixture();
  const record = qualify(f);
  assert.equal(record.schema_version, 4);
  assert.equal(record.qualification_id, 'beta-123-1');
  assert.equal(record.operation, 'full');
  assert.deepEqual(record.expected, { service_commit: f.serviceSha, client_commit: f.clientSha, source: 'trigger' });
  assert.deepEqual(record.revisions.e2e, { repository: 'anywear-ai/AnyWear-E2E', sha: f.input.e2eSha });
  assert.deepEqual(record.revisions.client, { repository: 'anywear-ai/AnyWear-Client', sha: f.clientSha, client_version: f.clientVersion });
  assert.deepEqual(record.revisions.service, {
    repository: 'anywear-ai/AnyWear-Service', sha: f.serviceSha, image_digest: f.image, minimum_client_version: f.minimumClientVersion,
  });
  assert.equal(record.revisions.infra, undefined);
  assert.equal(record.compatibility, undefined);
  assert.equal(record.deployment, undefined);
  // v4: the release's own identity, not a manifest asset. The tag names the qualified
  // Service commit, and the tag's target commit is that same commit.
  assert.deepEqual(record.service_artifacts, {
    repository: 'anywear-ai/AnyWear-Service',
    release_id: 10,
    tag: `service-artifacts-${f.serviceSha}`,
    target_commit: f.serviceSha,
    assets: f.evidence.service_artifacts.assets,
  });
  assert.deepEqual(Object.keys(record.service_artifacts.assets), [...SERVICE_RELEASE_ASSET_NAMES]);
  assert.equal('manifest_asset_id' in record.service_artifacts, false);
  assert.equal('manifest_sha256' in record.service_artifacts, false);
  assert.equal(record.observations.before.authenticated, true);
  assert.deepEqual(record.observations.after.platform.client_domain, f.clientDomain);
  assert.deepEqual(record.workflow.trigger, 'manual');
  assert.equal(record.workflow.dispatched_by, null);
  assert.deepEqual(record.test.scenarios, [
    { file: 'tests/auth-startup.spec.ts', outcome: 'passed', collected: 1, skipped: 0 },
    { file: 'tests/rejection-contract.spec.ts', outcome: 'passed', collected: 1, skipped: 0 },
    { file: 'tests/vto.spec.ts', outcome: 'passed', collected: 1, skipped: 0 },
    { file: 'tests/wardrobe.spec.ts', outcome: 'passed', collected: 1, skipped: 0 },
    { file: 'tests/worker-smoke.spec.ts', outcome: 'passed', collected: 1, skipped: 0 },
  ]);
  assert.equal(verifyQualificationRecord(record), true);

  const tampered = structuredClone(record);
  tampered.revisions.service.sha = 'e'.repeat(40);
  assert.throws(() => verifyQualificationRecord(tampered), /checksum mismatch/);
});

// #180: the record cannot carry the pin members. A record that still states
// `compatibility`, `deployment` or `revisions.infra` is refused by the exact key sets,
// even after its checksum is recomputed. #193: only schema v4 is live; a v2 or v3 record
// names a manifest asset that no longer exists and is refused with the observed version.
test('refuses a record that still carries a pin, a deployment record or an infra revision', () => {
  const { record } = issuedRecord();
  for (const [label, mutate] of [
    ['compatibility', (copy) => { copy.compatibility = { version: 3 }; }],
    ['deployment', (copy) => { copy.deployment = { platform: {}, workload: {} }; }],
    ['revisions.infra', (copy) => { copy.revisions.infra = { repository: 'anywear-ai/AnyWear-Infra', sha: 'e'.repeat(40) }; }],
  ]) {
    const tampered = structuredClone(record);
    mutate(tampered);
    assert.throws(() => verifyQualificationRecord(redigest(tampered)), new RegExp(`${label.replace('.', '\\.')} is unknown`), label);
  }
  for (const version of [1, 2, 3, 5, undefined, '4']) {
    assert.throws(() => verifyQualificationRecord({ schema_version: version, record_type: 'anywear_beta_qualification' }),
      /Unsupported qualification record schema: observed schema_version/, `${version} must not verify`);
  }
});

test('binds the dispatched full operation and refuses every other operation', () => {
  const f = fixture();
  const build = (operation) => buildQualificationRecord({ ...f.input, operation }, f.expected, f.evidence, now, f.environment, f.report);
  assert.equal(build('full').operation, 'full');
  // #217: the removed `recover` operation must be refused like any other non-`full` value.
  for (const operation of ['smoke', 'reconcile', 'recover', undefined]) {
    let refusal;
    try { build(operation); } catch (error) { refusal = error; }
    assert.ok(refusal, `${operation} must not issue a record`);
    assert.match(refusal.message, /full qualification operation/);
  }
  const tampered = structuredClone(build('full'));
  tampered.operation = 'smoke';
  assert.throws(() => verifyQualificationRecord(redigest(tampered)), /operation must be full/);
});

// #180 acceptance: a manual `full` without an expected service commit takes the live
// value at run start and records `expected.source: live`; a supplied commit records
// `source: trigger` and is compared with the live identity.
test('states the expectation source and binds it to the live tuple', () => {
  const live = issuedRecord({ expectedSource: 'live' });
  assert.deepEqual(live.record.expected, { service_commit: live.fixture.serviceSha, client_commit: null, source: 'live' });
  assert.equal(verifyQualificationRecord(live.record), true);
  assert.equal(live.record.expected.service_commit, live.record.revisions.service.sha);

  const triggered = issuedRecord();
  assert.equal(triggered.record.expected.source, 'trigger');
  const liveWithClient = qualify(fixture(), {
    expected: { service_commit: null, client_commit: triggered.fixture.clientSha, source: 'live' },
  });
  assert.equal(liveWithClient.expected.client_commit, triggered.fixture.clientSha);
  assert.equal(liveWithClient.expected.source, 'live');

  for (const [expected, pattern] of [
    [{ service_commit: 'f'.repeat(40), client_commit: null, source: 'trigger' }, /Expected Service commit mismatch: expected f{40} \(dispatch input\), observed b{40} \(live\)/],
    [{ service_commit: null, client_commit: 'f'.repeat(40), source: 'live' }, /Expected Client commit mismatch: expected f{40} \(dispatch input\), observed a{40} \(live\)/],
    [{ service_commit: null, client_commit: null, source: 'trigger' }, /expected\.source trigger requires a supplied expected service commit/],
    [{ service_commit: 'b'.repeat(40), client_commit: null, source: 'live' }, /requires expected\.source to be trigger/],
    [{ service_commit: 'b'.repeat(40), client_commit: null, source: 'somewhere' }, /expected\.source must be trigger, live/],
    [{ service_commit: 'main', client_commit: null, source: 'trigger' }, /expected\.service_commit must be a full lowercase 40-character commit SHA/],
  ]) {
    assert.throws(() => qualify(fixture(), { expected }), pattern);
  }
});

test('records the dispatch trigger and refuses an impossible trigger binding', () => {
  const manual = issuedRecord();
  assert.equal(manual.record.workflow.trigger, 'manual');
  const release = issuedRecord({ trigger: 'release-qualify', dispatchedBy: 'https://github.com/anywear-ai/AnyWear-Service/actions/runs/123' });
  assert.equal(release.record.workflow.trigger, 'release-qualify');
  assert.equal(release.record.workflow.dispatched_by, 'https://github.com/anywear-ai/AnyWear-Service/actions/runs/123');
  assert.equal(verifyQualificationRecord(release.record), true);

  const build = (input, expected = manual.fixture.expected) => buildQualificationRecord(
    { ...manual.fixture.input, ...input }, expected, manual.fixture.evidence, now, manual.fixture.environment, manual.fixture.report);
  assert.throws(() => build({ trigger: 'deploy-smoke' }), /deploy-smoke trigger only dispatches the smoke operation/);
  assert.throws(() => build({ trigger: 'release-qualify', dispatchedBy: 'https://github.com/anywear-ai/AnyWear-E2E/actions/runs/1' },
    { service_commit: null, client_commit: null, source: 'live' }), /release-qualify trigger requires a supplied expected service commit/);
  assert.throws(() => build({ trigger: 'release-qualify' }), /release-qualify qualification requires the dispatched_by URL/);
  assert.throws(() => build({ trigger: 'manual', dispatchedBy: 'https://github.com/anywear-ai/AnyWear-E2E/actions/runs/1' }),
    /manual qualification must not state a dispatched_by URL/);
  assert.throws(() => build({ trigger: 'scheduled' }), /Qualification trigger must be manual, deploy-smoke, deploy-qualify, release-qualify/);

  const tampered = structuredClone(release.record);
  tampered.workflow.dispatched_by = 'http://insecure.example';
  assert.throws(() => verifyQualificationRecord(redigest(tampered)), /must use HTTPS/);
});

// #226: the deploy chain's `full` names the Service commit it deployed. A deploy-qualify
// record is accepted with the dispatching Infra run and a supplied expected Service commit;
// without either it is refused, so the record a later release tag reads cannot be issued
// from whatever happened to be live.
test('records deploy-qualify only with the expected commit and the dispatching run', () => {
  const infraRun = 'https://github.com/anywear-ai/AnyWear-Infra/actions/runs/321';
  const deploy = issuedRecord({ trigger: 'deploy-qualify', dispatchedBy: infraRun });
  assert.equal(deploy.record.workflow.trigger, 'deploy-qualify');
  assert.equal(deploy.record.workflow.dispatched_by, infraRun);
  assert.equal(deploy.record.expected.source, 'trigger');
  assert.equal(verifyQualificationRecord(deploy.record), true);

  const build = (input, expected = deploy.fixture.expected) => buildQualificationRecord(
    { ...deploy.fixture.input, ...input }, expected, deploy.fixture.evidence, now, deploy.fixture.environment, deploy.fixture.report);
  assert.throws(() => build({}, { service_commit: null, client_commit: null, source: 'live' }),
    /deploy-qualify trigger requires a supplied expected service commit/);
  assert.throws(() => build({ dispatchedBy: null }), /deploy-qualify qualification requires the dispatched_by URL/);

  // The verifier holds the same bound for a record handed to it from outside.
  const withoutExpected = redigest({
    ...structuredClone(deploy.record),
    expected: { service_commit: deploy.fixture.serviceSha, client_commit: null, source: 'live' },
  });
  assert.throws(() => verifyQualificationRecord(withoutExpected),
    /deploy-qualify trigger requires a supplied expected service commit/);
});

test('requires a stable full observation and refuses each changed member by name', () => {
  const f = fixture();
  assert.doesNotThrow(() => assertStableObservation(f.evidence.before, structuredClone(f.evidence.after)));
  for (const [label, mutate, pattern] of [
    ['client source', (o) => { o.client.source_commit = 'f'.repeat(40); }, /Deployed Client identity mismatch/],
    ['service image', (o) => { o.service.image_digest = `sha256:${'f'.repeat(64)}`; }, /Deployed Service identity mismatch/],
    ['stack template', (o) => { o.platform.stacks[0].template_sha256 = 'f'.repeat(64); }, /Deployed platform identity mismatch/],
    ['lambda config', (o) => { o.platform.lambdas[0].configuration_sha256 = '9'.repeat(64); }, /Deployed platform identity mismatch/],
    ['queue member', (o) => { o.platform.queues[0].maxReceives = 4; }, /Deployed platform identity mismatch/],
    ['stage input', (o) => { o.platform.inputs[0].value_sha256 = 'f'.repeat(64); }, /Deployed platform identity mismatch/],
    ['client domain', (o) => { o.platform.client_domain = 'other.cloudfront.net'; }, /client_domain other\.cloudfront\.net differs/],
  ]) {
    const after = structuredClone(f.evidence.after);
    mutate(after);
    assert.throws(() => assertStableObservation(f.evidence.before, after), pattern, label);
    // The same change cannot be recorded either: the record builder refuses it.
    assert.throws(() => qualify(f, { evidence: { ...f.evidence, after } }), pattern, label);
  }
});

test('refuses an observation that is unauthenticated, out of order or wrongly shaped', () => {
  const f = fixture();
  for (const [label, mutate, pattern] of [
    ['authenticated false', (o) => { o.authenticated = false; }, /must state authenticated: true/],
    ['authenticated string', (o) => { o.authenticated = 'true'; }, /must state authenticated: true/],
    ['unknown member', (o) => { o.schema_version = 1; }, /observation\.schema_version is unknown/],
    ['unknown platform member', (o) => { o.platform.extra = true; }, /platform\.extra is unknown/],
    ['unsorted inputs', (o) => { o.platform.inputs.reverse(); }, /platform input order/],
    ['empty stacks', (o) => { o.platform.stacks = []; }, /platform stacks must be a non-empty list of discovered stacks/],
    ['empty inputs', (o) => { o.platform.inputs = []; }, /platform inputs must be a non-empty list of discovered stage parameters/],
    ['empty lambdas', (o) => { o.platform.lambdas = []; }, /platform lambdas must be a non-empty list of discovered functions/],
    ['empty queues', (o) => { o.platform.queues = []; }, /platform queues must be a non-empty list of discovered queues/],
    ['wrong schema hash', (o) => { o.platform.schema_sha256 = 'f'.repeat(64); }, /schema_sha256 is not the content hash/],
    ['bad lambda code', (o) => { o.platform.lambdas[0].code_sha256 = 'nope'; }, /code_sha256 is not a Lambda CodeSha256/],
    ['unsorted queues', (o) => { o.platform.queues.reverse(); }, /platform queue order/],
    ['unsorted lambdas', (o) => { o.platform.lambdas.reverse(); }, /platform lambda order/],
    ['bad collected_at', (o) => { o.collected_at = 'yesterday'; }, /collected_at must be an ISO timestamp/],
  ]) {
    const observation = structuredClone(f.evidence.before);
    mutate(observation);
    assert.throws(() => validateObservation(observation, 'observation'), pattern, label);
  }
  // A copied or reversed observation cannot issue a record: the two observations must
  // bracket the suite and name different collection instants.
  for (const [label, collectedAt] of [
    ['copied', f.evidence.before.collected_at],
    ['out of order', '2026-10-07T23:00:00.000Z'],
  ]) {
    assert.throws(() => qualify(f, {
      evidence: { ...f.evidence, after: { ...structuredClone(f.evidence.after), collected_at: collectedAt } },
    }), /before and after the suite in order/, label);
  }
  assert.throws(() => assertObservationSequence({
    before: { ...f.evidence.before, collected_at: f.evidence.after.collected_at },
    after: f.evidence.after,
  }, now.toISOString()), /before and after the suite in order/);
});

// #228: the validator judges the discovered grammars, not a fixed set. A member outside
// the committed entry-point patterns — a stack name or region, a stage path, a
// `beta-anywear-*` name, a queue member — is refused by name.
test('refuses a platform member outside the discovered grammars', () => {
  const f = fixture();
  for (const [label, mutate, pattern] of [
    ['stack name', (o) => { o.platform.stacks[0].name = 'OtherStack'; }, /is not an AnyWear stack name/],
    ['stack region', (o) => { o.platform.stacks[0].region = 'eu-west-1'; }, /region "eu-west-1" is not an observation region/],
    ['duplicated stack', (o) => { o.platform.stacks[1].name = o.platform.stacks[0].name; }, /platform stack .* is duplicated/],
    ['input path', (o) => { o.platform.inputs[0].parameter = '/anywear/prod/api_base_url'; }, /is not a stage parameter path/],
    ['lambda name', (o) => { o.platform.lambdas[0].name = 'pre-sign-up'; }, /is not a beta-anywear function name/],
    ['queue name', (o) => { o.platform.queues[0].name = 'vto'; }, /is not a beta-anywear queue name/],
    ['queue visibility', (o) => { o.platform.queues[0].queueVisibilitySeconds = '900'; }, /queueVisibilitySeconds is not a non-negative integer/],
    ['queue maxReceives zero', (o) => { o.platform.queues[0].maxReceives = 0; }, /maxReceives must be a positive integer or null/],
    ['queue maxReceives string', (o) => { o.platform.queues[1].maxReceives = '3'; }, /maxReceives must be a positive integer or null/],
    ['duplicated queue', (o) => { o.platform.queues[1].name = o.platform.queues[0].name; }, /platform queue .* is duplicated/],
  ]) {
    const observation = structuredClone(f.evidence.before);
    mutate(observation);
    assert.throws(() => validateObservation(observation, 'observation'), pattern, label);
  }
});

// #228 step 1c: the validator accepts every `/anywear/beta/<name>` member the published
// prefix carries — the live legacy `ENABLE_INFRA_E2E` shape, absent from the old closed
// allowlist — and still refuses foreign paths outside the prefix. The recorded guards
// stay: non-empty, sorted, unique, and `schema_sha256` re-derived over the rows.
test('accepts every prefix member the stage publishes and still refuses foreign paths', () => {
  const f = fixture();
  const withLegacy = structuredClone(f.evidence.before);
  withLegacy.platform.inputs.push({ parameter: '/anywear/beta/ENABLE_INFRA_E2E', version: '4', value_sha256: 'a'.repeat(64) });
  withLegacy.platform.inputs.sort((left, right) => (left.parameter < right.parameter ? -1 : left.parameter > right.parameter ? 1 : 0));
  withLegacy.platform.schema_sha256 = contentHash(withLegacy.platform.inputs.map(({ parameter, version }) => ({ parameter, version })));
  assert.equal(validateObservation(withLegacy, 'observation'), withLegacy);
  for (const parameter of ['/anywear/prod/api_base_url', '/anywear/beta', '/anywear/beta/', '/other/beta/x', '/anywear/betaX']) {
    const foreign = structuredClone(f.evidence.before);
    foreign.platform.inputs[0].parameter = parameter;
    assert.throws(() => validateObservation(foreign, 'observation'), /is not a stage parameter path/, parameter);
  }
});

test('refuses a Service release identity that does not state the qualified release', () => {
  const f = fixture();
  const base = f.evidence.service_artifacts;
  const asset = (name, overrides = {}) => ({ ...base.assets[name], ...overrides });
  const withAsset = (name, overrides) => ({ ...base.assets, [name]: asset(name, overrides) });
  const { 'runtime-policy.json': omitted, ...withoutRuntimePolicy } = base.assets;
  void omitted;
  for (const [label, serviceArtifacts, pattern] of [
    ['tag', { ...base, tag: `service-artifacts-${'f'.repeat(40)}` }, /does not name the qualified Service commit/],
    ['target commit', { ...base, target_commit: 'f'.repeat(40) }, /Service artifacts target_commit .+ is not the qualified Service commit/],
    ['malformed target commit', { ...base, target_commit: 'main' }, /Service release target commit must be a full lowercase 40-character commit SHA/],
    ['repository', { ...base, repository: 'other/Service' }, /Service artifacts repository is unexpected/],
    ['release id', { ...base, release_id: 0 }, /Service release ID must be a positive integer/],
    // A v3-shaped identity carries the manifest fields v4 removed; the exact key set
    // refuses it instead of silently ignoring the retired members.
    ['manifest asset id', { ...base, manifest_asset_id: 11 }, /Service artifacts\.manifest_asset_id is unknown/],
    ['manifest hash', { ...base, manifest_sha256: 'd'.repeat(64) }, /Service artifacts\.manifest_sha256 is unknown/],
    ['missing asset', { ...base, assets: withoutRuntimePolicy }, /Service release assets\.runtime-policy\.json is required/],
    ['extra asset', { ...base, assets: { ...base.assets, 'service-artifacts.json': { size: 242, digest: `sha256:${'a'.repeat(64)}` } } }, /Service release assets\.service-artifacts\.json is unknown/],
    ['empty asset', { ...base, assets: withAsset('pre-sign-up.zip', { size: 0 }) }, /Service release asset pre-sign-up\.zip size 0 is not a positive integer/],
    ['missing size', { ...base, assets: withAsset('pre-sign-up.zip', { size: undefined }) }, /Service release asset pre-sign-up\.zip size undefined is not a positive integer/],
    ['malformed digest', { ...base, assets: withAsset('service-schema.json', { digest: 'sha256:abc' }) }, /Service release asset service-schema\.json digest "sha256:abc" is not a sha256:<hex> digest/],
    ['missing digest', { ...base, assets: withAsset('service-schema.json', { digest: undefined }) }, /Service release asset service-schema\.json digest undefined is not a sha256:<hex> digest/],
    ['unknown asset member', { ...base, assets: withAsset('runtime-policy.json', { name: 'runtime-policy.json' }) }, /Service release asset runtime-policy\.json\.name is unknown/],
  ]) {
    assert.throws(() => qualify(f, { evidence: { ...f.evidence, service_artifacts: serviceArtifacts } }), pattern, label);
  }
});

test('refuses a live identity the final observation contradicts', () => {
  const f = fixture();
  for (const [label, live, pattern] of [
    ['client commit', { ...f.evidence.live, client: { ...f.evidence.live.client, source_commit: 'f'.repeat(40) } }, /live identity Client mismatch/],
    ['service image', { ...f.evidence.live, service: { ...f.evidence.live.service, image_digest: `sha256:${'f'.repeat(64)}` } }, /live identity Service mismatch/],
    ['client version', { ...f.evidence.live, client: { ...f.evidence.live.client, client_version: -1 } }, /client_version must be a non-negative safe integer/],
  ]) {
    assert.throws(() => qualify(f, { evidence: { ...f.evidence, live } }), pattern, label);
  }
});

test('refuses to issue a record for a failed run', () => {
  const f = fixture();
  assert.throws(() => qualify(f, { input: { result: 'failed' } }), /completed passing test run/);
});

test('refuses a passing suite measured across two worker task definitions', () => {
  const f = fixture();
  const environment = {
    record: environmentVerdict({
      comparison: {
        verdict: 'changed',
        reason: 'The worker task definition serving Beta changed during the suite',
        before_observed_at: f.evidence.before.collected_at,
        after_observed_at: f.evidence.after.collected_at,
        before_identity_sha256: 'a'.repeat(64),
        after_identity_sha256: 'b'.repeat(64),
        before_task_arns: [],
        after_task_arns: [],
        added_task_arns: [],
        removed_task_arns: [],
        task_definition_changed: true,
      },
      suiteOutcome: 'success',
    }),
    problem: null,
  };
  let refusal;
  try { qualify(f, { environment }); } catch (error) { refusal = error; }
  assert.ok(refusal, 'a passing suite across two worker task definitions must not yield a record');
  assert.equal(refusal.message, qualificationRefusalMessage(environment.record));
  assert.doesNotMatch(refusal.message, /replaced/);
});

test('still qualifies a passing suite that only rotated worker task ARNs', () => {
  const f = fixture();
  const environment = {
    record: environmentVerdict({
      comparison: {
        verdict: 'changed',
        reason: 'The workers serving Beta were replaced during the suite: 1 worker task(s) disappeared and 1 worker task(s) appeared',
        before_observed_at: f.evidence.before.collected_at,
        after_observed_at: f.evidence.after.collected_at,
        before_identity_sha256: 'a'.repeat(64),
        after_identity_sha256: 'b'.repeat(64),
        added_task_arns: [`arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'b'.repeat(32)}`],
        removed_task_arns: [`arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'a'.repeat(32)}`],
        task_definition_changed: false,
      },
      suiteOutcome: 'success',
    }),
    problem: null,
  };
  const record = qualify(f, { environment });
  assert.equal(environment.record.comparison.task_definition_changed, false);
  assert.equal(record.qualification_id, 'beta-123-1');
  assert.equal(verifyQualificationRecord(record), true);
});

test('requires the environment verdict before it issues a record', () => {
  const f = fixture();
  for (const [name, environment] of [
    ['omitted', undefined],
    ['missing', { record: null, problem: `${ENVIRONMENT_VERDICT_PATH} is missing` }],
    ['malformed', { record: [], problem: null }],
  ]) {
    let refusal;
    try { qualify(f, { environment }); } catch (error) { refusal = error; }
    assert.ok(refusal, `${name} environment must refuse`);
    assert.match(refusal.message, /no qualification record is issued/);
    assert.ok(refusal.message.includes(ENVIRONMENT_VERDICT_PATH), `${name} must name the verdict path`);
  }
  assert.doesNotThrow(() => qualify(f, { environment: f.environment }));
});

test('refuses a record whose stated selection differs from the one the repository declares', () => {
  const { record } = issuedRecord();
  for (const [label, mutate] of [
    ['tag', (testMember) => { testMember.selection.tag = '@full-stack'; }],
    ['invocation', (testMember) => { testMember.selection.invocation = 'test:smoke'; }],
  ]) {
    const tampered = structuredClone(record);
    mutate(tampered.test);
    assert.throws(() => verifyQualificationRecord(redigest(tampered)), /Qualification selection mismatch/, label);
  }
});

test('refuses a record that omits a collected scenario', () => {
  const { record } = issuedRecord();
  const tampered = structuredClone(record);
  tampered.test.scenarios = tampered.test.scenarios.filter(({ file }) => file !== 'tests/wardrobe.spec.ts');
  assert.throws(() => verifyQualificationRecord(redigest(tampered)), /omits tests\/wardrobe\.spec\.ts/);
});

test('refuses the retired constant suite shape instead of accepting two vocabularies', () => {
  const { record } = issuedRecord();
  const tampered = structuredClone(record);
  tampered.test = { runner: 'playwright', suite: 'complete', result: 'passed' };
  assert.throws(() => verifyQualificationRecord(redigest(tampered)), /test result\.selection is required/);
});

test('requires the run report before it can state what it measured', () => {
  const f = fixture();
  for (const [name, report] of [['omitted', undefined], ['null', null]]) {
    let refusal;
    try {
      buildQualificationRecord(f.input, f.expected, f.evidence, now, f.environment, report);
    } catch (error) { refusal = error; }
    assert.ok(refusal, `${name} report must refuse`);
    assert.match(refusal.message, /qualification-report\.json/);
    assert.ok(refusal.message.includes('E2E_QUALIFICATION_REPORT'), `${name} must name the variable that declares the path`);
  }
});

test('verifies the record against the report the suite wrote and refuses another run report', () => {
  const { fixture: f, record } = issuedRecord();
  assert.equal(verifyQualificationAgainstReport(record, f.report), true);

  const report = JSON.parse(f.report.toString('utf8'));
  report.suites = report.suites.slice(1);
  const narrower = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  assert.throws(() => verifyQualificationAgainstReport(record, narrower), /checksums differ/);
  const retargeted = { ...record, test: { ...record.test, report_sha256: byteHash(narrower) } };
  assert.throws(() => verifyQualificationAgainstReport(retargeted, narrower),
    /Qualification scenarios and the Playwright report mismatch/);
  assert.throws(() => verifyQualificationAgainstReport(record), /qualification-report\.json/);
});

// #180/#256: the deployed Client is the latest one, and the floor is the reviewed minimum
// Client version. A Client at the floor is qualified; one below it is refused by the record
// builder too.
test('qualifies the latest Client and refuses one below the recorded floor', () => {
  const f = fixture();
  assert.ok(f.clientVersion > f.minimumClientVersion);
  const atFloor = structuredClone(f);
  atFloor.evidence.live.client.client_version = f.minimumClientVersion;
  assert.equal(qualify(atFloor).revisions.client.client_version, f.minimumClientVersion);

  const below = structuredClone(f);
  below.evidence.live.client.client_version = -1;
  assert.throws(() => qualify(below), /client_version must be a non-negative safe integer/);

  const { record } = issuedRecord();
  const inconsistent = structuredClone(record);
  inconsistent.revisions.client.client_version = 0;
  inconsistent.revisions.service.minimum_client_version = 1;
  assert.throws(() => verifyQualificationRecord(redigest(inconsistent)), /is below the qualified minimum Client version/);

  const wrongFloor = structuredClone(record);
  wrongFloor.revisions.service.minimum_client_version = f.minimumClientVersion + 1;
  assert.throws(() => verifyQualificationRecord(redigest(wrongFloor)),
    /differs from the committed minimum-supported-client\.json version/);
});
