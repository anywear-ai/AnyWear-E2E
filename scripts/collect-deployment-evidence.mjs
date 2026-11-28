import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertStableObservation, collectDeploymentEvidence } from './deployment-evidence.mjs';
import { parseStrictJson } from './evidence-contract.mjs';
import { assertE2EExecution } from './execution-guard.mjs';

// #358: one observation of the live deployed system for the gate. It reads the two live
// identities (Client `build-metadata.json`, Service `/health`) and states
// `authenticated: true`. It reads no compatibility file, no producer deployment record and
// no platform snapshot: the full-resource hash observation was removed with the
// qualification ledger, and the platform's stability across the suite is now carried by the
// two live identity re-reads. The workflow runs it once before the suite and once after it
// with `E2E_BASELINE_PATH` set to the first output, and the two observations must be
// identical.
assertE2EExecution();
const expected = {
  service_commit: process.env.EXPECTED_SERVICE_COMMIT || null,
  client_commit: process.env.EXPECTED_CLIENT_COMMIT || null,
};
const identity = await collectDeploymentEvidence({
  clientUrl: process.env.E2E_CLIENT_URL,
  serviceUrl: process.env.E2E_SERVICE_URL,
  runId: process.env.GITHUB_RUN_ID,
}, expected);
const observation = {
  collected_at: new Date().toISOString(),
  client: identity.client,
  service: identity.service,
  authenticated: true,
};

if (process.env.E2E_BASELINE_PATH) {
  const baselinePath = resolve(process.env.E2E_BASELINE_PATH);
  const baseline = parseStrictJson(await readFile(baselinePath));
  assertStableObservation(baseline, observation);
}

const inputsDirectory = resolve(process.env.E2E_INPUTS_DIR ?? '.e2e-inputs');
await mkdir(inputsDirectory, { recursive: true });
// The live identity the gate compared with its dispatch expectation, written once per read.
// The latest collect wins, and the after-observation and this file are the same read, so a
// reader cannot state a version its own observation contradicts.
const live = {
  client: { ...identity.client, client_version: identity.client_version },
  service: { ...identity.service, minimum_client_version: identity.minimum_client_version },
};
await writeFile(resolve(inputsDirectory, 'live-identity.json'), `${JSON.stringify(live, null, 2)}\n`);

const outputPath = resolve(process.env.E2E_EVIDENCE_PATH ?? 'deployment-evidence.json');
await writeFile(outputPath, `${JSON.stringify(observation, null, 2)}\n`);
const short = (value) => String(value).slice(0, 7);
console.log(`Observed the live tuple: Client ${short(observation.client.source_commit)} (version ${identity.client_version}), `
  + `Service ${short(observation.service.service_commit)} (${observation.service.image_digest.slice(0, 19)}...), `
  + `minimum Client ${identity.minimum_client_version}`);
