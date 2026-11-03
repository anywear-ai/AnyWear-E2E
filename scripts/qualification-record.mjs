import {
  assertEqual, byteHash, contentHash, exactKeys, payloadDigest as strictPayloadDigest, repositories,
  parseStrictJson, requireHttpsUrl as requireContractHttpsUrl, requireId, requireHash,
} from './evidence-contract.mjs';
import { assertQualificationEnvironment } from './qualification-environment.mjs';
import { assertLiveClientFloor, readMinimumSupportedClient } from './minimum-supported-client.mjs';
import { OBSERVATION_REGIONS, QUEUE_NAME_PREFIX, STACK_NAME_PREFIX, STAGE_PATH } from './platform-entrypoints.mjs';
import {
  QUALIFICATION_REPORT_ENV, QUALIFICATION_REPORT_PATH, RECORDABLE_RESULTS, SCENARIO_KEYS, SELECTION_KEYS, TEST_KEYS,
  assertTestSelection, buildTestMember, reportScenarios,
} from './test-selection.mjs';

// AnyWear #180/#193: the qualification record is schema v4 and it is written from the live
// deployed tuple, not from a pre-submitted compatibility file. The record keeps the
// members that describe *what was tested* (`revisions`, `observations`, `test`,
// `workflow`, `integrity`) and the immutable Service release identity
// (`service_artifacts`: repository, release id, tag, tag target commit and the four
// released assets with their published size and digest), adds the expectation the run was
// dispatched for (`expected`), and has no member that only existed to carry a committed
// pin: `compatibility` (the whole pin) and `deployment` (the two producer record bodies) are
// gone. Removing them is what makes the record self-contained: qualification proves the
// deployed content, and the deployment lineage lives in platform facts (#207) — the GitHub
// Environment deployment `beta`, the CloudFormation stack events, the release tag→commit and
// the ECR image digest — not in a record or in the test evidence. v4 replaces v3's manifest
// asset id/hash with the release's own identity and refuses a v2/v3 record, so one version
// never means two shapes.
//
// The record cannot be issued from anything but the protected `full` operation: the
// suite result, the environment verdict, the run report bytes and the dispatched
// operation are all required arguments, so no caller can build one without stating what
// it measured. The live identity and the immutable release are verified before the
// suite and re-observed after it, and the two observations must be identical.
const commitPattern = /^[0-9a-f]{40}$/;
const imageDigestPattern = /^sha256:[0-9a-f]{64}$/;
// #228: validation rules are discovered grammars, not fixed sets. A stage input path is
// `/anywear/beta/<name>`: every member the published prefix carries is accepted (the
// observation seals whatever the prefix publishes — the live prefix includes the legacy
// `/anywear/beta/ENABLE_INFRA_E2E` parameter — and drift stays caught by the
// smoke-vs-qualification equality and the closing re-read), while a foreign path outside
// the prefix is refused. A stack name matches the committed `AnyWear*` prefix, and a
// Lambda/queue name matches the committed `beta-anywear-*` prefix. The regions a stack
// row may state are the two committed observation regions.
const stagePathPattern = new RegExp(`^${STAGE_PATH}.+$`);
const stackNamePattern = new RegExp(`^${STACK_NAME_PREFIX}[A-Za-z0-9-]+$`);
const resourceNamePattern = new RegExp(`^${QUEUE_NAME_PREFIX}[a-z0-9-]+$`);
const versionPattern = /^[1-9][0-9]*$/;
const lambdaCodePattern = /^[A-Za-z0-9+/]{43}=$/;
const cloudFrontDomainPattern = /^[a-z0-9][a-z0-9-]*\.cloudfront\.net$/;

export const EXPECTED_SOURCES = Object.freeze(['trigger', 'live']);
export const QUALIFICATION_TRIGGERS = Object.freeze(['manual', 'deploy-smoke', 'deploy-qualify', 'release-qualify']);
export const OBSERVATION_KEYS = Object.freeze(['collected_at', 'client', 'service', 'platform', 'authenticated']);
export const OBSERVED_CLIENT_KEYS = Object.freeze(['url', 'source_commit', 'built_at']);
export const OBSERVED_SERVICE_KEYS = Object.freeze(['url', 'service_commit', 'image_digest']);
export const PLATFORM_KEYS = Object.freeze(['stacks', 'inputs', 'schema_sha256', 'lambdas', 'queues', 'client_domain']);
export const PLATFORM_STACK_KEYS = Object.freeze(['name', 'region', 'template_sha256']);
export const PLATFORM_INPUT_KEYS = Object.freeze(['parameter', 'version', 'value_sha256']);
export const LAMBDA_IDENTITY_KEYS = Object.freeze(['code_sha256', 'configuration_sha256']);
export const QUEUE_KEYS = Object.freeze(['name', 'queueVisibilitySeconds', 'maxReceives']);
// #193: the Service release publishes exactly these four assets. The set is frozen here
// (and in the Service and Infra slices) so the gate cannot accept a release that renamed,
// dropped or added a consumed name; an extra legacy asset is ignored, which is what keeps
// a pre-change five-asset release qualifiable during the transition.
export const SERVICE_RELEASE_ASSET_NAMES = Object.freeze([
  'pre-sign-up.zip',
  'post-confirmation.zip',
  'runtime-policy.json',
  'service-schema.json',
]);
export const SERVICE_ARTIFACTS_KEYS = Object.freeze(['repository', 'release_id', 'tag', 'target_commit', 'assets']);
export const SERVICE_ASSET_KEYS = Object.freeze(['size', 'digest']);
export const EXPECTED_KEYS = Object.freeze(['service_commit', 'client_commit', 'source']);
export const QUALIFICATION_RECORD_KEYS = Object.freeze([
  'schema_version', 'record_type', 'qualification_id', 'result', 'operation', 'qualified_at', 'environment',
  'expected', 'revisions', 'service_artifacts', 'observations', 'test', 'workflow', 'integrity',
]);
export const SERVICE_ARTIFACTS_PREFIX = 'service-artifacts-';

