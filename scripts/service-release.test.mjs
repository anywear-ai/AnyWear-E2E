import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  SERVICE_RELEASE_ASSET_NAMES, readServiceRelease, runServiceRelease, serviceReleaseArguments,
} from './service-release.mjs';
import { TAG_DEREF_LIMIT } from './github-read.mjs';
import { readMinimumSupportedClient } from './minimum-supported-client.mjs';

const serviceSha = 'b'.repeat(40);
const otherSha = 'e'.repeat(40);
const tag = `service-artifacts-${serviceSha}`;
const releasePath = `repos/anywear-ai/AnyWear-Service/releases/tags/${tag}`;
const refPath = `repos/anywear-ai/AnyWear-Service/git/ref/tags/${tag}`;
const tagObjectPath = (sha) => `repos/anywear-ai/AnyWear-Service/git/tags/${sha}`;

// #193: the four released names are a frozen constant. Each asset carries the size and the
// `sha256:<hex>` digest the release API publishes; the body is never fetched.
const digest = (letter) => `sha256:${letter.repeat(64)}`;
const assets = SERVICE_RELEASE_ASSET_NAMES.map((name, index) => ({
  id: 11 + index,
  name,
  state: 'uploaded',
  size: 1024 + index,
  digest: digest(String(index + 1)),
}));
const release = { id: 10, tag_name: tag, draft: false, immutable: true, assets };
const ref = { ref: `refs/tags/${tag}`, object: { type: 'commit', sha: serviceSha } };

// A GitHub API double. Release reads, the tag ref and annotated-tag derefs are routed;
// every other path, including any `/releases/assets/` path, throws. No test can therefore
// pass while fetching a release asset body.
function apiFor({ releaseRecord = release, refRecord = ref, tagObjects = {}, fail = () => false, seen = [] } = {}) {
  return async (path, binary, environment) => {
    seen.push({ path, binary, environment });
    if (fail(path, binary)) throw new Error('gh: Not Found (HTTP 404)');
    if (path === releasePath) return JSON.stringify(releaseRecord);
    if (path === refPath) return JSON.stringify(refRecord);
    const annotated = /^repos\/anywear-ai\/AnyWear-Service\/git\/tags\/([0-9a-f]{40})$/.exec(path);
    if (annotated && Object.hasOwn(tagObjects, annotated[1])) return JSON.stringify(tagObjects[annotated[1]]);
    if (path.includes('/releases/assets/')) throw new Error(`release asset bytes must not be read (${path})`);
    throw new Error(`unexpected GitHub API path ${path}`);
  };
}

const READ_TOKEN = 'service-read-fixture';
const read = (overrides = {}) => readServiceRelease({
  serviceSha, api: apiFor(overrides),
  environment: { SERVICE_ARTIFACT_READ_TOKEN: READ_TOKEN, GH_TOKEN: 'ambient-token', GITHUB_TOKEN: 'workflow-token' },
});

test('resolves the live Service identity from the release and its tag, reading no asset bytes', async () => {
  const seen = [];
  const result = await readServiceRelease({
    serviceSha, api: apiFor({ seen }),
    environment: { SERVICE_ARTIFACT_READ_TOKEN: READ_TOKEN, GH_TOKEN: 'ambient-token', GITHUB_TOKEN: 'workflow-token' },
  });
  assert.deepEqual(result.identity, {
    repository: 'anywear-ai/AnyWear-Service',
    release_id: 10,
    tag,
    target_commit: serviceSha,
    assets: Object.fromEntries(SERVICE_RELEASE_ASSET_NAMES.map((name, index) => [name, {
      size: 1024 + index, digest: digest(String(index + 1)),
    }])),
  });
  assert.deepEqual(Object.keys(result.identity.assets), [...SERVICE_RELEASE_ASSET_NAMES]);
  assert.equal(result.targetCommit, serviceSha);
  assert.equal(result.dereferences, 0);
  // Exactly two REST reads — the release and the tag ref — and neither is an asset read.
  assert.deepEqual(seen.map(({ path }) => path), [releasePath, refPath]);
  assert.ok(seen.every(({ binary }) => binary === false));
  // Every read is scoped to the Service token: the ambient workflow token and the inline
  // Service token are both replaced by the one scoped GH_TOKEN.
  for (const call of seen) {
    assert.equal(call.environment.GH_TOKEN, READ_TOKEN);
    assert.equal(call.environment.SERVICE_ARTIFACT_READ_TOKEN, undefined);
    assert.equal(call.environment.GITHUB_TOKEN, undefined);
  }
  // A missing scoped token refuses before any API call.
  await assert.rejects(readServiceRelease({ serviceSha, api: apiFor({ seen }), environment: {} }),
    /requires the scoped anywear-ai\/AnyWear-Service token: SERVICE_ARTIFACT_READ_TOKEN required/);
});

