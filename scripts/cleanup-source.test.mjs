import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CLEANUP_IMAGE_ENV, CLEANUP_SOURCE_ENV, CLEANUP_SOURCE_GRAMMAR, CLEANUP_IMAGE_GRAMMAR, CleanupImageRefusal,
  CleanupSourceRefusal, gate, readCleanupPair, runCleanupSourceCli, verify,
} from './cleanup-source.mjs';
import { SERVICE_RELEASE_ASSET_NAMES } from './service-release.mjs';

// #339: the credential-free reader and the pair comparison. Both seams are injected, so no test
// reaches the network and none edits an envelope or a deployment. The GitHub double serves the
// release and the tag ref; every other path fails, and a release-asset path can never be read.
const serviceCommit = 'b'.repeat(40);
const otherCommit = 'a'.repeat(40);
const imageDigest = `sha256:${'c'.repeat(64)}`;
const otherDigest = `sha256:${'d'.repeat(64)}`;
const serviceUrl = 'https://api.example';
const tag = `service-artifacts-${serviceCommit}`;
const releasePath = `repos/anywear-ai/AnyWear-Service/releases/tags/${tag}`;
const refPath = `repos/anywear-ai/AnyWear-Service/git/ref/tags/${tag}`;
const READ_TOKEN = 'service-read-fixture';

const digest = (letter) => `sha256:${letter.repeat(64)}`;
const assets = SERVICE_RELEASE_ASSET_NAMES.map((name, index) => ({
  id: 11 + index, name, state: 'uploaded', size: 1024 + index, digest: digest(String(index + 1)),
}));
const release = { id: 10, tag_name: tag, draft: false, immutable: true, assets };
const ref = { object: { type: 'commit', sha: serviceCommit } };

function apiFor({ releaseRecord = release, refRecord = ref, fail = () => false } = {}) {
  return async (path) => {
    if (fail(path)) throw new Error('gh: Not Found (HTTP 404)');
    if (path === releasePath) return JSON.stringify(releaseRecord);
    if (path === refPath) return JSON.stringify(refRecord);
    if (path.includes('/releases/assets/')) throw new Error(`release asset bytes must not be read (${path})`);
    throw new Error(`unexpected GitHub API path ${path}`);
  };
}

const health = (overrides = {}) => ({
  status: 'ok', service_commit: serviceCommit, image_digest: imageDigest, ...overrides,
});
const fetcherFor = (body, status = 200) => async () => new Response(
  typeof body === 'string' ? body : JSON.stringify(body), { status },
);
const readEnvironment = { SERVICE_ARTIFACT_READ_TOKEN: READ_TOKEN };
const runVerify = ({ operation = 'reconcile', fetcher = fetcherFor(health()), api = apiFor(), environment = readEnvironment } = {}) => verify({
  serviceUrl, operation, api, fetcher, environment,
});
const rejection = async (promise) => promise.then(() => null, (error) => error);

test('the pair the job derives equals the pair preflight proved', () => {
  assert.deepEqual(gate({
    serviceCommit, imageDigest, expectedServiceCommit: serviceCommit, expectedServiceImageDigest: imageDigest, operation: 'full',
  }), { compared: true, operation: 'full', serviceCommit, imageDigest });
});

test('a dispatch expectation that differs from the derived pair is refused drift, naming both values', async () => {
  const commitError = await rejection(Promise.resolve().then(() => gate({
    serviceCommit, imageDigest, expectedServiceCommit: otherCommit, expectedServiceImageDigest: imageDigest, operation: 'full',
  })));
  assert.ok(commitError instanceof CleanupSourceRefusal);
  assert.match(commitError.message, /^Service cleanup source refused \(drift\): value="a{40}"; operation=full; grammar=\^\[0-9a-f\]\{40\}\$; /);
  assert.match(commitError.message, new RegExp(`observes "${serviceCommit}" \\(${CLEANUP_SOURCE_ENV}\\)`));
  assert.match(commitError.message, /needs\.preflight\.outputs\.reviewed_service_commit/);

  const imageError = await rejection(Promise.resolve().then(() => gate({
    serviceCommit, imageDigest, expectedServiceCommit: serviceCommit, expectedServiceImageDigest: otherDigest, operation: 'full',
  })));
  assert.ok(imageError instanceof CleanupImageRefusal);
  assert.match(imageError.message, /^Service cleanup image refused \(drift\): value="sha256:d{64}"; operation=full; grammar=\^sha256:\[0-9a-f\]\{64\}\$; /);
  assert.match(imageError.message, new RegExp(`observes "${imageDigest}" \\(${CLEANUP_IMAGE_ENV}\\)`));
  assert.match(imageError.message, /needs\.preflight\.outputs\.reviewed_service_image_digest/);
});