function requireValue(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function requireCommit(value, label) {
  if (typeof value !== 'string' || !commitPattern.test(value)) {
    throw new Error(`${label} must be a full lowercase 40-character commit SHA`);
  }
  return value;
}

function requireImageDigest(value) {
  if (typeof value !== 'string' || !imageDigestPattern.test(value)) {
    throw new Error('Service image identity must be a sha256 OCI digest');
  }
  return value;
}

function requireNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requireTimestamp(value, label) {
  if (!Number.isFinite(Date.parse(requireValue(value, label)))) throw new Error(`${label} must be an ISO timestamp`);
  return value;
}

function requireHttpsUrl(value, label) {
  return requireContractHttpsUrl(value, label);
}

function requireOneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label} must be ${allowed.join(', ')} (observed ${JSON.stringify(value)})`);
  return value;
}

async function fetchJson(fetcher, url, label) {
  let response;
  try {
    response = await fetcher(url, {
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`${label} could not be read from ${url} (${error.message})`, { cause: error });
  }
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status} from ${url}`);
  return parseStrictJson(Buffer.from(await response.arrayBuffer()));
}

// Read only the two live identities qualification is allowed to trust: the Client's
// `build-metadata.json` (schema 3: component, source_commit, client_version, built_at)
// and the Service's `/health` (status ok, service_commit, image_digest,
// minimum_client_version). Nothing here reads a repository file that describes the
// deployment.
//
// `expected` carries the dispatch expectation; a null member means "not supplied" and
// that member is not compared. A mismatch throws with both values and labels which is
// which, because the operator's next action depends on it. The supported-Client floor
// is compared against the committed `minimum-supported-client.json`; a disagreement is
// a refusal that tells the operator to sync that file, never an automatic choice of the
// oldest version.
export async function collectDeploymentEvidence(input, expected = {}, fetcher = fetch) {
  const clientUrl = requireHttpsUrl(input.clientUrl, 'E2E_CLIENT_URL');
  const serviceUrl = requireHttpsUrl(input.serviceUrl, 'E2E_SERVICE_URL');
  const cacheBuster = encodeURIComponent(input.runId ?? Date.now().toString());
  const clientMetadataUrl = new URL('/build-metadata.json', `${clientUrl}/`);
  clientMetadataUrl.searchParams.set('qualification', cacheBuster);

  const [clientMetadata, serviceHealth] = await Promise.all([
    fetchJson(fetcher, clientMetadataUrl, 'Client build metadata'),
    fetchJson(fetcher, new URL('/health', `${serviceUrl}/`), 'Service health'),
  ]);

  if (clientMetadata.component !== 'AnyWear-Client') {
    throw new Error(`Client build metadata component is ${JSON.stringify(clientMetadata.component)}, expected "AnyWear-Client" (${clientUrl}/build-metadata.json)`);
  }
  if (clientMetadata.schema_version !== 3) {
    throw new Error(`Deployed Client build metadata schema_version is ${JSON.stringify(clientMetadata.schema_version)}, expected 3`);
  }
  const clientCommit = requireCommit(clientMetadata.source_commit, 'Deployed Client source_commit');
  const clientVersion = requireNonNegativeSafeInteger(clientMetadata.client_version, 'Deployed Client client_version');
  const builtAt = requireTimestamp(clientMetadata.built_at, 'Deployed Client built_at');
  if (serviceHealth.status !== 'ok') {
    throw new Error(`Deployed Service /health status is ${JSON.stringify(serviceHealth.status)}, expected "ok" (${serviceUrl}/health)`);
  }
  const serviceCommit = requireCommit(serviceHealth.service_commit, 'Deployed Service service_commit');
  const serviceImageDigest = requireImageDigest(serviceHealth.image_digest);
  const minimumClientVersion = requireNonNegativeSafeInteger(serviceHealth.minimum_client_version, 'Deployed Service minimum_client_version');

  const expectedService = expected?.service_commit ?? null;
  const expectedClient = expected?.client_commit ?? null;
  if (expectedService !== null && requireCommit(expectedService, 'Expected Service commit') !== serviceCommit) {
    throw new Error(`Deployed Service service_commit mismatch at ${serviceUrl}/health: expected ${expectedService} (dispatch input), observed ${serviceCommit} (live)`);
  }
  if (expectedClient !== null && requireCommit(expectedClient, 'Expected Client commit') !== clientCommit) {
    throw new Error(`Deployed Client source_commit mismatch at ${clientUrl}/build-metadata.json: expected ${expectedClient} (dispatch input), observed ${clientCommit} (live)`);
  }

  const floor = input.minimumSupportedClient ?? readMinimumSupportedClient();
  assertLiveClientFloor({ clientVersion, minimumClientVersion }, floor);

  return {
    client: { url: clientUrl, source_commit: clientCommit, built_at: builtAt },
    service: { url: serviceUrl, service_commit: serviceCommit, image_digest: serviceImageDigest },
    client_version: clientVersion,
    minimum_client_version: minimumClientVersion,
  };
}

