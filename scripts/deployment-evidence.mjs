import {
  assertEqual, exactKeys, parseStrictJson, requireCommit, requireHttpsUrl, requireImageDigest, requireString,
} from './evidence-contract.mjs';
import { assertLiveClientFloor, readMinimumSupportedClient } from './minimum-supported-client.mjs';

// AnyWear #180/#358: one observation of the live deployed tuple, and the Service release
// identity the gate verifies against it. This module carries only what the gate still reads:
// the two live identities (Client `build-metadata.json`, Service `/health`), the committed
// Client floor comparison, the before/after stability check, and the immutable
// `service-artifacts-<service sha>` release tag plus its four expected asset names.
//
// #358 removed the qualification ledger, and with it this observation's `platform` member:
// the full-resource hash snapshot behind `platform` existed to seal a record, and the
// platform is now observed by the live identity re-read on both sides of the suite plus the
// writer/starter mutex. Nothing here reads a committed file that describes the deployment;
// `minimum-supported-client.json` is the only committed input on the live path.
export const OBSERVATION_KEYS = Object.freeze(['collected_at', 'client', 'service', 'authenticated']);
export const OBSERVED_CLIENT_KEYS = Object.freeze(['url', 'source_commit', 'built_at']);
export const OBSERVED_SERVICE_KEYS = Object.freeze(['url', 'service_commit', 'image_digest']);
// #193: the Service release publishes exactly these four assets. The set is frozen here
// (and in the Service and Infra slices) so the gate cannot accept a release that renamed,
// dropped or added a consumed name; an extra legacy asset is ignored, which is what keeps
// a pre-change five-asset release gated during the transition.
export const SERVICE_RELEASE_ASSET_NAMES = Object.freeze([
  'pre-sign-up.zip',
  'post-confirmation.zip',
  'runtime-policy.json',
  'service-schema.json',
]);
export const SERVICE_ARTIFACTS_PREFIX = 'service-artifacts-';

function requireNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requireTimestamp(value, label) {
  if (!Number.isFinite(Date.parse(requireString(value, label)))) throw new Error(`${label} must be an ISO timestamp`);
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

// Read only the two live identities the gate is allowed to trust: the Client's
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
  clientMetadataUrl.searchParams.set('gate', cacheBuster);

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

// One observation, exactly the shape the run writes and the stability check re-reads.
// `authenticated: true` is a literal assertion that the observation was taken with the
// verified Beta principal; a run cannot claim an unauthenticated observation.
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

  if (observation.authenticated !== true) {
    throw new Error(`${label} must state authenticated: true; the observation is taken with the verified Beta principal`);
  }
  return observation;
}

// The observed identity must be equal before and after the suite: the Client the run is
// testing and the Service it is testing against. A deployment that replaces either one
// during the suite is a first-class mismatch, and the gate's own re-read is what makes the
// run red instead of attributing a platform replacement to the product.
export function assertStableObservation(before, after) {
  validateObservation(before, 'initial observation');
  validateObservation(after, 'final observation');
  assertEqual(before.client, after.client, 'Deployed Client identity');
  assertEqual(before.service, after.service, 'Deployed Service identity');
  return true;
}
