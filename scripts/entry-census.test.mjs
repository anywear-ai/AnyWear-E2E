import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { repositoryRoot } from './test-selection.mjs';

// #163: the repository-side census of the entry face. The E2E deployable unit ends with two
// entries — one automatic check and one manual qualify — one manual dispatch surface and one
// activation switch, and the qualify chain keeps each AWS-credential job behind the
// credential-free preflight with a credential-free record job after it. These are source
// assertions so the next change cannot drift the entry face without failing `pnpm check`.

const directory = join(repositoryRoot, '.github', 'workflows');
// GitHub Actions accepts both workflow extensions. Enumerate both, so a `.yaml` entry
// cannot appear beside the tracked `.yml` files without changing the census.
const entries = readdirSync(directory).filter((name) => /\.ya?ml$/.test(name)).sort();
const read = (name) => readFileSync(join(directory, name), 'utf8');

// #259: the consumer-side drift gate (#228) is removed, together with the strict ZIP reader it
// alone used. Naming the deleted paths and tokens here is what makes the removal guarded: the
// assertions below fail if any of them comes back.
const REMOVED_DRIFT_PATHS = Object.freeze([
  'scripts/verify-smoke-drift.mjs',
  'scripts/verify-smoke-drift.test.mjs',
  'scripts/artifact-zip.mjs',
  'scripts/artifact-zip.test.mjs',
]);
const REMOVED_DRIFT_TOKENS = Object.freeze([
  'verify-smoke-drift',
  'smoke-drift',
  'SMOKE_DRIFT_BASELINE',
  'artifact-zip',
]);
// The nine files the remaining `full` steps produce. Both the handoff upload and the record
// attach list them, in this order; the removal takes the drift file out of both and changes
// nothing else, so a release consumer names the same surviving files.
const QUALIFICATION_EVIDENCE_PATHS = Object.freeze([
  '.qualification-inputs/live-identity.json',
  '.qualification-inputs/service-release.json',
  '.qualification-inputs/beta-environment-before.json',
  '.qualification-inputs/beta-environment-after.json',
  'deployment-evidence-before.json',
  'deployment-evidence.json',
  'qualification-record.json',
  'test-results/qualification-report.json',
  'test-results/beta-environment-verdict.json',
]);

function jobSection(workflow, name) {
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) return '';
  const rest = workflow.slice(start + marker.length);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return marker + (next < 0 ? rest : rest.slice(0, next));
}

const check = read('check.yml');
const qualify = read('beta-qualification.yml');
const schedule = read('reconcile-schedule.yml');
const job = (name) => jobSection(qualify, name);

function inputBlock(name) {
  const start = qualify.indexOf(`\n      ${name}:\n`);
  assert.ok(start >= 0, `${name} must be a workflow input`);
  const rest = qualify.slice(start + 1);
  const next = rest.search(/\n {6}[a-z_]+:\n/);
  return next < 0 ? rest : rest.slice(0, next);
}

// The `path: |` block of one uploaded artifact, as its entries in file order. A list is
// ordered and complete: an entry added, dropped or reordered fails the pin.
function uploadList(section, artifact) {
  const marker = `name: ${artifact}\n`;
  const start = section.indexOf(marker);
  assert.ok(start >= 0, `${artifact} must be an uploaded artifact`);
  const block = section.slice(start + marker.length);
  const pathStart = block.indexOf('path: |\n');
  assert.ok(pathStart >= 0, `${artifact} must declare its path list`);
  const list = [];
  for (const line of block.slice(pathStart + 'path: |\n'.length).split('\n')) {
    const entry = line.match(/^ {12}(\S.*)$/);
    if (!entry) break;
    list.push(entry[1]);
  }
  return list;
}