export const serviceArtifactsTag = (serviceSha) => `${SERVICE_ARTIFACTS_PREFIX}${requireCommit(serviceSha, 'Service commit')}`;

// One observation, exactly the shape the record stores. The platform member is the
// E2E's own authenticated read (`infra-observation.mjs`), flattened and producer-free.
// `authenticated: true` is a literal assertion that the observation was taken with the
// verified Beta principal; a record cannot claim an unauthenticated observation.
export function validateObservation(observation, label = 'observation') {
  exactKeys(observation, [...OBSERVATION_KEYS], label);
  requireTimestamp(observation.collected_at, `${label}.collected_at`);
  exactKeys(observation.client, [...OBSERVED_CLIENT_KEYS], `${label} client`);
  requireHttpsUrl(observation.client.url, `${label} client.url`);
  requireCommit(observation.client.source_commit, `${label} client.source_commit`);
  requireTimestamp(observation.client.built_at, `${label} client.built_at`);
  exactKeys(observation.service, [...OBSERVED_SERVICE_KEYS], `${label} service`);
  requireHttpsUrl(observation.service.url, `${label} service.url`);
  requireCommit(observation.service.service_commit, `${label} service.service_commit`);
  requireImageDigest(observation.service.image_digest);

  exactKeys(observation.platform, [...PLATFORM_KEYS], `${label} platform`);
  // #228: the platform is the discovered surface, validated by grammar instead of a
  // committed name list. Every list is non-empty, sorted by name and unique.
  if (!Array.isArray(observation.platform.stacks) || observation.platform.stacks.length === 0) {
    throw new Error(`${label} platform stacks must be a non-empty list of discovered stacks`);
  }
  const seenStacks = [];
  for (const row of observation.platform.stacks) {
    exactKeys(row, [...PLATFORM_STACK_KEYS], `${label} platform stack`);
    if (typeof row.name !== 'string' || !stackNamePattern.test(row.name)) {
      throw new Error(`${label} platform stack ${JSON.stringify(row.name)} is not an AnyWear stack name`);
    }
    if (!OBSERVATION_REGIONS.includes(row.region)) {
      throw new Error(`${label} platform stack ${row.name} region ${JSON.stringify(row.region)} is not an observation region`);
    }
    if (seenStacks.includes(row.name)) throw new Error(`${label} platform stack ${row.name} is duplicated`);
    seenStacks.push(row.name);
    requireHash(row.template_sha256, `${label} platform stack ${row.name} template hash`);
  }
  const sortedStacks = [...seenStacks].sort();
  assertEqual(seenStacks, sortedStacks, `${label} platform stack order`);

  if (!Array.isArray(observation.platform.inputs) || observation.platform.inputs.length === 0) {
    throw new Error(`${label} platform inputs must be a non-empty list of discovered stage parameters`);
  }
  const seenParameters = [];
  for (const row of observation.platform.inputs) {
    exactKeys(row, [...PLATFORM_INPUT_KEYS], `${label} platform input`);
    if (typeof row.parameter !== 'string' || !stagePathPattern.test(row.parameter)) {
      throw new Error(`${label} platform input parameter ${JSON.stringify(row.parameter)} is not a stage parameter path`);
    }
    if (typeof row.version !== 'string' || !versionPattern.test(row.version) || !Number.isSafeInteger(Number(row.version))) {
      throw new Error(`${label} platform input ${row.parameter} version is not a positive integer string`);
    }
    requireHash(row.value_sha256, `${label} platform input ${row.parameter} value hash`);
    if (seenParameters.includes(row.parameter)) throw new Error(`${label} platform input ${row.parameter} is duplicated`);
    seenParameters.push(row.parameter);
  }
  const sortedParameters = [...seenParameters].sort();
  assertEqual(seenParameters, sortedParameters, `${label} platform input order`);
  requireHash(observation.platform.schema_sha256, `${label} platform schema hash`);
  if (observation.platform.schema_sha256 !== contentHash(
    observation.platform.inputs.map(({ parameter, version }) => ({ parameter, version })))) {
    throw new Error(`${label} platform schema_sha256 is not the content hash of its recorded inputs`);
  }

  if (!Array.isArray(observation.platform.lambdas) || observation.platform.lambdas.length === 0) {
    throw new Error(`${label} platform lambdas must be a non-empty list of discovered functions`);
  }
  const seenLambdas = [];
  for (const row of observation.platform.lambdas) {
    exactKeys(row, ['name', ...LAMBDA_IDENTITY_KEYS], `${label} platform lambda`);
    if (typeof row.name !== 'string' || !resourceNamePattern.test(row.name)) {
      throw new Error(`${label} platform lambda ${JSON.stringify(row.name)} is not a beta-anywear function name`);
    }
    if (!lambdaCodePattern.test(row.code_sha256)) {
      throw new Error(`${label} platform lambda ${row.name} code_sha256 is not a Lambda CodeSha256`);
    }
    requireHash(row.configuration_sha256, `${label} platform lambda ${row.name} configuration hash`);
    if (seenLambdas.includes(row.name)) throw new Error(`${label} platform lambda ${row.name} is duplicated`);
    seenLambdas.push(row.name);
  }
  const sortedLambdas = [...seenLambdas].sort();
  assertEqual(seenLambdas, sortedLambdas, `${label} platform lambda order`);

  if (!Array.isArray(observation.platform.queues) || observation.platform.queues.length === 0) {
    throw new Error(`${label} platform queues must be a non-empty list of discovered queues`);
  }
  const seenQueues = [];
  for (const row of observation.platform.queues) {
    exactKeys(row, [...QUEUE_KEYS], `${label} platform queue`);
    if (typeof row.name !== 'string' || !resourceNamePattern.test(row.name)) {
      throw new Error(`${label} platform queue ${JSON.stringify(row.name)} is not a beta-anywear queue name`);
    }
    if (!Number.isSafeInteger(row.queueVisibilitySeconds) || row.queueVisibilitySeconds < 0) {
      throw new Error(`${label} platform queue ${row.name} queueVisibilitySeconds is not a non-negative integer`);
    }
    if (row.maxReceives !== null && (!Number.isSafeInteger(row.maxReceives) || row.maxReceives < 1)) {
      throw new Error(`${label} platform queue ${row.name} maxReceives must be a positive integer or null`);
    }
    if (seenQueues.includes(row.name)) throw new Error(`${label} platform queue ${row.name} is duplicated`);
    seenQueues.push(row.name);
  }
  const sortedQueues = [...seenQueues].sort();
  assertEqual(seenQueues, sortedQueues, `${label} platform queue order`);

  if (typeof observation.platform.client_domain !== 'string' || !cloudFrontDomainPattern.test(observation.platform.client_domain)) {
    throw new Error(`${label} platform client_domain must be a bare CloudFront distribution host`);
  }
  if (new URL(observation.client.url).host !== observation.platform.client_domain) {
    throw new Error(`${label} platform client_domain ${observation.platform.client_domain} differs from the observed Client host ${new URL(observation.client.url).host}`);
  }

  if (observation.authenticated !== true) {
    throw new Error(`${label} must state authenticated: true; the platform observation is taken with the verified Beta principal`);
  }
  return observation;
}

