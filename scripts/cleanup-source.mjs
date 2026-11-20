import { pathToFileURL } from 'node:url';
import { appendFileSync } from 'node:fs';
import { parseStrictJson, requireHttpsUrl } from './evidence-contract.mjs';
import { readServiceRelease } from './service-release.mjs';
import { ghApi } from './github-read.mjs';

export const CLEANUP_SOURCE_ENV = 'E2E_CLEANUP_SERVICE_SOURCE_SHA';
export const CLEANUP_IMAGE_ENV = 'E2E_CLEANUP_SERVICE_IMAGE_DIGEST';

export const CLEANUP_SOURCE_GRAMMAR = /^[0-9a-f]{40}$/;
export const CLEANUP_IMAGE_GRAMMAR = /^sha256:[0-9a-f]{64}$/;

export const CLEANUP_SOURCE_REASONS = Object.freeze(['unset', 'malformed', 'absent', 'drift']);

/** The value a refusal shows in place of an absent one; it is a marker, never a JSON string. */
const ABSENT = '<absent>';

function shownValue(value) {
  return value === ABSENT || value === undefined || value === null || (typeof value === 'string' && value.length === 0)
    ? ABSENT
    : JSON.stringify(value);
}

export class CleanupSourceRefusal extends Error {
  constructor(reason, { value, operation, detail, cause } = {}) {
    if (!CLEANUP_SOURCE_REASONS.includes(reason)) throw new Error(`Unknown cleanup source refusal reason: ${reason}`);
    const op = operation ?? '<unknown>';
    super(`Service cleanup source refused (${reason}): value=${shownValue(value)}; operation=${op}; grammar=${CLEANUP_SOURCE_GRAMMAR.source}; ${detail}`, cause ? { cause } : {});
    this.name = 'CleanupSourceRefusal';
    this.code = 'E2E_CLEANUP_SOURCE_REFUSED';
    this.reason = reason;
    this.operation = op;
    this.grammar = CLEANUP_SOURCE_GRAMMAR.source;
    this.value = value;
  }
}

export class CleanupImageRefusal extends Error {
  constructor(reason, { value, operation, detail, cause } = {}) {
    if (!CLEANUP_SOURCE_REASONS.includes(reason)) throw new Error(`Unknown cleanup image refusal reason: ${reason}`);
    const op = operation ?? '<unknown>';
    super(`Service cleanup image refused (${reason}): value=${shownValue(value)}; operation=${op}; grammar=${CLEANUP_IMAGE_GRAMMAR.source}; ${detail}`, cause ? { cause } : {});
    this.name = 'CleanupImageRefusal';
    this.code = 'E2E_CLEANUP_IMAGE_REFUSED';
    this.reason = reason;
    this.operation = op;
    this.grammar = CLEANUP_IMAGE_GRAMMAR.source;
    this.value = value;
  }
}

export function readCleanupPair(environment) {
  const serviceCommit = environment[CLEANUP_SOURCE_ENV];
  const imageDigest = environment[CLEANUP_IMAGE_ENV];
  const operation = environment.E2E_OPERATION;

  if (!serviceCommit) throw new CleanupSourceRefusal('unset', { value: serviceCommit, operation, detail: `the environment variable ${CLEANUP_SOURCE_ENV} is unset` });
  if (!CLEANUP_SOURCE_GRAMMAR.test(serviceCommit)) throw new CleanupSourceRefusal('malformed', { value: serviceCommit, operation, detail: `the value is not a 40-hex commit` });

  if (!imageDigest) throw new CleanupImageRefusal('unset', { value: imageDigest, operation, detail: `the environment variable ${CLEANUP_IMAGE_ENV} is unset` });
  if (!CLEANUP_IMAGE_GRAMMAR.test(imageDigest)) throw new CleanupImageRefusal('malformed', { value: imageDigest, operation, detail: `the value is not a sha256 digest` });

  return { serviceCommit, imageDigest };
}