test('a missing release is absent, naming the deployed commit and the tag that was looked for', async () => {
  const error = await rejection(runVerify({ api: apiFor({ fail: (path) => path === releasePath }) }));
  assert.ok(error instanceof CleanupSourceRefusal);
  assert.equal(error.reason, 'absent');
  assert.match(error.message, new RegExp(`^Service cleanup source refused \\(absent\\): value="${serviceCommit}"; operation=reconcile; grammar=\\^\\[0-9a-f\\]\\{40\\}\\$; `));
  assert.match(error.message, new RegExp(`looked for release tag ${tag}`));
  assert.match(error.message, /no published immutable release names the deployed Service commit/);
});

test('a release whose tag resolves to another commit is drift, naming both commits', async () => {
  const error = await rejection(runVerify({ api: apiFor({ refRecord: { object: { type: 'commit', sha: otherCommit } } }) }));
  assert.ok(error instanceof CleanupSourceRefusal);
  assert.equal(error.reason, 'drift');
  assert.match(error.message, new RegExp(`^Service cleanup source refused \\(drift\\): value="${serviceCommit}"; operation=reconcile; `));
  assert.match(error.message, new RegExp(`resolves to ${otherCommit} now, not the deployed Service commit ${serviceCommit}`));
});

test('a draft release keeps the release reader refusal that names the release and its state', async () => {
  const error = await rejection(runVerify({ api: apiFor({ releaseRecord: { ...release, draft: true } }) }));
  assert.match(error.message, /must be published \(draft true\)/);
});

test('a release missing one of the four assets keeps the release reader refusal', async () => {
  const without = assets.filter((asset) => asset.name !== 'runtime-policy.json');
  const error = await rejection(runVerify({ api: apiFor({ releaseRecord: { ...release, assets: without } }) }));
  assert.match(error.message, /has no runtime-policy\.json asset/);
});

test('a malformed /health value is refused with the grammar that applied', async () => {
  const commitError = await rejection(runVerify({ fetcher: fetcherFor(health({ service_commit: 'main' })) }));
  assert.ok(commitError instanceof CleanupSourceRefusal);
  assert.match(commitError.message, /^Service cleanup source refused \(malformed\): value="main"; operation=reconcile; grammar=\^\[0-9a-f\]\{40\}\$; /);

  const digestError = await rejection(runVerify({ fetcher: fetcherFor(health({ image_digest: 'latest' })) }));
  assert.ok(digestError instanceof CleanupImageRefusal);
  assert.match(digestError.message, /^Service cleanup image refused \(malformed\): value="latest"; operation=reconcile; grammar=\^sha256:\[0-9a-f\]\{64\}\$; /);
});

test('an unreachable, non-ok or commitless /health is unset', async () => {
  for (const fetcher of [
    async () => { throw new Error('connect ECONNREFUSED'); },
    fetcherFor(health(), 503),
    fetcherFor(health({ status: 'degraded' })),
    fetcherFor(health({ service_commit: undefined })),
    fetcherFor('{"status":"ok"'),
  ]) {
    const error = await rejection(runVerify({ fetcher }));
    assert.ok(error instanceof CleanupSourceRefusal, String(error));
    assert.equal(error.reason, 'unset');
    assert.match(error.message, /^Service cleanup source refused \(unset\): value=<absent>; operation=reconcile; grammar=\^\[0-9a-f\]\{40\}\$; /);
    assert.match(error.message, new RegExp(`${serviceUrl}/health`));
  }
});