// The full observed identity must be equal before and after the suite: Client, Service
// and platform. The old comparison covered only Client and Service because the platform
// arrived as a producer record that was pinned by the compatibility file; now the
// platform is observed by this repository, so a template, input, Lambda, queue or
// distribution change during the suite is a first-class mismatch.
export function assertStableObservation(before, after) {
  validateObservation(before, 'initial observation');
  validateObservation(after, 'final observation');
  assertEqual(before.client, after.client, 'Deployed Client identity');
  assertEqual(before.service, after.service, 'Deployed Service identity');
  assertEqual(before.platform, after.platform, 'Deployed platform identity');
  return true;
}

const SERVICE_ASSET_DIGEST = /^sha256:[0-9a-f]{64}$/;

// The record states the release identity the gate verified, not a copy of a release file:
// the repository, the release id, the tag, the commit the tag resolved to and exactly the
// four released assets with the size and digest the release API published for them. The
// tag must name the qualified Service commit and the tag's target commit must be that same
// commit, so the record re-proves the tag→commit binding offline. No manifest is accepted
// or required: a v4 record cannot carry `manifest_asset_id`/`manifest_sha256`.
function validateServiceArtifacts(serviceArtifacts, serviceSha) {
  exactKeys(serviceArtifacts, [...SERVICE_ARTIFACTS_KEYS], 'Service artifacts');
  if (serviceArtifacts.repository !== repositories.service) throw new Error('Service artifacts repository is unexpected');
  requireId(serviceArtifacts.release_id, 'Service release ID');
  requireCommit(serviceArtifacts.target_commit, 'Service release target commit');
  if (serviceArtifacts.tag !== serviceArtifactsTag(serviceSha)) {
    throw new Error(`Service artifacts tag ${JSON.stringify(serviceArtifacts.tag)} does not name the qualified Service commit; observed ${JSON.stringify(serviceArtifacts.tag)}, expected ${serviceArtifactsTag(serviceSha)}`);
  }
  if (serviceArtifacts.target_commit !== serviceSha) {
    throw new Error(`Service artifacts target_commit ${JSON.stringify(serviceArtifacts.target_commit)} is not the qualified Service commit; observed ${JSON.stringify(serviceArtifacts.target_commit)}, expected ${JSON.stringify(serviceSha)}`);
  }
  // Exactly the four released names: a missing name, an extra name or a duplicated entry
  // cannot state the identity the gate verified.
  exactKeys(serviceArtifacts.assets, [...SERVICE_RELEASE_ASSET_NAMES], 'Service release assets');
  for (const name of SERVICE_RELEASE_ASSET_NAMES) {
    const asset = exactKeys(serviceArtifacts.assets[name], [...SERVICE_ASSET_KEYS], `Service release asset ${name}`);
    if (!Number.isSafeInteger(asset.size) || asset.size < 1) {
      throw new Error(`Service release asset ${name} size ${JSON.stringify(asset.size)} is not a positive integer`);
    }
    if (typeof asset.digest !== 'string' || !SERVICE_ASSET_DIGEST.test(asset.digest)) {
      throw new Error(`Service release asset ${name} digest ${JSON.stringify(asset.digest)} is not a sha256:<hex> digest`);
    }
  }
  return serviceArtifacts;
}