test('the deployable unit exposes exactly two entries: one automatic check and one manual qualify', () => {
  // #217 adds one dispatching entry: the daily account-reconcile schedule. It is not a
  // second dispatch surface — it commits no qualification action of its own, it only
  // dispatches `operation=reconcile` through the protected `qualify` entry.
  assert.deepEqual(entries, ['beta-qualification.yml', 'check.yml', 'reconcile-schedule.yml']);

  // The automatic entry absorbs quality and tool-regressions. `quality.yml` carried no path
  // filter, so the workflow-level union is unfiltered and tool-regressions now runs on every
  // check; the cost is recorded in the PR body for #163.
  assert.match(check, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n {4}branches: \[main\]\n/m);
  assert.doesNotMatch(check, /workflow_dispatch/);
  assert.doesNotMatch(check, /\bpaths:/);

  // The manual entry is the only dispatch surface, and it declares the operation menu.
  assert.equal([...qualify.matchAll(/^ {2}workflow_dispatch:$/gm)].length, 1);
  const operation = inputBlock('operation');
  assert.match(operation, /required: true/);
  assert.match(operation, /type: choice/);
  assert.match(operation, /options: \[full, smoke, reconcile\]/);
  // #217: the manual `recover` operation is removed. The menu is the allow-list a dispatch
  // reads, so the removed operation must be absent from it and no `recover` job may exist.
  assert.doesNotMatch(operation, /recover/, 'the operation menu must not offer the removed recover operation');
  assert.equal(job('recover'), '' , 'the qualify entry must not declare a recover job');
  // The retired measurement operation carried the only sizing stage input; nothing in the
  // entry may declare it again.
  assert.doesNotMatch(qualify, /sizing_stage/, 'the retired measurement operation carries no dispatch input');

  // #180: the live-tuple dispatch surface. The expectation is optional and only `full`
  // compares it; the trigger is a closed choice; the dispatching run URL is optional and
  // only accepted for a non-manual trigger.
  for (const name of ['expected_service_commit', 'expected_client_commit']) {
    const input = inputBlock(name);
    assert.match(input, /required: false/);
    assert.match(input, /type: string/);
  }
  const trigger = inputBlock('trigger');
  assert.match(trigger, /type: choice/);
  assert.match(trigger, /default: manual/);
  // #217: `scheduled` is the daily reconcile dispatch; it may only ask for reconcile.
  // #226: `deploy-qualify` is the deploy chain's qualification; it may only ask for full.
  assert.match(trigger, /options: \[manual, deploy-smoke, deploy-qualify, release-qualify, scheduled\]/);
  const dispatchedBy = inputBlock('dispatched_by');
  assert.match(dispatchedBy, /required: false/);
  assert.match(dispatchedBy, /type: string/);
  // The qualification entry reads no committed compatibility file and checks out no
  // producer source: the live tuple comes from the deployed endpoints and the platform
  // observation is this repository's own authenticated discovery of the live surface
  // (`scripts/infra-observation.mjs`), with no producer source and no committed name list.
  assert.doesNotMatch(qualify, /compatibility\.json/);
  assert.doesNotMatch(qualify, /check-compatibility\.mjs/);
  assert.doesNotMatch(qualify, /trusted-deployment-inputs\.mjs/);
  assert.doesNotMatch(qualify, /\.infra-source/);
  assert.match(qualify, /node scripts\/service-release\.mjs/);
  assert.match(qualify, /minimum-supported-client\.json/);
});

