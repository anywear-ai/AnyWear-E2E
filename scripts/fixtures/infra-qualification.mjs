import { environmentVerdict } from '../qualification-environment.mjs';
import { SERVICE_RELEASE_ASSET_NAMES } from '../qualification-record.mjs';
import { readMinimumSupportedClient } from '../minimum-supported-client.mjs';
import { SCENARIO_DIRECTORY, qualificationSelection, selectedScenarios } from '../test-selection.mjs';
import { contentHash, repositories } from '../evidence-contract.mjs';

// A v4 qualification fixture. Every member of the record is built from the same
// derivation the live path uses, so the fixture cannot state a shape the producer would
// not write:
//
// - the platform rows are the discovery-shaped surface the observation records
//   (`stacks[]` over the discovered stack set, `inputs[]` over the published stage
//   prefix, the `lambdas[]`/`queues[]` arrays, `schema_sha256` re-derived with the
//   repository's own hasher). The names below are fixture data only — the observation
//   discovers its rows live and no committed name list remains (#228);
// - the Client version and the Service floor come from the committed
//   `minimum-supported-client.json`, with the deployed Client one version above the
//   floor;
// - the Service release identity is the tag's target commit plus the four released
//   assets with their published size and digest;
// - the observations bracket the environment verdict the suite would have produced.
//
// Nothing here reads AWS, the filesystem (beyond the committed floor), or a clock.
function qualificationReport() {
  const { tag } = qualificationSelection();
  const suites = selectedScenarios(tag).map(({ file, title, declaresRuntimeSkip }) => ({
    title: file.slice(SCENARIO_DIRECTORY.length),
    file,
    line: 0,
    column: 0,
    specs: [],
    suites: [{
      title,
      file,
      line: 1,
      column: 1,
      specs: [{
        title: `${title} acceptance`,
        ok: true,
        tags: [],
        tests: [{
          timeout: 30_000,
          annotations: declaresRuntimeSkip ? [{ type: 'skip', description: 'declared runtime skip' }] : [],
          expectedStatus: declaresRuntimeSkip ? 'skipped' : 'passed',
          projectId: 'chromium',
          projectName: 'chromium',
          results: [],
          status: declaresRuntimeSkip ? 'skipped' : 'expected',
        }],
        id: `fixture-${file}`,
        file,
        line: 1,
        column: 1,
      }],
    }],
  }));
  return Buffer.from(`${JSON.stringify({ config: { rootDir: SCENARIO_DIRECTORY.slice(0, -1) }, suites, errors: [], stats: {} }, null, 2)}\n`);
}

// The discovery-shaped platform rows, exactly as the observation sorts them. The
// parameter rows keep the pre-change fixture content and versions, so the compatibility
// test can pin `schema_sha256` to the byte-identical pre-change value.
const stackRows = () => [
  { name: 'AnyWearBillingStack-beta', region: 'us-east-1', template_sha256: 'd'.repeat(64) },
  { name: 'AnyWearFoundationStack', region: 'ap-east-1', template_sha256: 'd'.repeat(64) },
  { name: 'AnyWearPlatformStack-beta', region: 'ap-east-1', template_sha256: 'd'.repeat(64) },
];
const parameterRows = () => [
  { parameter: '/anywear/beta/api_base_url', version: '1', value_sha256: '0'.repeat(64) },
  { parameter: '/anywear/beta/api_security_group_id', version: '2', value_sha256: '1'.repeat(64) },
  { parameter: '/anywear/beta/auto_tagging_dlq_name', version: '3', value_sha256: '2'.repeat(64) },
];
const lambdaRows = () => [
  { name: 'beta-anywear-post-confirmation-sync', code_sha256: Buffer.from('b'.repeat(64), 'hex').toString('base64'), configuration_sha256: 'e'.repeat(64) },
  { name: 'beta-anywear-pre-sign-up', code_sha256: Buffer.from('e'.repeat(64), 'hex').toString('base64'), configuration_sha256: 'f'.repeat(64) },
];
const queueRows = () => [
  { name: 'beta-anywear-auto-tagging', queueVisibilitySeconds: 900, maxReceives: 3 },
  { name: 'beta-anywear-auto-tagging-dlq', queueVisibilitySeconds: 900, maxReceives: null },
  { name: 'beta-anywear-vto', queueVisibilitySeconds: 900, maxReceives: 3 },
  { name: 'beta-anywear-vto-dlq', queueVisibilitySeconds: 900, maxReceives: null },
];

