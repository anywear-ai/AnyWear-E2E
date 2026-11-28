import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseStrictJson, repositories, requireCommit, requireId } from './evidence-contract.mjs';
import { ghApi, repositoryReadEnvironment, resolveTagCommit } from './github-read.mjs';
import { collectDeploymentEvidence, SERVICE_RELEASE_ASSET_NAMES, serviceArtifactsTag } from './deployment-evidence.mjs';

// #180/#193: the live Service identity must resolve to one immutable release, and this is
// the credential-free reader that proves it. It performs no AWS call, no mutation and no
// release-asset download: two GitHub API reads (the `service-artifacts-<sha>` release and
// the tag ref it names) plus one read per annotated-tag dereference. The release must be
// published (not draft), immutable, tagged with the exact live Service commit, its tag
// must resolve to that commit (following annotated tags), and the four expected assets
// must each be uploaded with a non-empty size and a published `sha256:<hex>` digest. Extra
// assets are ignored, so a pre-change five-asset release stays qualifiable during the 5→4
// transition.
//
// This replaces both the pinned release identity the compatibility file used to carry and
// the hand-built artifact manifest the reader used to consume: the live deployment
// supplies the expected commit, and the release itself carries the tag, immutability,
// target commit and per-asset digests. A missing release, a non-immutable release, a
// wrong tag→commit binding, a missing or malformed expected asset, an HTTP failure and a
// floor mismatch all fail closed before any AWS credential is requested.
export { SERVICE_RELEASE_ASSET_NAMES };
// The operations whose gate depends on the live deployed tuple. `reconcile` does not consult
// it (#217): it must resolve a leftover even while the deployed tuple is being replaced, and
// the Service cleanup envelope takes its source/image pair from the live deployment evidence
// the reconcile job reads for itself.
export const LIVE_OPERATIONS = Object.freeze(['full', 'smoke']);

const ASSET_DIGEST = /^sha256:[0-9a-f]{64}$/;

const describe = (value) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const assetsOf = (release) => (Array.isArray(release?.assets) ? release.assets : []);

// The four expected names are a frozen constant; only their presence, upload state, size
// and published digest are read. The asset body is never fetched: the digest is the
// release API's own statement about bytes this run does not consume.
function expectedAssets(release, tag) {
  const assets = assetsOf(release);
  const observed = assets.map((entry) => entry?.name);
  const selected = {};
  for (const name of SERVICE_RELEASE_ASSET_NAMES) {
    const matches = assets.filter((entry) => entry?.name === name);
    if (matches.length === 0) {
      throw new Error(`Service release ${tag} has no ${name} asset (assets ${describe(observed)})`);
    }
    if (matches.length > 1) {
      throw new Error(`Service release ${tag} has ${matches.length} ${name} assets; exactly one is required (assets ${describe(observed)})`);
    }
    const [asset] = matches;
    if (asset.state !== 'uploaded') {
      throw new Error(`Service release ${tag} asset ${name} is not uploaded (state ${describe(asset.state)})`);
    }
    if (!Number.isSafeInteger(asset.size) || asset.size < 1) {
      throw new Error(`Service release ${tag} asset ${name} size ${describe(asset.size)} is not a positive integer`);
    }
    if (typeof asset.digest !== 'string' || !ASSET_DIGEST.test(asset.digest)) {
      throw new Error(`Service release ${tag} asset ${name} digest ${describe(asset.digest)} is not a sha256:<hex> digest`);
    }
    selected[name] = { size: asset.size, digest: asset.digest };
  }
  return selected;
}

export async function readServiceRelease({ serviceSha, repository = repositories.service, api = ghApi, environment = process.env } = {}) {
  requireCommit(serviceSha, 'Live Service commit');
  // The read is scoped to exactly one repository: the Service App token is renamed to
  // GH_TOKEN for the child command and every other reader token is removed. Resolving it
  // here (not only in the workflow's step env) keeps a local CLI run working and means the
  // caller cannot accidentally read another repository with this token.
  let scopedEnvironment;
  try {
    scopedEnvironment = repositoryReadEnvironment(repository, environment);
  } catch (error) {
    throw new Error(`Service release read requires the scoped ${repository} token: ${error.message}`, { cause: error });
  }
  const tag = serviceArtifactsTag(serviceSha);
  let release;
  try {
    release = parseStrictJson(await api(`repos/${repository}/releases/tags/${tag}`, false, scopedEnvironment));
  } catch (error) {
    throw new Error(`Immutable Service release ${tag} could not be read from ${repository}: no published release names the live Service commit (${String(error.message ?? error).split('\n')[0]})`, { cause: error });
  }
  if (release?.tag_name !== tag) {
    throw new Error(`Service release tag mismatch: expected ${tag}, observed ${describe(release?.tag_name)}`);
  }
  if (release.draft !== false) {
    throw new Error(`Service release ${tag} must be published (draft ${describe(release.draft)}); qualification requires a non-draft release`);
  }
  if (release.immutable !== true) {
    throw new Error(`Service release ${tag} must be immutable (immutable ${describe(release.immutable)}); qualification requires an immutable release`);
  }
  requireId(release.id, 'Service release ID');
  const { commit: targetCommit, dereferences } = await resolveTagCommit({
    repository, tag, api, environment: scopedEnvironment,
  });
  if (targetCommit !== serviceSha) {
    throw new Error(`Service release ${tag} tag resolves to ${targetCommit}, not the live Service commit ${serviceSha}`);
  }
  const assets = expectedAssets(release, tag);
  return {
    identity: {
      repository,
      release_id: release.id,
      tag,
      target_commit: targetCommit,
      assets,
    },
    release,
    targetCommit,
    dereferences,
  };
}