test('fails closed when the release, the tag ref or an annotated tag cannot be read', async () => {
  await assert.rejects(read({ fail: (path) => path.startsWith('repos/anywear-ai/AnyWear-Service/releases/') }),
    new RegExp(`Immutable Service release ${tag} could not be read from anywear-ai/AnyWear-Service`));
  await assert.rejects(read({ fail: (path) => path === refPath }),
    new RegExp(`Tag ${tag} could not be read from anywear-ai/AnyWear-Service \\(gh: Not Found`));
  const annotatedSha = 'a'.repeat(40);
  await assert.rejects(read({
    refRecord: { object: { type: 'tag', sha: annotatedSha } },
    tagObjects: { [annotatedSha]: { object: { type: 'commit', sha: serviceSha } } },
    fail: (path) => path === tagObjectPath(annotatedSha),
  }), new RegExp(`Tag ${tag} annotated tag ${annotatedSha} could not be read from anywear-ai/AnyWear-Service`));
});

test('refuses a draft, non-immutable or mis-tagged release', async () => {
  await assert.rejects(read({ releaseRecord: { ...release, draft: true } }),
    /must be published \(draft true\)/);
  for (const immutable of [false, undefined, 'true']) {
    await assert.rejects(read({ releaseRecord: { ...release, immutable } }),
      /must be immutable/);
  }
  await assert.rejects(read({ releaseRecord: { ...release, id: 0 } }),
    /Service release ID must be a positive integer/);
  await assert.rejects(read({ releaseRecord: { ...release, tag_name: 'service-artifacts-other' } }),
    new RegExp(`Service release tag mismatch: expected ${tag}, observed "service-artifacts-other"`));
});

test('refuses a tag that does not resolve to the live Service commit, naming both commits', async () => {
  await assert.rejects(read({ refRecord: { object: { type: 'commit', sha: otherSha } } }),
    new RegExp(`Service release ${tag} tag resolves to ${otherSha}, not the live Service commit ${serviceSha}`));
  const annotatedSha = 'a'.repeat(40);
  await assert.rejects(read({
    refRecord: { object: { type: 'tag', sha: annotatedSha } },
    tagObjects: { [annotatedSha]: { object: { type: 'commit', sha: otherSha } } },
  }), new RegExp(`tag resolves to ${otherSha}`));
});

test('follows an annotated tag to its commit and refuses a too-deep or non-commit chain', async () => {
  const first = 'a'.repeat(40);
  const second = 'c'.repeat(40);
  const seen = [];
  const resolved = await readServiceRelease({
    serviceSha,
    api: apiFor({
      seen,
      refRecord: { object: { type: 'tag', sha: first } },
      tagObjects: { [first]: { object: { type: 'tag', sha: second } }, [second]: { object: { type: 'commit', sha: serviceSha } } },
    }),
    environment: { SERVICE_ARTIFACT_READ_TOKEN: READ_TOKEN },
  });
  assert.equal(resolved.targetCommit, serviceSha);
  assert.equal(resolved.dereferences, 2);
  assert.deepEqual(seen.map(({ path }) => path), [releasePath, refPath, tagObjectPath(first), tagObjectPath(second)]);

  // A chain deeper than the issue's bound of four annotated-tag dereferences is refused.
  const chain = {};
  for (let index = 1; index <= TAG_DEREF_LIMIT; index += 1) {
    chain[String(index).repeat(40)] = { object: { type: 'tag', sha: String(index + 1).repeat(40) } };
  }
  await assert.rejects(read({
    refRecord: { object: { type: 'tag', sha: '1'.repeat(40) } },
    tagObjects: chain,
  }), new RegExp(`annotated-tag chain exceeds ${TAG_DEREF_LIMIT} dereferences`));

  // A chain that ends in a tree or a blob is not a commit.
  await assert.rejects(read({ refRecord: { object: { type: 'tree', sha: serviceSha } } }),
    new RegExp(`Tag ${tag} resolves to a tree object, not a commit`));
  await assert.rejects(read({
    refRecord: { object: { type: 'tag', sha: first } },
    tagObjects: { [first]: { object: { type: 'blob', sha: serviceSha } } },
  }), new RegExp(`Tag ${tag} resolves to a blob object, not a commit`));

  // Malformed git objects are refused instead of being dereferenced.
  await assert.rejects(read({ refRecord: { object: { type: 'commit', sha: 'main' } } }),
    /is not a full lowercase 40-character object SHA/);
  await assert.rejects(read({ refRecord: {} }),
    /ref object is malformed/);
  await assert.rejects(read({ refRecord: { object: { sha: serviceSha } } }),
    /type is required/);
});