test('no pin is a no-op for a scheduled reconcile and unset for a pinned operation', async () => {
  assert.deepEqual(gate({ serviceCommit, imageDigest, operation: 'reconcile' }), { compared: false, operation: 'reconcile' });
  for (const operation of ['full', 'smoke']) {
    const error = await rejection(Promise.resolve().then(() => gate({ serviceCommit, imageDigest, operation })));
    assert.ok(error instanceof CleanupSourceRefusal);
    assert.equal(error.reason, 'unset');
    assert.match(error.message, new RegExp(`^Service cleanup source refused \\(unset\\): value=<absent>; operation=${operation}; `));
    assert.match(error.message, new RegExp(`no reviewed pair was pinned for ${operation}`));
  }
});

test('a derived pair that is absent or malformed is refused before any comparison', async () => {
  for (const [pair, reason, source] of [
    [{ imageDigest }, 'unset', 'source'],
    [{ serviceCommit: 'main', imageDigest }, 'malformed', 'source'],
    [{ serviceCommit }, 'unset', 'image'],
    [{ serviceCommit, imageDigest: 'latest' }, 'malformed', 'image'],
  ]) {
    const error = await rejection(Promise.resolve().then(() => gate({
      ...pair, expectedServiceCommit: serviceCommit, expectedServiceImageDigest: imageDigest, operation: 'full',
    })));
    const refusal = source === 'source' ? CleanupSourceRefusal : CleanupImageRefusal;
    assert.ok(error instanceof refusal, String(error));
    assert.equal(error.reason, reason);
  }
});

test('readCleanupPair reads only the two derived names and names the one that is missing', () => {
  assert.deepEqual(readCleanupPair({ [CLEANUP_SOURCE_ENV]: serviceCommit, [CLEANUP_IMAGE_ENV]: imageDigest }),
    { serviceCommit, imageDigest });
  assert.throws(() => readCleanupPair({ [CLEANUP_IMAGE_ENV]: imageDigest, E2E_OPERATION: 'smoke' }),
    new RegExp(`${CLEANUP_SOURCE_ENV} is unset`));
  assert.throws(() => readCleanupPair({ [CLEANUP_SOURCE_ENV]: 'main', [CLEANUP_IMAGE_ENV]: imageDigest }),
    /Service cleanup source refused \(malformed\): value="main"/);
  // The retired variable is only a negative fixture here: a value left in it is not a cleanup
  // source, so the reader still refuses `unset`.
  assert.throws(() => readCleanupPair({ E2E_CLEANUP_SERVICE_SHA: serviceCommit, [CLEANUP_IMAGE_ENV]: imageDigest }),
    /Service cleanup source refused \(unset\)/);
});