// #226: the receiver changes by one trigger value, one run name and one queue key. The
// single account-pool group keeps its non-cancelling property and now queues up to
// GitHub's maximum, and the run name carries the dispatch key the release chain and the
// dispatching hooks read back.
test('the qualify entry queues its account pool and names each run with the dispatch key', () => {
  assert.match(qualify, /^concurrency:\n {2}group: beta-e2e-account-pool\n {2}cancel-in-progress: false\n {2}queue: max$/m,
    'the single beta-e2e-account-pool group must stay non-cancelling and queue its runs');

  // The release chain finds the record of a Service commit by the run name, and the Infra
  // `qualify-hook` and the Client `handoff` read their own run URL back from it. A manual
  // dispatch renders `-` for a missing expected commit and `@actor` for a missing dispatcher.
  const runName = /^run-name: (.+)$/m.exec(qualify)?.[1] ?? '';
  assert.ok(runName.length > 0, 'the qualify entry must declare a run-name');
  assert.match(runName, /Beta qualification: /, 'the run name must name the qualification');
  for (const expression of [
    '${{ inputs.operation }}',
    '${{ inputs.trigger }}',
    "${{ inputs.expected_service_commit || '-' }}",
    "${{ inputs.dispatched_by || format('@{0}', github.actor) }}",
  ]) {
    assert.ok(runName.includes(expression), `the run name must render ${expression}`);
  }

  // The deploy chain's trigger is accepted only with its own payload: the full operation, a
  // supplied expected Service commit and worker slot offset 0 (the dispatching Infra run URL
  // is required by the non-manual rule). A smoke or slot-bearing dispatch is refused here,
  // before the reconcile job or the suite.
  const deployQualify = /^ {12}deploy-qualify\)\n([\s\S]*?)^ {14};;$/m.exec(qualify)?.[1] ?? '';
  assert.ok(deployQualify.length > 0, 'the preflight must validate the deploy-qualify trigger');
  assert.match(deployQualify, /trigger deploy-qualify requires operation full/);
  assert.match(deployQualify, /trigger deploy-qualify requires expected_service_commit/);
  assert.match(deployQualify, /trigger deploy-qualify requires worker_slot_offset 0/);
});