// One observation: the two live identities, this repository's own platform snapshot, and
// the literal `authenticated: true` assertion that it was taken with the Beta principal.
function observation({ collectedAt, clientSha, serviceSha, image, clientDomain }) {
  const inputs = parameterRows();
  return {
    collected_at: collectedAt,
    client: { url: `https://${clientDomain}`, source_commit: clientSha, built_at: '2026-10-07T00:00:00.000Z' },
    service: { url: 'https://api123.cloudfront.net', service_commit: serviceSha, image_digest: image },
    platform: {
      stacks: stackRows(),
      inputs,
      schema_sha256: contentHash(inputs.map(({ parameter, version }) => ({ parameter, version }))),
      lambdas: lambdaRows(),
      queues: queueRows(),
      client_domain: clientDomain,
    },
    authenticated: true,
  };
}

export function qualificationFixture({
  expectedSource = 'trigger',
  trigger = 'manual',
  dispatchedBy = null,
} = {}) {
  const sha = (letter) => letter.repeat(40);
  const hash = (letter) => letter.repeat(64);
  const floor = readMinimumSupportedClient();
  const clientSha = sha('a');
  const serviceSha = sha('b');
  const image = `sha256:${hash('c')}`;
  const clientDomain = 'client123.cloudfront.net';
  const clientVersion = floor.version + 1;
  const minimumClientVersion = floor.version;
  const before = observation({ collectedAt: '2026-10-08T00:00:00.000Z', clientSha, serviceSha, image, clientDomain });
  const after = observation({ collectedAt: '2026-10-08T00:10:00.000Z', clientSha, serviceSha, image, clientDomain });
  const live = {
    client: { ...before.client, client_version: clientVersion },
    service: { ...before.service, minimum_client_version: minimumClientVersion },
  };
  // #193: the v4 record states the release's own identity — the tag's target commit and
  // exactly the four released assets with their published size and digest. The fixture
  // derives the asset names from the frozen constant so it cannot drift from the gate.
  const serviceArtifacts = {
    repository: repositories.service,
    release_id: 10,
    tag: `service-artifacts-${serviceSha}`,
    target_commit: serviceSha,
    assets: Object.fromEntries(SERVICE_RELEASE_ASSET_NAMES.map((name, index) => [name, {
      size: 2048 + index,
      digest: `sha256:${hash(String(index + 1))}`,
    }])),
  };
  const input = {
    result: 'passed',
    operation: 'full',
    e2eSha: sha('d'),
    repository: repositories.e2e,
    runId: '123',
    runAttempt: '1',
    serverUrl: 'https://github.com',
    awsAccountId: '650880818323',
    awsRegion: 'ap-east-1',
    workflowPath: '.github/workflows/beta-qualification.yml',
    workflowRef: `${repositories.e2e}/.github/workflows/beta-qualification.yml@refs/heads/main`,
    trigger,
    dispatchedBy,
  };
  const expected = expectedSource === 'live'
    ? { service_commit: null, client_commit: null, source: 'live' }
    : { service_commit: serviceSha, client_commit: clientSha, source: 'trigger' };
  // The environment gate every passing record must state. The comparison input is the
  // unchanged window `compareWorkerIdentity` reports when one worker task definition
  // serves both ends of the suite; the record itself is produced by `environmentVerdict`,
  // which owns the verdict key set, so this fixture cannot drift from that shape.
  const environment = {
    record: environmentVerdict({
      comparison: {
        verdict: 'unchanged',
        reason: 'The worker task set and the worker task definition are unchanged across the suite window',
        before_observed_at: before.collected_at,
        after_observed_at: after.collected_at,
        before_identity_sha256: hash('a'),
        after_identity_sha256: hash('a'),
        before_task_arns: [],
        after_task_arns: [],
        added_task_arns: [],
        removed_task_arns: [],
        task_definition_changed: false,
      },
      suiteOutcome: 'success',
    }),
    problem: null,
  };
  return {
    floor,
    clientSha,
    serviceSha,
    image,
    clientDomain,
    clientVersion,
    minimumClientVersion,
    input,
    expected,
    evidence: { before, after, service_artifacts: serviceArtifacts, live },
    environment,
    report: qualificationReport(),
  };
}