// The live identity file is written by the same read that compared the dispatch
// expectation, so the versions it holds belong to the run-start Service. It is
// cross-checked against the final observation: the identity the record states and the
// identity the observation states cannot disagree.
function validateLiveIdentity(live, observation) {
  const label = 'live identity';
  exactKeys(live, ['client', 'service'], label);
  exactKeys(live.client, ['url', 'source_commit', 'client_version', 'built_at'], `${label} client`);
  exactKeys(live.service, ['url', 'service_commit', 'image_digest', 'minimum_client_version'], `${label} service`);
  assertEqual(live.client, { ...observation.client, client_version: live.client.client_version }, `${label} Client`);
  assertEqual(live.service, { ...observation.service, minimum_client_version: live.service.minimum_client_version }, `${label} Service`);
  requireNonNegativeSafeInteger(live.client.client_version, `${label} client_version`);
  requireNonNegativeSafeInteger(live.service.minimum_client_version, `${label} minimum_client_version`);
  return live;
}

// The dispatch expectation, resolved. `trigger` means the dispatcher supplied a Service
// commit and it must be exactly what is deployed; `live` means a manual `full` supplied
// none, so the live Service commit observed at run start became the expectation. A
// supplied Client commit is compared the same way in either mode.
function resolveExpected(expected, observation) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    throw new Error('Qualification requires the expected tuple {service_commit, client_commit, source}');
  }
  exactKeys(expected, [...EXPECTED_KEYS], 'expected tuple');
  requireOneOf(expected.source, [...EXPECTED_SOURCES], 'Qualification expected.source');
  const liveService = requireCommit(observation.service.service_commit, 'Observed Service service_commit');
  const liveClient = requireCommit(observation.client.source_commit, 'Observed Client source_commit');
  const suppliedService = expected.service_commit ?? null;
  const suppliedClient = expected.client_commit ?? null;
  let serviceCommit;
  if (suppliedService !== null) {
    serviceCommit = requireCommit(suppliedService, 'expected.service_commit');
    if (expected.source !== 'trigger') {
      throw new Error('A supplied expected service commit requires expected.source to be trigger, not live');
    }
    if (serviceCommit !== liveService) {
      throw new Error(`Expected Service commit mismatch: expected ${serviceCommit} (dispatch input), observed ${liveService} (live)`);
    }
  } else {
    if (expected.source !== 'live') {
      throw new Error('expected.source trigger requires a supplied expected service commit; a manual full without one records the live Service commit as its expectation with source live');
    }
    serviceCommit = liveService;
  }
  let clientCommit = null;
  if (suppliedClient !== null) {
    clientCommit = requireCommit(suppliedClient, 'expected.client_commit');
    if (clientCommit !== liveClient) {
      throw new Error(`Expected Client commit mismatch: expected ${clientCommit} (dispatch input), observed ${liveClient} (live)`);
    }
  }
  return { service_commit: serviceCommit, client_commit: clientCommit, source: expected.source };
}