test('the qualify chain keeps one credential job per operation and a credential-free record', () => {
  const preflight = job('preflight');
  assert.ok(preflight.length > 0);
  assert.match(preflight, /permissions:\n {6}contents: read\n/);
  assert.doesNotMatch(preflight, /environment:|id-token|configure-aws-credentials/);
  assert.match(preflight, /node scripts\/execution-guard\.mjs --source-only/);
  // #180: the live tuple is verified in the credential-free preflight through the Service
  // App token, and the retired producer sources are gone.
  assert.match(preflight, /node scripts\/service-release\.mjs/);
  assert.match(preflight, /repositories: AnyWear-Service/);
  assert.doesNotMatch(preflight, /check-compatibility|trusted-deployment-inputs|\.infra-source|GH_TOKEN: \$\{\{ steps\.evidence-token/);

  for (const operation of ['full', 'smoke']) {
    const section = job(operation);
    assert.ok(section.length > 0, `the qualify entry must declare ${operation}`);
    assert.match(section, /needs: .*preflight/, `${operation} must need preflight`);
    assert.match(section, new RegExp(`if: github\\.ref == 'refs/heads/main' && needs\\.preflight\\.outputs\\.operation == '${operation}'`));
    assert.match(section, /environment: beta/);
    assert.match(section, /id-token: write/);
    assert.equal([...section.matchAll(/configure-aws-credentials/g)].length, 1, `${operation} has exactly one AWS credential step`);
    // #217: a step that can create or delete an identity must assume the qualification role
    // under the run-scoped session the reconcile attributes the creation through.
    assert.match(section, /role-session-name: e2e-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/, `${operation} must set the run-scoped credential session`);
  }

  // #217: the reconcile job is both its own operation and the job every qualification suite
  // waits for. It gates on the validated preflight output, never on the raw dispatch input,
  // and its bound is the 15 minutes the reviewed retention states.
  const reconcile = job('reconcile');
  assert.ok(reconcile.length > 0, 'the qualify entry must declare reconcile');
  assert.match(reconcile, /needs: preflight/);
  assert.match(reconcile, /if: github\.ref == 'refs\/heads\/main' && \(needs\.preflight\.outputs\.operation == 'reconcile' \|\| needs\.preflight\.outputs\.operation == 'full' \|\| needs\.preflight\.outputs\.operation == 'smoke'\)/);
  const reconcileIf = reconcile.match(/^ {4}if: (.+)$/m)?.[1] ?? '';
  assert.doesNotMatch(reconcileIf, /inputs\.operation/, 'reconcile must not gate its job on the raw dispatch input');
  assert.match(reconcile, /environment: beta/);
  assert.match(reconcile, /id-token: write/);
  assert.match(reconcile, /actions: read/, 'reconcile reads the recent lifecycle artifacts');
  // The ordinary bound is 15 minutes; the one 90-day migration dispatch is bounded to 30.
  assert.match(reconcile, /timeout-minutes: \$\{\{ inputs\.operation == 'reconcile' && inputs\.reconcile_lookback_days == '90' && 30 \|\| 15 \}\}/);
  assert.equal([...reconcile.matchAll(/configure-aws-credentials/g)].length, 1, 'reconcile has exactly one AWS credential step');
  assert.match(reconcile, /role-session-name: e2e-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/, 'reconcile must set the run-scoped credential session');
  // #217: the lookback is a closed dispatch input, 7 or 90, and only the reconcile operation
  // accepts the 90-day migration window. The job deadline follows the window it reads.
  assert.match(qualify, /reconcile_lookback_days:\n(?: {8}.*\n)*? {8}options: \['7', '90'\]/);
  assert.match(reconcile, /timeout-minutes: \$\{\{ inputs\.operation == 'reconcile' && inputs\.reconcile_lookback_days == '90' && 30 \|\| 15 \}\}/);
  assert.match(reconcile, /E2E_ACCOUNT_RECONCILE_LOOKBACK_DAYS: \$\{\{ inputs\.reconcile_lookback_days \}\}/);
  assert.match(reconcile, /E2E_ACCOUNT_RECONCILE_DEADLINE_SECONDS: \$\{\{ inputs\.reconcile_lookback_days == '90' && '1500' \|\| '720' \}\}/);
  assert.match(preflight, /RECONCILE_LOOKBACK_DAYS: \$\{\{ inputs\.reconcile_lookback_days \}\}/);
  assert.match(preflight, /7\|90\) ;;/);
  assert.match(preflight, /reconcile_lookback_days is only accepted by operation reconcile/);
  assert.match(reconcile, /node scripts\/reconcile-accounts\.mjs/);
  // Every qualification suite runs after the reconcile job, so a run starts from a
  // reconciled environment and cannot report a clean one it did not verify.
  for (const operation of ['full', 'smoke']) {
    assert.match(job(operation), /needs: \[preflight, reconcile\]/, `${operation} must run after reconcile`);
  }

  // The record job holds no credential and runs only for full. Only full may produce the
  // record; the record job validates and attaches it and is the last qualification job. The
  // attached tuple is the live identity and the verified release, not a producer deployment
  // record.
  const record = job('record');
  assert.ok(record.length > 0);
  assert.match(record, /needs: \[preflight, full\]/);
  assert.match(record, /if: github\.ref == 'refs\/heads\/main' && needs\.preflight\.outputs\.operation == 'full'/);
  // #259: the drift gate is removed, so the credential-free `record` job needs no Actions read
  // scope; `contents: read` is its whole permission block.
  assert.match(record, /permissions:\n {6}contents: read\n\n {4}steps:/);
  assert.doesNotMatch(record, /environment:|id-token|configure-aws-credentials/);
  assert.match(job('full'), /qualification:generate/);

  // The release decision is the green `full` run plus the sealed record: there is no human
  // approval job and no approval Environment. The dispatch event (actor and time), the run
  // and the record tuple are the audit trail.
  assert.equal(job('approve'), '', 'the qualify entry must not declare an approval job');
  assert.match(qualify, /dispatched_by/);
  assert.doesNotMatch(qualify, /beta-release-approval/);
  assert.doesNotMatch(qualify, /AwaitingApproval|Approved|Rejected/);
  for (const name of ['preflight', 'smoke', 'reconcile', 'record']) {
    assert.doesNotMatch(job(name), /qualification:generate/, `${name} must not produce the qualification record`);
  }
  // `record` is the last job in the workflow.
  assert.ok(qualify.trimEnd().endsWith('if-no-files-found: error'), 'record must be the last qualification job');
});

test('the consumer-side drift gate is removed and both upload lists keep their nine files', () => {
  // #259: the drift gate (#228) is deleted. `full` no longer consults another run's revision
  // artifact, and the credential-free `record` job re-verifies nothing but the record. The
  // deleted paths and tokens must not return; the pins below keep what the deletion had to
  // leave standing.
  const full = job('full');
  const record = job('record');

  // Both jobs keep only the scopes a remaining step uses. `full`'s block was byte-identical to
  // `reconcile`'s before this change, so anchor on the key that follows it.
  assert.match(full, /permissions:\n {6}contents: read\n {6}id-token: write\n {4}env:/);
  assert.match(record, /permissions:\n {6}contents: read\n\n {4}steps:/);
  // Exactly one Actions read scope remains: `reconcile`'s own lifecycle lookback lists other
  // runs' artifacts, and no other job does.
  assert.equal([...qualify.matchAll(/^ {6}actions: read$/gm)].length, 1, 'only reconcile may hold actions: read');
  assert.match(job('reconcile'), /permissions:\n {6}actions: read\n {6}contents: read\n {6}id-token: write\n/);
  // Neither job may authenticate to the Actions API: the removed drift steps held the only
  // `secrets.GITHUB_TOKEN` uses in either.
  for (const [name, section] of [['full', full], ['record', record]]) {
    assert.doesNotMatch(section, /secrets\.GITHUB_TOKEN/, `${name} must hold no Actions API credential`);
  }

  // `full` runs its own before-observation, the release-gating suite and the after-observation,
  // in that order, and nothing compares another run's evidence in between.
  const beforeObservation = full.indexOf('Observe authenticated deployed tuple before suite');
  const suite = full.indexOf('Run the release-gating business regression suite');
  const afterObservation = full.indexOf('Capture Beta worker identity after the suite');
  assert.ok(beforeObservation >= 0 && suite > beforeObservation && afterObservation > suite,
    'full must observe the tuple, run the suite and re-observe it, in that order');

  // The gate's modules and identifiers are gone; none may return to the workflow.
  for (const path of REMOVED_DRIFT_PATHS) {
    assert.equal(existsSync(join(repositoryRoot, path)), false, `${path} must not be restored: the drift gate is removed (#259)`);
  }
  for (const token of REMOVED_DRIFT_TOKENS) {
    assert.equal(qualify.includes(token), false, `the qualify entry must not name the removed drift-gate token ${token}`);
  }

  // `full` hands off and `record` attaches exactly the nine files the remaining steps produce,
  // in order: the deletion removes one path from each list and nothing else.
  assert.deepEqual(uploadList(full, 'beta-qualification-handoff-${{ github.run_id }}-${{ github.run_attempt }}'), QUALIFICATION_EVIDENCE_PATHS);
  assert.deepEqual(uploadList(record, 'beta-qualification-${{ github.run_id }}-${{ github.run_attempt }}'), QUALIFICATION_EVIDENCE_PATHS);

  // The `smoke` diagnostic keeps its own evidence: the authenticated observation and its
  // revision upload, which no machine reads any more, and no record.
  const smoke = job('smoke');
  assert.match(smoke, /name: tested-revisions-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(smoke, /pnpm qualification:collect/);
  for (const name of ['preflight', 'smoke', 'reconcile']) {
    assert.doesNotMatch(job(name), /verify-smoke-drift/, `${name} must never run the removed drift gate`);
  }

  // No workflow may reference the deleted vendored contract.
  for (const [name, source] of [['beta-qualification.yml', qualify], ['check.yml', check]]) {
    assert.doesNotMatch(source, /vendor/, `${name} must not reference the deleted vendored contract`);
  }
});

test('no qualification job downloads a producer deployment record or checks out producer source', () => {
  for (const name of ['preflight', 'reconcile', 'full', 'smoke', 'record']) {
    const section = job(name);
    assert.doesNotMatch(section, /platform-deployment-record\.json/, `${name} must not retain the retired platform record`);
    assert.doesNotMatch(section, /\.qualification-inputs\/deployment-record\.json/, `${name} must not retain the retired workload record`);
    assert.doesNotMatch(section, /repository: anywear-ai\/AnyWear-Infra/, `${name} must not check out the Infra observer`);
  }
  // The full job records and retains the two files the v4 record is built from: the live
  // tuple and the Service release identity (#193 renamed the identity input and removed
  // the manifest bytes from the path).
  for (const name of ['full', 'record']) {
    const section = job(name);
    assert.match(section, /\.qualification-inputs\/live-identity\.json/);
    assert.match(section, /\.qualification-inputs\/service-release\.json/);
    assert.doesNotMatch(section, /service-artifacts\.json/);
  }
  assert.doesNotMatch(qualify, /service-artifacts\.json/);
  assert.doesNotMatch(qualify, /manifest_asset_id|manifest_sha256/);
});

test('the only activation switch in this repository is ENABLE_BETA_MUTATION', () => {
  const names = new Set([...qualify.matchAll(/\bENABLE_[A-Z0-9_]+\b/g)].map((match) => match[0]));
  assert.deepEqual([...names], ['ENABLE_BETA_MUTATION']);
  assert.doesNotMatch(check, /\bENABLE_[A-Z0-9_]+\b/);
  assert.doesNotMatch(schedule, /\bENABLE_[A-Z0-9_]+\b/);
  const guard = readFileSync(join(repositoryRoot, 'scripts', 'execution-guard.mjs'), 'utf8');
  assert.match(guard, /environment\.ENABLE_BETA_MUTATION/);
  assert.doesNotMatch(guard, /ENABLE_INFRA_E2E/);
});

test('the daily reconcile schedule dispatches the protected operation and holds no credential', () => {
  // #163/#217: the schedule cannot be a `schedule` event on the qualify entry, because the
  // execution guard requires `workflow_dispatch`. It is a dispatching entry only.
  const triggerBlock = schedule.slice(schedule.indexOf('\non:') + 1, schedule.indexOf('\npermissions:'));
  assert.match(triggerBlock, /^on:\n {2}schedule:\n(?: {4}#[^\n]*\n)* {4}- cron: '[^']+'\n$/);
  assert.doesNotMatch(triggerBlock, /push:|pull_request:|workflow_dispatch:/,
    'the schedule declares no second dispatch surface and no branch trigger');

  // It dispatches exactly the protected entry with the reconcile operation and the
  // `scheduled` trigger, naming the dispatching run as evidence.
  assert.match(schedule, /gh workflow run beta-qualification\.yml/);
  assert.match(schedule, /--repo "\$GITHUB_REPOSITORY"/);
  assert.match(schedule, /--ref main/);
  assert.match(schedule, /-f operation=reconcile/);
  assert.match(schedule, /-f trigger=scheduled/);
  assert.match(schedule, /-f dispatched_by="\$DISPATCHED_BY"/);
  assert.match(schedule, /DISPATCHED_BY: \$\{\{ github\.server_url \}\}\/\$\{\{ github\.repository \}\}\/actions\/runs\/\$\{\{ github\.run_id \}\}/);

  // The dispatching job needs Actions write, no AWS credential and no environment: it
  // resolves no environment-scoped value and never enters the Beta environment.
  const dispatch = jobSection(schedule, 'dispatch');
  assert.ok(dispatch.length > 0, 'the schedule must declare its dispatch job');
  assert.match(dispatch, /permissions:\n(?: {6}#[^\n]*\n)* {6}actions: write\n {6}contents: read\n/);
  assert.doesNotMatch(dispatch, /configure-aws-credentials|id-token|environment: beta/);
  assert.match(dispatch, /timeout-minutes: 5/);
  assert.match(dispatch, /if: github\.ref == 'refs\/heads\/main'/);
});