test('requires exactly the four expected assets to be present, uploaded, sized and digested', async () => {
  for (const name of SERVICE_RELEASE_ASSET_NAMES) {
    const without = assets.filter((asset) => asset.name !== name);
    await assert.rejects(read({ releaseRecord: { ...release, assets: without } }),
      new RegExp(`has no ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} asset \\(assets `));
  }
  await assert.rejects(read({ releaseRecord: { ...release, assets: [] } }),
    /has no pre-sign-up\.zip asset \(assets \[\]\)/);
  await assert.rejects(read({ releaseRecord: { ...release, assets: [...assets, { ...assets[0], id: 30 }] } }),
    /has 2 pre-sign-up\.zip assets; exactly one is required/);
  await assert.rejects(read({
    releaseRecord: { ...release, assets: assets.map((asset) => asset.name === 'runtime-policy.json' ? { ...asset, state: 'starter' } : asset) },
  }), /asset runtime-policy\.json is not uploaded \(state "starter"\)/);
  for (const size of [0, -1, 1.5, '1024', undefined]) {
    await assert.rejects(read({
      releaseRecord: { ...release, assets: assets.map((asset) => asset.name === 'service-schema.json' ? { ...asset, size } : asset) },
    }), /asset service-schema\.json size .+ is not a positive integer/);
  }
  for (const value of [undefined, null, 'sha256:', `sha256:${'1'.repeat(63)}`, `sha256:${'G'.repeat(64)}`, `sha512:${'1'.repeat(128)}`]) {
    await assert.rejects(read({
      releaseRecord: { ...release, assets: assets.map((asset) => asset.name === 'pre-sign-up.zip' ? { ...asset, digest: value } : asset) },
    }), /asset pre-sign-up\.zip digest .+ is not a sha256:<hex> digest/);
  }
});

// #193 transitional acceptance: a pre-change release carries five assets, including the
// legacy manifest. The gate requires the four names it consumes and ignores the extra one;
// the manifest is never parsed as identity and its bytes are never fetched.
const LEGACY_MANIFEST_ASSET = 'service-artifacts.json';

test('accepts a legacy five-asset release and ignores the extra manifest asset', async () => {
  const legacy = {
    ...release,
    assets: [...assets, { id: 99, name: LEGACY_MANIFEST_ASSET, state: 'uploaded', size: 242, digest: digest('f') }],
  };
  const seen = [];
  const result = await readServiceRelease({
    serviceSha, api: apiFor({ releaseRecord: legacy, seen }),
    environment: { SERVICE_ARTIFACT_READ_TOKEN: READ_TOKEN },
  });
  assert.deepEqual(Object.keys(result.identity.assets), [...SERVICE_RELEASE_ASSET_NAMES]);
  assert.equal(LEGACY_MANIFEST_ASSET in result.identity.assets, false);
  assert.ok(seen.every(({ path }) => !path.includes('/releases/assets/')));
});

test('parses the CLI surface and refuses an unknown or incomplete one', () => {
  assert.deepEqual(serviceReleaseArguments([
    '--operation', 'full', '--client-url', 'https://client.example', '--service-url', 'https://api.example',
    '--expected-service-commit', serviceSha,
  ]), {
    operation: 'full', clientUrl: 'https://client.example', serviceUrl: 'https://api.example', expectedServiceCommit: serviceSha,
  });
  assert.deepEqual(serviceReleaseArguments(['--operation', 'reconcile']), { operation: 'reconcile' });
  assert.deepEqual(serviceReleaseArguments(['--help']), { help: true });
  for (const [argv, pattern] of [
    [[], /requires --operation/],
    [['--operation', 'preflight'], /does not know the operation/],
    [['--operation', 'full'], /requires --client-url/],
    [['--operation', 'smoke', '--client-url', 'https://client.example'], /requires --service-url/],
    [['--operation', 'full', '--client-url', 'https://client.example', '--service-url', 'https://api.example', '--unknown', 'x'], /Unknown service-release argument/],
    [['--operation', 'full', '--operation', 'smoke'], /Duplicate service-release argument/],
    [['--operation'], /requires a value/],
  ]) {
    assert.throws(() => serviceReleaseArguments(argv), pattern, argv.join(' '));
  }
});