// The environment verdict is a required argument, not an option: this is the only path
// that writes `qualification-record.json`, and a passing suite measured across two
// worker task definitions measured neither of them, so it cannot issue a record. The
// assertion denies by default, so no caller can build a record without stating the
// environment gate it consulted.
//
// The run's Playwright JSON report bytes are required for the same reason: the record
// states which scenarios ran and how many of each spec's tests were collected and
// skipped, and none of that can be inferred from a suite that merely ended green.
//
// The record is produced only by the `full` operation of the single `qualify` entry.
// The operation is read from the dispatch event (`E2E_OPERATION`), never inferred from
// the workflow file, and it is written into the payload so the validator and the
// release consumers can re-check the binding. `smoke` and `reconcile` share
// the dispatch surface but cannot reach this function with a recordable operation.
export function buildQualificationRecord(input, expected, evidence, now = new Date(), environment, reportBytes) {
  if (input.result !== 'passed') {
    throw new Error('Only a completed passing test run can issue a qualification record');
  }
  if (input.operation !== 'full') {
    throw new Error('Only the full qualification operation can issue a qualification record');
  }
  assertQualificationEnvironment(environment);
  if (reportBytes === undefined || reportBytes === null) {
    throw new Error(`The qualification record requires the run's Playwright JSON report bytes at ${QUALIFICATION_REPORT_PATH}; ${QUALIFICATION_REPORT_ENV} names that path and the release-gating suite step writes it`);
  }

  exactKeys(evidence, ['before', 'after', 'service_artifacts', 'live'], 'qualification evidence');
  validateObservation(evidence.before, 'initial observation');
  validateObservation(evidence.after, 'final observation');
  assertStableObservation(evidence.before, evidence.after);
  assertObservationSequence({ before: evidence.before, after: evidence.after }, now.toISOString());
  const after = evidence.after;

  const live = validateLiveIdentity(evidence.live, after);
  const floor = input.minimumSupportedClient ?? readMinimumSupportedClient();
  assertLiveClientFloor({
    clientVersion: live.client.client_version,
    minimumClientVersion: live.service.minimum_client_version,
  }, floor);

  const resolvedExpected = resolveExpected(expected, after);
  const serviceArtifacts = validateServiceArtifacts(evidence.service_artifacts, after.service.service_commit);

  if (input.repository !== repositories.e2e || input.workflowPath !== '.github/workflows/beta-qualification.yml'
    || input.workflowRef !== `${repositories.e2e}/.github/workflows/beta-qualification.yml@refs/heads/main`) {
    throw new Error('Only protected Beta Qualification can issue v4 records');
  }
  if (input.awsAccountId !== '650880818323' || input.awsRegion !== 'ap-east-1') {
    throw new Error('Qualification must observe the reviewed Beta account/region');
  }
  if (input.serverUrl !== 'https://github.com') throw new Error('Qualification must bind GitHub.com');

  const trigger = requireOneOf(input.trigger, [...QUALIFICATION_TRIGGERS], 'Qualification trigger');
  if (trigger === 'deploy-smoke') {
    throw new Error('A deploy-smoke trigger only dispatches the smoke operation, so it cannot issue a qualification record');
  }
  const dispatchedBy = input.dispatchedBy ?? null;
  if (trigger === 'manual') {
    if (dispatchedBy !== null) throw new Error('A manual qualification must not state a dispatched_by URL');
  } else {
    if (dispatchedBy === null) throw new Error(`A ${trigger} qualification requires the dispatched_by URL of the run that dispatched it`);
    requireHttpsUrl(dispatchedBy, 'Qualification dispatched_by');
  }
  // #180/#226: a qualification that names a supplied expectation must have one. The deploy
  // chain's `deploy-qualify` and the human `release-qualify` both promise the record names a
  // specific Service commit, so a record built from the live observed value alone would
  // break that promise.
  if ((trigger === 'release-qualify' || trigger === 'deploy-qualify') && resolvedExpected.source !== 'trigger') {
    throw new Error(`A ${trigger} trigger requires a supplied expected service commit (expected.source trigger)`);
  }

  const executor = {
    repository: repositories.e2e, sha: requireCommit(input.e2eSha, 'E2E SHA'),
    workflow_path: input.workflowPath,
    run_id: requireId(Number(input.runId), 'E2E run'), run_attempt: requireId(Number(input.runAttempt), 'E2E attempt'),
  };
  const payload = {
    schema_version: 4,
    record_type: 'anywear_beta_qualification',
    qualification_id: `beta-${requireValue(input.runId, 'GITHUB_RUN_ID')}-${requireValue(input.runAttempt, 'GITHUB_RUN_ATTEMPT')}`,
    result: 'passed',
    operation: 'full',
    qualified_at: now.toISOString(),
    environment: {
      stage: 'beta',
      aws_account_id: requireValue(input.awsAccountId, 'AWS_ACCOUNT_ID'),
      aws_region: requireValue(input.awsRegion, 'AWS_REGION'),
      client_url: requireHttpsUrl(after.client.url, 'Client URL'),
      service_url: requireHttpsUrl(after.service.url, 'Service URL'),
    },
    expected: resolvedExpected,
    revisions: {
      e2e: {
        repository: requireValue(input.repository, 'GITHUB_REPOSITORY'),
        sha: requireCommit(input.e2eSha, 'E2E SHA'),
      },
      client: {
        repository: repositories.client,
        sha: requireCommit(after.client.source_commit, 'Client SHA'),
        client_version: live.client.client_version,
      },
      service: {
        repository: repositories.service,
        sha: requireCommit(after.service.service_commit, 'Service SHA'),
        image_digest: requireImageDigest(after.service.image_digest),
        minimum_client_version: live.service.minimum_client_version,
      },
    },
    service_artifacts: serviceArtifacts,
    observations: { before: evidence.before, after: evidence.after },
    // Which tests this record covers is derived from the run and this checkout, never
    // written as a literal: the invocation the qualification workflow's suite step ran,
    // the tag that invocation selects, the run's own report digest, and one entry per
    // selected spec with its outcome and its collected/skipped counts.
    test: buildTestMember(reportBytes),
    workflow: {
      repository: repositories.e2e,
      path: input.workflowPath,
      ref: input.workflowRef,
      run_id: executor.run_id,
      run_attempt: executor.run_attempt,
      run_url: `${requireValue(input.serverUrl, 'GITHUB_SERVER_URL')}/${input.repository}/actions/runs/${input.runId}`,
      trigger,
      dispatched_by: dispatchedBy,
    },
  };

  if (payload.expected.service_commit !== payload.revisions.service.sha) {
    throw new Error('Qualification expectation does not name the observed Service commit');
  }
  return {
    ...payload,
    integrity: {
      algorithm: 'sha256',
      payload_sha256: strictPayloadDigest(payload),
    },
  };
}