export async function verify({ serviceUrl, operation, api = ghApi, fetcher = fetch, environment = process.env }) {
  const normalizedUrl = requireHttpsUrl(serviceUrl, 'Service URL');
  let health;
  try {
    const response = await fetcher(new URL('/health', `${normalizedUrl}/`), {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Status ${response.status}`);
    health = parseStrictJson(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    throw new CleanupSourceRefusal('unset', { value: ABSENT, operation, detail: `${normalizedUrl}/health could not be read: ${error.message}` });
  }

  const { service_commit: serviceCommit, image_digest: imageDigest, status } = health;
  if (status !== 'ok') throw new CleanupSourceRefusal('unset', { value: ABSENT, operation, detail: `${normalizedUrl}/health reported status ${JSON.stringify(status)}, so the deployment names no Service commit` });
  if (!serviceCommit) throw new CleanupSourceRefusal('unset', { value: ABSENT, operation, detail: `${normalizedUrl}/health reported service_commit ${JSON.stringify(serviceCommit)}` });
  if (!CLEANUP_SOURCE_GRAMMAR.test(serviceCommit)) throw new CleanupSourceRefusal('malformed', { value: serviceCommit, operation, detail: `service_commit "${serviceCommit}" is malformed` });
  if (!imageDigest) throw new CleanupImageRefusal('unset', { value: ABSENT, operation, detail: `${normalizedUrl}/health did not return an image_digest` });
  if (!CLEANUP_IMAGE_GRAMMAR.test(imageDigest)) throw new CleanupImageRefusal('malformed', { value: imageDigest, operation, detail: `image_digest "${imageDigest}" is malformed` });

  let release;
  try {
    release = await readServiceRelease({ serviceSha: serviceCommit, api, environment });
  } catch (error) {
    const message = error.message;
    if (message.includes('no published release names the live Service commit')) {
      throw new CleanupSourceRefusal('absent', { value: serviceCommit, operation, detail: `no published immutable release names the deployed Service commit; looked for release tag service-artifacts-${serviceCommit} (${message.split('(')[1]?.split(')')[0] ?? message})` });
    }
    if (message.includes('tag resolves to') && message.includes('not the live Service commit')) {
      const observed = message.match(/resolves to (\S+),/)?.[1];
      throw new CleanupSourceRefusal('drift', { value: serviceCommit, operation, detail: `the release tag service-artifacts-${serviceCommit} resolves to ${observed} now, not the deployed Service commit ${serviceCommit}` });
    }
    throw error;
  }

  return { serviceUrl: normalizedUrl, operation, serviceCommit, imageDigest, release: release.identity };
}

export function gate({ serviceCommit, imageDigest, expectedServiceCommit, expectedServiceImageDigest, operation }) {
  // The rule keys on whether a pin exists, never on the operation name: `reconcile` runs inside
  // a qualification too, and there it inherits that run's pin and compares.
  if (!expectedServiceCommit && !expectedServiceImageDigest) {
    if (operation === 'reconcile') return { compared: false, operation };
    throw new CleanupSourceRefusal('unset', { value: ABSENT, operation, detail: `no reviewed pair was pinned for ${operation}; needs.preflight.outputs.reviewed_service_commit was empty` });
  }

  if (!serviceCommit) throw new CleanupSourceRefusal('unset', { value: serviceCommit, operation, detail: `the environment variable ${CLEANUP_SOURCE_ENV} is unset` });
  if (!CLEANUP_SOURCE_GRAMMAR.test(serviceCommit)) throw new CleanupSourceRefusal('malformed', { value: serviceCommit, operation, detail: `the value is not a 40-hex commit` });
  if (!imageDigest) throw new CleanupImageRefusal('unset', { value: imageDigest, operation, detail: `the environment variable ${CLEANUP_IMAGE_ENV} is unset` });
  if (!CLEANUP_IMAGE_GRAMMAR.test(imageDigest)) throw new CleanupImageRefusal('malformed', { value: imageDigest, operation, detail: `the value is not a sha256 digest` });

  if (!expectedServiceCommit) throw new CleanupSourceRefusal('unset', { value: ABSENT, operation, detail: `no reviewed Service commit is pinned for operation ${operation}; needs.preflight.outputs.reviewed_service_commit was empty` });
  if (!CLEANUP_SOURCE_GRAMMAR.test(expectedServiceCommit)) throw new CleanupSourceRefusal('malformed', { value: expectedServiceCommit, operation, detail: 'the pinned value from needs.preflight.outputs.reviewed_service_commit is not 40 lowercase hex' });

  if (!expectedServiceImageDigest) throw new CleanupImageRefusal('unset', { value: ABSENT, operation, detail: `no reviewed Service image digest is pinned for operation ${operation}; needs.preflight.outputs.reviewed_service_image_digest was empty` });
  if (!CLEANUP_IMAGE_GRAMMAR.test(expectedServiceImageDigest)) throw new CleanupImageRefusal('malformed', { value: expectedServiceImageDigest, operation, detail: 'the pinned value from needs.preflight.outputs.reviewed_service_image_digest is not a sha256:<hex> digest' });

  if (serviceCommit !== expectedServiceCommit) throw new CleanupSourceRefusal('drift', { value: expectedServiceCommit, operation, detail: `the deployment evidence for operation ${operation} observes "${serviceCommit}" (${CLEANUP_SOURCE_ENV}); the pinned value was read from needs.preflight.outputs.reviewed_service_commit` });
  if (imageDigest !== expectedServiceImageDigest) throw new CleanupImageRefusal('drift', { value: expectedServiceImageDigest, operation, detail: `the deployment evidence for operation ${operation} observes "${imageDigest}" (${CLEANUP_IMAGE_ENV}); the pinned value was read from needs.preflight.outputs.reviewed_service_image_digest` });

  return { compared: true, operation, serviceCommit, imageDigest };
}

export function appendVerificationSummary(result, environment = process.env) {
  const path = environment.GITHUB_STEP_SUMMARY;
  if (!path) return false;
  appendFileSync(path, [
    '### Verified cleanup Service source',
    '',
    `- Commit: \`${result.serviceCommit}\` read from \`${result.serviceUrl}/health\``,
    `- Release: tag \`${result.release.tag}\`, ID \`${result.release.release_id}\`, target commit \`${result.release.target_commit}\` read from \`repos/anywear-ai/AnyWear-Service/releases/tags/${result.release.tag}\``,
    '',
  ].join('\n'));
  return true;
}

export async function runCleanupSourceCli(argv, { environment = process.env, api = ghApi, fetcher = fetch, write = (t) => process.stdout.write(t), writeError = (t) => process.stderr.write(t) } = {}) {
  const [command, ...args] = argv;
  try {
    if (command === 'verify') {
      const opIndex = args.indexOf('--operation');
      const urlIndex = args.indexOf('--service-url');
      if (opIndex === -1 || urlIndex === -1 || opIndex + 1 >= args.length || urlIndex + 1 >= args.length) {
        throw new Error('Usage: node scripts/cleanup-source.mjs verify --operation <full|smoke|reconcile> --service-url <url>');
      }
      const operation = args[opIndex + 1];
      const serviceUrl = args[urlIndex + 1];
      const result = await verify({ serviceUrl, operation, api, fetcher, environment });
      appendVerificationSummary(result, environment);
      write(`${result.serviceCommit}\n`);
      return 0;
    }
    if (command === 'gate') {
      const opIndex = args.indexOf('--operation');
      const expectedCommitIndex = args.indexOf('--expected-service-commit');
      const expectedDigestIndex = args.indexOf('--expected-service-image-digest');
      if (opIndex === -1 || opIndex + 1 >= args.length) {
        throw new Error('Usage: node scripts/cleanup-source.mjs gate --operation <op> [--expected-service-commit <sha>] [--expected-service-image-digest <digest>]');
      }
      const operation = args[opIndex + 1];
      const expectedServiceCommit = expectedCommitIndex !== -1 ? args[expectedCommitIndex + 1] : undefined;
      const expectedServiceImageDigest = expectedDigestIndex !== -1 ? args[expectedDigestIndex + 1] : undefined;
      const { serviceCommit, imageDigest } = readCleanupPair(environment);
      const result = gate({ serviceCommit, imageDigest, expectedServiceCommit, expectedServiceImageDigest, operation });
      if (!result.compared) {
        write(`No reviewed Service cleanup pair is pinned for operation reconcile; the derived pair binds the tuple this job read.\n`);
      } else {
        write(`Cleanup Service source ${serviceCommit} and image ${imageDigest} match the pair preflight proved for operation ${operation}.\n`);
      }
      return 0;
    }
    throw new Error('Usage: node scripts/cleanup-source.mjs <verify|gate>');
  } catch (error) {
    writeError(`${error instanceof Error ? error.message : 'Cleanup source resolution failed'}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCleanupSourceCli(process.argv.slice(2));
}