const USAGE = `Usage: node scripts/service-release.mjs --operation <full|smoke|reconcile> --client-url <url> --service-url <url> [--expected-service-commit <sha>] [--expected-client-commit <sha>] [--inputs-dir <dir>]

Reads the live Client build metadata and Service health, compares them with the
dispatch expectation, enforces the committed supported-Client floor, and verifies
that the live Service commit resolves to an immutable Service release whose tag
resolves to that commit and whose four expected assets each carry a published
digest. Writes live-identity.json and service-release.json under the inputs
directory. It never reads a committed compatibility file, never downloads a
release asset and never requests an AWS credential.
`;

const ARGUMENTS = Object.freeze({
  '--operation': 'operation',
  '--client-url': 'clientUrl',
  '--service-url': 'serviceUrl',
  '--expected-service-commit': 'expectedServiceCommit',
  '--expected-client-commit': 'expectedClientCommit',
  '--inputs-dir': 'inputsDir',
});

export function serviceReleaseArguments(argv = []) {
  if (argv.includes('--help')) return { help: true };
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const key = ARGUMENTS[flag];
    if (!key) throw new Error(`Unknown service-release argument ${flag}`);
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.length === 0) throw new Error(`Service-release argument ${flag} requires a value`);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate service-release argument ${flag}`);
    options[key] = value;
  }
  if (!options.operation) throw new Error('service-release requires --operation');
  if (!['full', 'smoke', 'reconcile'].includes(options.operation)) {
    throw new Error(`service-release does not know the operation ${describe(options.operation)}`);
  }
  if (LIVE_OPERATIONS.includes(options.operation)) {
    for (const key of ['clientUrl', 'serviceUrl']) {
      if (!options[key]) throw new Error(`service-release requires --${key === 'clientUrl' ? 'client-url' : 'service-url'} for operation ${options.operation}`);
    }
  }
  return options;
}

// The credential-free CLI the preflight and `full` run. It writes the two inputs the
// record is built from, so the record states the exact release identity the gate
// verified rather than a copy of a committed file.
export async function runServiceRelease({
  argv = process.argv.slice(2), environment = process.env, api = ghApi, fetcher = fetch,
  inputsDirectory, log = console.log,
} = {}) {
  const options = serviceReleaseArguments(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return { help: true };
  }
  if (!LIVE_OPERATIONS.includes(options.operation)) {
    log(`Operation ${options.operation} does not gate on the live deployed tuple; the credential-free live identity check is skipped.`);
    return { skipped: true };
  }
  const expected = {
    service_commit: options.expectedServiceCommit ?? null,
    client_commit: options.expectedClientCommit ?? null,
  };
  const identity = await collectDeploymentEvidence({
    clientUrl: options.clientUrl,
    serviceUrl: options.serviceUrl,
    runId: environment.GITHUB_RUN_ID,
  }, expected, fetcher);
  const release = await readServiceRelease({
    serviceSha: identity.service.service_commit,
    api,
    environment,
  });
  const directory = resolve(inputsDirectory ?? options.inputsDir ?? environment.E2E_INPUTS_DIR ?? '.e2e-inputs');
  await mkdir(directory, { recursive: true });
  const live = {
    client: { ...identity.client, client_version: identity.client_version },
    service: { ...identity.service, minimum_client_version: identity.minimum_client_version },
  };
  await writeFile(resolve(directory, 'live-identity.json'), `${JSON.stringify(live, null, 2)}\n`);
  await writeFile(resolve(directory, 'service-release.json'), `${JSON.stringify(release.identity, null, 2)}\n`);
  log(`Live tuple: Client ${identity.client.source_commit} version ${identity.client_version}; Service ${identity.service.service_commit} ${identity.service.image_digest}; minimum Client ${identity.minimum_client_version}`);
  log(`Immutable Service release ${release.identity.tag}: release ${release.identity.release_id}, target ${release.identity.target_commit}, ${SERVICE_RELEASE_ASSET_NAMES.length} expected assets with published digests`);
  return { identity, release: release.identity, live };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runServiceRelease({ argv: process.argv.slice(2) });
}