export function verifyQualificationRecord(record, { trustedRun } = {}) {
  // v4 is the only live shape. v2/v3 records named a manifest asset that no longer exists,
  // so accepting them would make one schema version mean two different `service_artifacts`
  // shapes; they stay historical inputs only and are refused here with the observed value.
  if (record?.schema_version !== 4 || record?.record_type !== 'anywear_beta_qualification') {
    throw new Error(`Unsupported qualification record schema: observed schema_version ${JSON.stringify(record?.schema_version)} / record_type ${JSON.stringify(record?.record_type)}, expected 4 / anywear_beta_qualification`);
  }
  exactKeys(record, [...QUALIFICATION_RECORD_KEYS], 'qualification');
  exactKeys(record.test, TEST_KEYS, 'test result');
  exactKeys(record.test.selection, SELECTION_KEYS, 'test selection');
  if (!Array.isArray(record.test.scenarios) || record.test.scenarios.length === 0) {
    throw new Error('test result.scenarios must be a non-empty list of selected scenarios');
  }
  for (const scenario of record.test.scenarios) {
    exactKeys(scenario, SCENARIO_KEYS, `test scenario ${scenario?.file}`);
  }
  requireHash(record.test.report_sha256, 'Qualification report checksum');
  if (record.result !== 'passed' || record.test.runner !== 'playwright' || !RECORDABLE_RESULTS.includes(record.test.result)) {
    throw new Error('Qualification record is not passing');
  }
  // The signed operation is re-checked here, not trusted from the payload: a record that
  // names any operation other than `full` cannot qualify regardless of its checksum.
  if (record.operation !== 'full') throw new Error('Qualification record operation must be full');
  exactKeys(record.integrity, ['algorithm', 'payload_sha256'], 'qualification integrity');
  requireHash(record.integrity.payload_sha256, 'Qualification payload checksum');
  if (record.integrity.algorithm !== 'sha256') {
    throw new Error('Qualification record integrity algorithm must be sha256');
  }

  const { integrity, ...payload } = record;
  if (integrity.payload_sha256 !== strictPayloadDigest(payload)) {
    throw new Error('Qualification record checksum mismatch');
  }
  // Re-derived only after the payload checksum, so a record tampered with anywhere still
  // reports the checksum mismatch first. This is the half that refuses a record whose
  // stated selection or scenario list does not match the workflow, `package.json`, the
  // spec titles and the scenario inventory of the checkout that judges it.
  assertTestSelection(payload.test);

  exactKeys(payload.expected, [...EXPECTED_KEYS], 'expected tuple');
  requireCommit(payload.expected.service_commit, 'Expected Service commit');
  if (payload.expected.client_commit !== null) requireCommit(payload.expected.client_commit, 'Expected Client commit');
  requireOneOf(payload.expected.source, [...EXPECTED_SOURCES], 'Qualification expected.source');

  exactKeys(payload.workflow, ['repository', 'path', 'ref', 'run_id', 'run_attempt', 'run_url', 'trigger', 'dispatched_by'], 'qualification workflow');
  const workflow = payload.workflow;
  requireId(workflow.run_id, 'Qualification run'); requireId(workflow.run_attempt, 'Qualification attempt');
  requireOneOf(workflow.trigger, [...QUALIFICATION_TRIGGERS], 'Qualification trigger');
  if (workflow.trigger === 'deploy-smoke') {
    throw new Error('A deploy-smoke trigger only dispatches the smoke operation, so it cannot issue a qualification record');
  }
  if (workflow.trigger === 'manual') {
    if (workflow.dispatched_by !== null) throw new Error('A manual qualification must not state a dispatched_by URL');
  } else if (workflow.dispatched_by === null) {
    throw new Error(`A ${workflow.trigger} qualification requires the dispatched_by URL of the run that dispatched it`);
  } else {
    requireHttpsUrl(workflow.dispatched_by, 'Qualification dispatched_by');
  }
  if ((workflow.trigger === 'release-qualify' || workflow.trigger === 'deploy-qualify') && payload.expected.source !== 'trigger') {
    throw new Error(`A ${workflow.trigger} trigger requires a supplied expected service commit (expected.source trigger)`);
  }
  if (workflow.repository !== repositories.e2e || workflow.path !== '.github/workflows/beta-qualification.yml'
    || workflow.ref !== `${repositories.e2e}/${workflow.path}@refs/heads/main`
    || workflow.run_url !== `https://github.com/${repositories.e2e}/actions/runs/${workflow.run_id}`
    || payload.qualification_id !== `beta-${workflow.run_id}-${workflow.run_attempt}`) throw new Error('Qualification workflow binding mismatch');

  exactKeys(payload.revisions, ['e2e', 'client', 'service'], 'revisions');
  exactKeys(payload.revisions.e2e, ['repository', 'sha'], 'e2e revision');
  exactKeys(payload.revisions.client, ['repository', 'sha', 'client_version'], 'client revision');
  exactKeys(payload.revisions.service, ['repository', 'sha', 'image_digest', 'minimum_client_version'], 'service revision');
  for (const component of ['e2e', 'client', 'service']) {
    if (payload.revisions[component].repository !== repositories[component]) throw new Error('Qualification repository mismatch');
    requireCommit(payload.revisions[component].sha, `${component} SHA`);
  }
  requireImageDigest(payload.revisions.service.image_digest);
  requireNonNegativeSafeInteger(payload.revisions.client.client_version, 'Qualified Client version');
  requireNonNegativeSafeInteger(payload.revisions.service.minimum_client_version, 'Qualified minimum Client version');
  if (payload.revisions.client.client_version < payload.revisions.service.minimum_client_version) {
    throw new Error(`Qualified Client version ${payload.revisions.client.client_version} is below the qualified minimum Client version ${payload.revisions.service.minimum_client_version}`);
  }
  const floor = readMinimumSupportedClient();
  if (payload.revisions.service.minimum_client_version !== floor.version) {
    throw new Error(`Qualified minimum Client version ${payload.revisions.service.minimum_client_version} differs from the committed minimum-supported-client.json version ${floor.version}`);
  }

  if (payload.expected.service_commit !== payload.revisions.service.sha) {
    throw new Error('Qualification expectation does not name the qualified Service commit');
  }
  if (payload.expected.client_commit !== null && payload.expected.client_commit !== payload.revisions.client.sha) {
    throw new Error('Qualification expectation does not name the qualified Client commit');
  }

  exactKeys(payload.environment, ['stage', 'aws_account_id', 'aws_region', 'client_url', 'service_url'], 'qualification environment');
  if (payload.environment.stage !== 'beta' || payload.environment.aws_account_id !== '650880818323' || payload.environment.aws_region !== 'ap-east-1') throw new Error('Qualification account/region mismatch');
  if (!Number.isFinite(Date.parse(payload.qualified_at))) throw new Error('Invalid qualification timestamp');
  exactKeys(payload.observations, ['before', 'after'], 'observations');
  validateObservation(payload.observations.before, 'initial observation');
  validateObservation(payload.observations.after, 'final observation');
  assertStableObservation(payload.observations.before, payload.observations.after);
  assertObservationSequence(payload.observations, payload.qualified_at);
  validateServiceArtifacts(payload.service_artifacts, payload.revisions.service.sha);
  if (payload.revisions.service.image_digest !== payload.observations.after.service.image_digest
    || payload.environment.client_url !== payload.observations.after.client.url
    || payload.environment.service_url !== payload.observations.after.service.url) throw new Error('Qualification runtime binding mismatch');
  if (trustedRun && (trustedRun.id !== workflow.run_id || trustedRun.run_attempt !== workflow.run_attempt
    || trustedRun.head_sha !== payload.revisions.e2e.sha || trustedRun.repository?.full_name !== repositories.e2e
    || trustedRun.path !== workflow.path || trustedRun.event !== 'workflow_dispatch' || trustedRun.head_branch !== 'main'
    || trustedRun.status !== 'completed' || trustedRun.conclusion !== 'success')) throw new Error('Trusted E2E run binding mismatch');
  return true;
}