// The live fixture derives its Client version and Service floor from the committed
// `minimum-supported-client.json`, so raising the reviewed floor moves this fixture with it
// instead of pinning a stale literal.
const committedFloor = readMinimumSupportedClient().version;

const liveMetadata = () => ({
  client: {
    component: 'AnyWear-Client', schema_version: 3, source_commit: 'a'.repeat(40), client_version: committedFloor,
    built_at: '2026-10-07T00:00:00.000Z',
  },
  service: { status: 'ok', service_commit: serviceSha, image_digest: `sha256:${'c'.repeat(64)}`, minimum_client_version: committedFloor },
});
const fetcherFor = ({ client, service }) => async (url) => new Response(
  JSON.stringify(url.pathname === '/build-metadata.json' ? client : service), { status: 200 },
);

test('skips the live check for the operations that do not gate on the deployed tuple', async () => {
  let called = false;
  const result = await runServiceRelease({
    argv: ['--operation', 'reconcile'], api: () => { called = true; }, log: () => {},
  });
  assert.deepEqual(result, { skipped: true });
  assert.equal(called, false);
});

test('writes the verified live identity and release identity for the record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-service-release-'));
  try {
    const metadata = liveMetadata();
    const result = await runServiceRelease({
      argv: [
        '--operation', 'full',
        '--client-url', 'https://client123.cloudfront.net',
        '--service-url', 'https://api123.cloudfront.net',
        '--expected-service-commit', serviceSha,
        '--expected-client-commit', 'a'.repeat(40),
      ],
      environment: { GITHUB_RUN_ID: '123', SERVICE_ARTIFACT_READ_TOKEN: READ_TOKEN },
      api: apiFor(),
      fetcher: fetcherFor(metadata),
      inputsDirectory: directory,
      log: () => {},
    });
    assert.equal(result.release.tag, tag);
    assert.equal(result.release.target_commit, serviceSha);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'service-release.json'), 'utf8')), result.release);
    // The retired manifest input is not produced: the record builder reads the release
    // identity, and no file carries a manifest body.
    await assert.rejects(access(join(directory, LEGACY_MANIFEST_ASSET)), /ENOENT/);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'live-identity.json'), 'utf8')), {
      client: {
        url: 'https://client123.cloudfront.net', source_commit: 'a'.repeat(40),
        built_at: '2026-10-07T00:00:00.000Z', client_version: committedFloor,
      },
      service: {
        url: 'https://api123.cloudfront.net', service_commit: serviceSha,
        image_digest: `sha256:${'c'.repeat(64)}`, minimum_client_version: committedFloor,
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('refuses a wrong expectation or floor before the release read', async () => {
  const metadata = liveMetadata();
  let apiCalled = false;
  const run = (overrides = {}) => runServiceRelease({
    argv: [
      '--operation', 'full', '--client-url', 'https://client123.cloudfront.net', '--service-url', 'https://api123.cloudfront.net',
      ...(overrides.expected ?? ['--expected-service-commit', serviceSha]),
    ],
    environment: { GITHUB_RUN_ID: '123', SERVICE_ARTIFACT_READ_TOKEN: READ_TOKEN },
    api: () => { apiCalled = true; throw new Error('release read must not run'); },
    fetcher: fetcherFor({ ...metadata, ...overrides.metadata }),
    inputsDirectory: join(tmpdir(), 'anywear-service-release-unused'),
    log: () => {},
  });
  await assert.rejects(run({ expected: ['--expected-service-commit', 'f'.repeat(40)] }),
    /Deployed Service service_commit mismatch[^\n]*expected f{40} \(dispatch input\), observed b{40} \(live\)/);
  assert.equal(apiCalled, false);
  await assert.rejects(run({ metadata: { service: { ...metadata.service, minimum_client_version: committedFloor + 1 } } }),
    /sync minimum-supported-client\.json/);
  assert.equal(apiCalled, false);
  await assert.rejects(run(), /release read must not run/);
  assert.equal(apiCalled, true);
});