test('verify proves the deployed commit against its release and reports where it read it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-cleanup-source-'));
  try {
    const summaryPath = join(directory, 'summary.md');
    let stdout = '';
    const code = await runCleanupSourceCli([
      'verify', '--operation', 'reconcile', '--service-url', serviceUrl,
    ], {
      environment: { ...readEnvironment, GITHUB_STEP_SUMMARY: summaryPath },
      api: apiFor(),
      fetcher: fetcherFor(health()),
      write: (text) => { stdout += text; },
    });
    assert.equal(code, 0);
    // The proved commit is the only stdout, so `$(...)` can carry it without a log line.
    assert.equal(stdout, `${serviceCommit}\n`);
    const summary = await readFile(summaryPath, 'utf8');
    assert.match(summary, /### Verified cleanup Service source/);
    assert.match(summary, new RegExp(`Commit: \`${serviceCommit}\` read from \`${serviceUrl}/health\``));
    assert.match(summary, new RegExp(`tag \`${tag}\`, ID \`10\`, target commit \`${serviceCommit}\``));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the CLI prints one confirmation line, no-ops an unpinned reconcile, and fails closed on a refusal', async () => {
  const run = (argv, environment = {}) => {
    let stdout = '';
    let stderr = '';
    return runCleanupSourceCli(argv, {
      environment: { [CLEANUP_SOURCE_ENV]: serviceCommit, [CLEANUP_IMAGE_ENV]: imageDigest, ...environment },
      api: apiFor(),
      fetcher: fetcherFor(health()),
      write: (text) => { stdout += text; },
      writeError: (text) => { stderr += text; },
    }).then((code) => ({ code, stdout, stderr }));
  };
  const equal = await run(['gate', '--operation', 'full', '--expected-service-commit', serviceCommit,
    '--expected-service-image-digest', imageDigest]);
  assert.equal(equal.code, 0);
  assert.equal(equal.stdout, `Cleanup Service source ${serviceCommit} and image ${imageDigest} match the pair preflight proved for operation full.\n`);
  assert.equal(equal.stderr, '');

  const unpinned = await run(['gate', '--operation', 'reconcile']);
  assert.equal(unpinned.code, 0);
  assert.match(unpinned.stdout, /No reviewed Service cleanup pair is pinned for operation reconcile; the derived pair binds the tuple this job read\./);

  const refused = await run(['gate', '--operation', 'full', '--expected-service-commit', otherCommit,
    '--expected-service-image-digest', imageDigest]);
  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /^Service cleanup source refused \(drift\): .*\n$/);
});

test('every refusal is one sentence over the closed vocabulary and the grammar that applied', async () => {
  const literal = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sourceShape = new RegExp(`^Service cleanup source refused \\((unset|malformed|absent|drift)\\): value=.+; operation=(?:full|smoke|reconcile|<unknown>); grammar=${literal(CLEANUP_SOURCE_GRAMMAR.source)}; .+$`);
  const imageShape = new RegExp(`^Service cleanup image refused \\((unset|malformed|absent|drift)\\): value=.+; operation=(?:full|smoke|reconcile|<unknown>); grammar=${literal(CLEANUP_IMAGE_GRAMMAR.source)}; .+$`);
  const cases = [
    [runVerify({ fetcher: fetcherFor(health({ service_commit: undefined })) }), sourceShape],
    [runVerify({ fetcher: fetcherFor(health({ service_commit: 'main' })) }), sourceShape],
    [runVerify({ api: apiFor({ fail: (path) => path === releasePath }) }), sourceShape],
    [runVerify({ api: apiFor({ refRecord: { object: { type: 'commit', sha: otherCommit } } }) }), sourceShape],
    [runVerify({ fetcher: fetcherFor(health({ image_digest: undefined })) }), imageShape],
    [runVerify({ fetcher: fetcherFor(health({ image_digest: 'latest' })) }), imageShape],
    [Promise.resolve().then(() => gate({ serviceCommit, imageDigest, expectedServiceCommit: otherCommit,
      expectedServiceImageDigest: imageDigest, operation: 'full' })), sourceShape],
    [Promise.resolve().then(() => gate({ serviceCommit, imageDigest, expectedServiceCommit: serviceCommit,
      expectedServiceImageDigest: otherDigest, operation: 'smoke' })), imageShape],
  ];
  for (const [promise, shape] of cases) {
    const error = await rejection(promise);
    assert.ok(error instanceof Error);
    assert.match(error.message, shape);
    assert.equal(error.message.split('\n').length, 1, `a refusal is one sentence: ${error.message}`);
  }
});

test('verify never reads a release asset and refuses a missing scoped token', async () => {
  const seen = [];
  const api = async (path) => {
    seen.push(path);
    return apiFor()(path);
  };
  await runVerify({ api });
  assert.deepEqual(seen, [releasePath, refPath]);
  const error = await rejection(verify({ serviceUrl, operation: 'reconcile', api: apiFor(), fetcher: fetcherFor(health()), environment: {} }));
  assert.match(error.message, /requires the scoped anywear-ai\/AnyWear-Service token/);
});