// The producer's own next step, run in the job that wrote both files: it refuses a record
// hand-edited between the report the suite wrote and the artifact upload. The report itself
// is retained in the qualification artifact, so the digest the record states is auditable
// against the bytes it names instead of being an unchecked claim.
export function verifyQualificationAgainstReport(record, reportBytes) {
  if (reportBytes === undefined || reportBytes === null) {
    throw new Error(`Verifying a qualification record against its run requires the Playwright JSON report bytes at ${QUALIFICATION_REPORT_PATH}`);
  }
  if (record?.test?.report_sha256 !== byteHash(reportBytes)) {
    throw new Error('Qualification record and Playwright report checksums differ');
  }
  assertEqual(record.test.scenarios, reportScenarios(reportBytes), 'Qualification scenarios and the Playwright report');
  return true;
}

export function assertObservationSequence({ before, after }, qualifiedAt) {
  const times = [before?.collected_at, after?.collected_at, qualifiedAt].map(Date.parse);
  if (times.some((value) => !Number.isFinite(value)) || times[0] >= times[1] || times[1] > times[2]) {
    throw new Error('Qualification observations must occur before and after the suite in order');
  }
  if (!before?.platform || !after?.platform) throw new Error('Both observations require an authenticated platform body');
  return true;
}

// Producer self-checks run while their workflow is still in progress. A release
// consumer must use this stricter entry point after downloading the exact attached
// artifact, not infer authenticity from the payload's checksum alone.
export function verifyQualificationForPromotion(record, { trustedRun, trustedArtifact, expected, recordBytes, now = Date.now() } = {}) {
  if (!trustedRun || !trustedArtifact || !expected || !recordBytes) throw new Error('Promotion requires authenticated run/artifact metadata and the attached record bytes');
  verifyQualificationRecord(record, { trustedRun });
  if (trustedArtifact.id !== expected.artifact_id || trustedArtifact.expired !== false
    || Date.parse(trustedArtifact.expires_at) <= now || !Number.isFinite(Date.parse(trustedArtifact.expires_at))
    || trustedArtifact.name !== `beta-qualification-${trustedRun.id}-${trustedRun.run_attempt}`
    || trustedArtifact.workflow_run?.id !== trustedRun.id || trustedArtifact.workflow_run?.head_sha !== trustedRun.head_sha
    || expected.run_id !== trustedRun.id || expected.run_attempt !== trustedRun.run_attempt
    || expected.e2e_sha !== trustedRun.head_sha) throw new Error('Trusted qualification artifact binding or lifetime mismatch');
  const bytesHash = byteHash(recordBytes);
  requireHash(expected.record_sha256, 'Qualification record checksum');
  if (bytesHash !== expected.record_sha256) throw new Error('Qualification exact-byte checksum mismatch');
  assertEqual(parseStrictJson(recordBytes), record, 'Downloaded qualification bytes');
  const start = Date.parse(trustedRun.run_started_at);
  const end = Date.parse(trustedRun.updated_at);
  const created = Date.parse(trustedArtifact.created_at);
  if (![start, end, created].every(Number.isFinite) || created < start || created > end
    || Date.parse(record.observations.before.collected_at) < start || Date.parse(record.qualified_at) > end) throw new Error('Qualification evidence does not belong to the trusted attempt interval');
  return true;
}
