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
// #358: the qualification ledger is removed. `record-reader-census.test.mjs` is the token-level
// tombstone for a reintroduced producer; this census is the workflow-level one. Naming the job
// and the artifacts here is what makes the removal guarded in the entry itself.
const REMOVED_LEDGER_JOB = 'record';
const REMOVED_LEDGER_ARTIFACTS = Object.freeze([
  // `beta-qualification-<run>-<attempt>`, attached by the deleted `record` job.
  'beta-qualification-${{',
  // The `full` job's handoff to the deleted `record` job.
  'beta-qualification-handoff-',
  // The renamed diagnostics artifact; the old name must not come back.
  'beta-qualification-diagnostics-',
]);
const REMOVED_LEDGER_TOKENS = Object.freeze([
  'qualification-record.json',
  'verifyQualificationForPromotion',
  'create-qualification-record',
  'verify-qualification-record',
  // The validation lane the ledger owned; the gate's verdict is the run's own conclusion.
  'qualification:generate',
  'qualification:verify',
]);
// The gate diagnostics artifact and the report path the run keeps for a reader. #358 renamed
// both: the ledger's `beta-qualification-diagnostics-*` and `test-results/qualification-report
// .json` no longer exist.
const GATE_DIAGNOSTICS = 'beta-e2e-diagnostics-${{ github.run_id }}-${{ github.run_attempt }}';
const GATE_REPORT_PATH = 'test-results/beta-e2e-report.json';
// The retired workflow file name. #358 renames the entry to `beta-e2e.yml` and leaves this file
// as a refusal stub until AnyWear-Infra's dispatch rename has merged; this issue's step 5
// deletes it. It must never carry a job that does work.
const RETIRED_STUB = 'beta-qualification.yml';

function jobSection(workflow, name) {
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) return '';
  const rest = workflow.slice(start + marker.length);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return marker + (next < 0 ? rest : rest.slice(0, next));
}

const check = read('check.yml');
const qualify = read('beta-e2e.yml');
const stub = read(RETIRED_STUB);
const job = (name) => jobSection(qualify, name);

// #344: the daily reconcile dispatch moved into `AnyWear-Infra`'s scheduled entry, so this
// repository's own schedule file is deleted. Naming the deleted file and its token here is
// what makes the removal guarded: the assertions below fail if either comes back.
const REMOVED_SCHEDULE_ENTRY = 'reconcile-schedule.yml';
const REMOVED_SCHEDULE_TOKENS = Object.freeze(['reconcile-schedule']);
const CENSUS = 'scripts/entry-census.test.mjs';

// #344: the admission gate as the workflow states it — a disjunction of
// `inputs.trigger == '<value>'` clauses. Reading it as a set lets a test ask which dispatch
// triggers reach the read, rather than only pinning the expression as a string.
function admittedTriggers(expression) {
  const triggers = new Set();
  for (const clause of expression.split('||').map((part) => part.trim())) {
    const match = /^inputs\.trigger == '([a-z-]+)'$/.exec(clause);
    assert.ok(match, `the admission gate clause ${JSON.stringify(clause)} must compare inputs.trigger`);
    triggers.add(match[1]);
  }
  return triggers;
}

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

test('the deployable unit exposes exactly two entries: one automatic check and one manual gate', () => {
  // #344: the daily account-reconcile dispatch is `AnyWear-Infra`'s scheduled entry now, so
  // this repository has two entries: the automatic check and the manual gate. #358 renames the
  // manual entry to `beta-e2e.yml` and leaves the retired name as a refusal stub, which is not
  // an entry: it declares no job that does work. A third real workflow file cannot appear
  // without failing this census.
  assert.deepEqual(entries, ['beta-e2e.yml', RETIRED_STUB, 'check.yml']);

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
  assert.equal(job('recover'), '' , 'the gate entry must not declare a recover job');
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
  // #217/#344: `scheduled` is the daily reconcile dispatch from `AnyWear-Infra`'s scheduled
  // entry; it may only ask for the reconcile operation.
  // #226: `deploy-gate` is the deploy chain's gate; it may only ask for full.
  // #358: the canonical set is the gate wording. `deploy-qualify` and `release-qualify` are the
  // two retired values, accepted only until AnyWear-Infra's step 4 merges and dispatches the new
  // ones. This issue's step 5 deletes them from here and from the preflight validator.
  assert.match(trigger, /options: \[manual, deploy-smoke, deploy-gate, release-gate, scheduled, deploy-qualify, release-qualify\]/);
  const dispatchedBy = inputBlock('dispatched_by');
  assert.match(dispatchedBy, /required: false/);
  assert.match(dispatchedBy, /type: string/);
  // The gate entry reads no committed compatibility file and checks out no producer source:
  // the live tuple comes from the deployed endpoints. #358 removed the repository's own
  // full-resource platform observation with the ledger, so the entry names no snapshot script.
  assert.doesNotMatch(qualify, /compatibility\.json/);
  assert.doesNotMatch(qualify, /check-compatibility\.mjs/);
  assert.doesNotMatch(qualify, /trusted-deployment-inputs\.mjs/);
  assert.doesNotMatch(qualify, /\.infra-source/);
  assert.doesNotMatch(qualify, /infra-observation\.mjs/);
  assert.match(qualify, /node scripts\/service-release\.mjs/);
  assert.match(qualify, /minimum-supported-client\.json/);
});

// #226: the receiver changes by one trigger value, one run name and one queue key. The
// single account-pool group keeps its non-cancelling property and now queues up to
// GitHub's maximum, and the run name carries the dispatch key the dispatching hooks read back.
test('the gate entry queues its account pool and names each run with the dispatch key', () => {
  assert.match(qualify, /^concurrency:\n {2}group: beta-e2e-account-pool\n {2}cancel-in-progress: false\n {2}queue: max$/m,
    'the single beta-e2e-account-pool group must stay non-cancelling and queue its runs');

  // #358: the run name is the cross-repository read contract. `AnyWear-Infra`'s
  // `e2e-admission.mjs` filters the repository run list by the `Beta E2E gate: full` prefix, so
  // the prefix, the ` · ` separators and the four segments are pinned here. A manual dispatch
  // renders `-` for a missing expected commit and `@actor` for a missing dispatcher.
  const runName = /^run-name: (.+)$/m.exec(qualify)?.[1] ?? '';
  assert.ok(runName.length > 0, 'the gate entry must declare a run-name');
  assert.match(runName, /^"Beta E2E gate: /, 'the run name must carry the gate run-name prefix');
  for (const expression of [
    '${{ inputs.operation }}',
    '${{ inputs.trigger }}',
    "${{ inputs.expected_service_commit || '-' }}",
    "${{ inputs.dispatched_by || format('@{0}', github.actor) }}",
  ]) {
    assert.ok(runName.includes(expression), `the run name must render ${expression}`);
  }
  assert.equal(runName.split(' · ').length, 4, 'the run name must keep exactly four ` · ` separated segments');

  // The deploy chain's trigger is accepted only with its own payload: the full operation, a
  // supplied expected Service commit and worker slot offset 0 (the dispatching Infra run URL
  // is required by the non-manual rule). A smoke or slot-bearing dispatch is refused here,
  // before the reconcile job or the suite. #358 adds the gate spelling beside the retired one.
  const deployGate = /^ {12}deploy-gate\|deploy-qualify\)\n([\s\S]*?)^ {14};;$/m.exec(qualify)?.[1] ?? '';
  assert.ok(deployGate.length > 0, 'the preflight must validate the deploy-gate trigger');
  assert.match(deployGate, /trigger \$TRIGGER requires operation full/);
  assert.match(deployGate, /trigger \$TRIGGER requires expected_service_commit/);
  assert.match(deployGate, /trigger \$TRIGGER requires worker_slot_offset 0/);
  // The human re-gate accepts the same retired spelling on the same terms.
  const releaseGate = /^ {12}release-gate\|release-qualify\)\n([\s\S]*?)^ {14};;$/m.exec(qualify)?.[1] ?? '';
  assert.ok(releaseGate.length > 0, 'the preflight must validate the release-gate trigger');
  assert.match(releaseGate, /trigger \$TRIGGER requires operation full/);
  assert.match(releaseGate, /trigger \$TRIGGER requires expected_service_commit/);
});

test('the gate chain keeps one credential job per operation and no ledger job', () => {
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
    assert.ok(section.length > 0, `the gate entry must declare ${operation}`);
    assert.match(section, /needs: .*preflight/, `${operation} must need preflight`);
    assert.match(section, new RegExp(`if: github\\.ref == 'refs/heads/main' && needs\\.preflight\\.outputs\\.operation == '${operation}'`));
    assert.match(section, /environment: beta/);
    assert.match(section, /id-token: write/);
    assert.equal([...section.matchAll(/configure-aws-credentials/g)].length, 1, `${operation} has exactly one AWS credential step`);
    // #217: a step that can create or delete an identity must assume the qualification role
    // under the run-scoped session the reconcile attributes the creation through.
    assert.match(section, /role-session-name: e2e-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/, `${operation} must set the run-scoped credential session`);
  }

  // #217: the reconcile job is both its own operation and the job every gate suite waits for.
  // It gates on the validated preflight output, never on the raw dispatch input, and its bound
  // is the 15 minutes the reviewed retention states.
  const reconcile = job('reconcile');
  assert.ok(reconcile.length > 0, 'the gate entry must declare reconcile');
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
  // Every gate suite runs after the reconcile job, so a run starts from a reconciled
  // environment and cannot report a clean one it did not verify.
  for (const operation of ['full', 'smoke']) {
    assert.match(job(operation), /needs: \[preflight, reconcile\]/, `${operation} must run after reconcile`);
  }

  // #358: the credential-free `record` job is gone with the qualification ledger. The gate's
  // verdict is the run's own conclusion, so no job validates, attaches or reproduces a record.
  assert.equal(job(REMOVED_LEDGER_JOB), '', 'the gate entry must declare no record job');
  assert.doesNotMatch(qualify, /verify-qualification-record\.mjs/);
  for (const [name, section] of ['preflight', 'reconcile', 'full', 'smoke'].map((name) => [name, job(name)])) {
    assert.doesNotMatch(section, /qualification:generate|qualification:verify/, `${name} must not produce or verify a ledger`);
  }

  // The release decision is the green `full` run: there is no human approval job and no
  // approval Environment. The dispatch event (actor and time) and the run object are the audit
  // trail.
  assert.equal(job('approve'), '', 'the gate entry must not declare an approval job');
  assert.match(qualify, /dispatched_by/);
  assert.doesNotMatch(qualify, /beta-release-approval/);
  assert.doesNotMatch(qualify, /AwaitingApproval|Approved|Rejected/);
  // The workflow's last job is `smoke`, which uploads the failure screenshots every operation
  // keeps. No job follows it, and none reads another job's ledger.
  assert.ok(qualify.trimEnd().endsWith('if-no-files-found: ignore'), 'smoke must be the last gate job');
});

test('the consumer-side drift gate and the qualification ledger are removed from the entry', () => {
  // #259: the drift gate (#228) is deleted, so `full` no longer consults another run's revision
  // artifact. #358: the qualification ledger is deleted too, so no job validates or attaches a
  // record. The deleted paths, jobs and artifacts must not return; the pins below keep what the
  // deletions had to leave standing.
  const full = job('full');

  // `full` keeps only the scopes a remaining step uses.
  assert.match(full, /permissions:\n {6}contents: read\n {6}id-token: write\n {4}env:/);
  // Exactly one Actions read scope remains: `reconcile`'s own lifecycle lookback lists other
  // runs' artifacts, and no other job does.
  assert.equal([...qualify.matchAll(/^ {6}actions: read$/gm)].length, 1, 'only reconcile may hold actions: read');
  assert.match(job('reconcile'), /permissions:\n {6}actions: read\n {6}contents: read\n {6}id-token: write\n/);
  // No gate job may authenticate to the Actions API: the removed drift steps held the only
  // `secrets.GITHUB_TOKEN` uses outside `reconcile`, whose lifecycle lookback needs it.
  for (const name of ['preflight', 'full', 'smoke']) {
    assert.doesNotMatch(job(name), /secrets\.GITHUB_TOKEN/, `${name} must hold no Actions API credential`);
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
    assert.equal(qualify.includes(token), false, `the gate entry must not name the removed drift-gate token ${token}`);
  }

  // #358: no ledger artifact and no ledger program may reappear in the entry. The diagnostics
  // artifact keeps its own files under the gate name; the report path is the gate report.
  for (const token of REMOVED_LEDGER_ARTIFACTS) {
    assert.equal(qualify.includes(token), false, `the gate entry must not name the removed ledger artifact ${token}`);
  }
  for (const token of REMOVED_LEDGER_TOKENS) {
    assert.equal(qualify.includes(token), false, `the gate entry must not name the removed ledger token ${token}`);
  }
  assert.equal(job(REMOVED_LEDGER_JOB), '', 'the gate entry must declare no record job');
  assert.doesNotMatch(qualify, /qualification-record\.json/);
  assert.deepEqual(uploadList(full, GATE_DIAGNOSTICS), [
    '.e2e-inputs/live-identity.json',
    '.e2e-inputs/service-release.json',
    '.e2e-inputs/beta-environment-before.json',
    '.e2e-inputs/beta-environment-after.json',
    'deployment-evidence-before.json',
    'deployment-evidence.json',
    GATE_REPORT_PATH,
    'test-results/beta-environment-verdict.json',
    'test-results/**/error-context.md',
  ]);
  // The report the run keeps is declared once, as the job environment the reporter reads.
  assert.match(qualify, new RegExp(`E2E_REPORT_PATH: ${GATE_REPORT_PATH.replaceAll('.', '\\.')}`));
  assert.doesNotMatch(qualify, /E2E_QUALIFICATION_REPORT/);

  // The `smoke` diagnostic keeps its own evidence: the authenticated observation and its
  // revision upload, which no machine reads any more, and no verdict of its own.
  const smoke = job('smoke');
  assert.match(smoke, /name: tested-revisions-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(smoke, /pnpm e2e:collect/);
  for (const name of ['preflight', 'smoke', 'reconcile']) {
    assert.doesNotMatch(job(name), /verify-smoke-drift/, `${name} must never run the removed drift gate`);
  }

  // No workflow may reference the deleted vendored contract.
  for (const [name, source] of [['beta-e2e.yml', qualify], ['check.yml', check]]) {
    assert.doesNotMatch(source, /vendor/, `${name} must not reference the deleted vendored contract`);
  }
});

test('no gate job downloads a producer deployment record or checks out producer source', () => {
  for (const name of ['preflight', 'reconcile', 'full', 'smoke']) {
    const section = job(name);
    assert.doesNotMatch(section, /platform-deployment-record\.json/, `${name} must not retain the retired platform record`);
    assert.doesNotMatch(section, /\.e2e-inputs\/deployment-record\.json/, `${name} must not retain the retired workload record`);
    assert.doesNotMatch(section, /repository: anywear-ai\/AnyWear-Infra/, `${name} must not check out the Infra observer`);
  }
  // The full job writes and retains the two files it reads the live tuple from: the live
  // identity and the Service release identity (#193 renamed the identity input and removed the
  // manifest bytes from the path).
  const full = job('full');
  assert.match(full, /\.e2e-inputs\/live-identity\.json/);
  assert.match(full, /\.e2e-inputs\/service-release\.json/);
  assert.doesNotMatch(full, /service-artifacts\.json/);
  assert.doesNotMatch(qualify, /service-artifacts\.json/);
  assert.doesNotMatch(qualify, /manifest_asset_id|manifest_sha256/);
});

test('the only activation switch in this repository is ENABLE_BETA_MUTATION', () => {
  const names = new Set([...qualify.matchAll(/\bENABLE_[A-Z0-9_]+\b/g)].map((match) => match[0]));
  assert.deepEqual([...names], ['ENABLE_BETA_MUTATION']);
  assert.doesNotMatch(check, /\bENABLE_[A-Z0-9_]+\b/);
  const guard = readFileSync(join(repositoryRoot, 'scripts', 'execution-guard.mjs'), 'utf8');
  assert.match(guard, /environment\.ENABLE_BETA_MUTATION/);
  assert.doesNotMatch(guard, /ENABLE_INFRA_E2E/);
});

test('the daily reconcile dispatch belongs to AnyWear-Infra and no E2E schedule entry remains', () => {
  // #344: `AnyWear-Infra`'s scheduled entry is the single starter of the daily reconcile. It
  // dispatches this entry with `operation=reconcile` and `trigger=scheduled`, because the
  // execution guard requires `workflow_dispatch` and a `schedule` event here would fail closed.
  // The E2E schedule file, its cron trigger and its own `gh workflow run` shape are deleted
  // with the move and must not return: a second starter would be a second writer of the
  // account-pool schedule.
  assert.equal(existsSync(join(directory, REMOVED_SCHEDULE_ENTRY)), false,
    `${REMOVED_SCHEDULE_ENTRY} must not return: the daily reconcile dispatch moved to AnyWear-Infra (#344)`);
  for (const name of entries) {
    const source = read(name);
    assert.doesNotMatch(source, /^ {2}schedule:\n/m, `${name} must declare no schedule trigger`);
    assert.doesNotMatch(source, /^\s*-\s*cron:/m, `${name} must declare no cron trigger`);
    assert.doesNotMatch(source, /gh workflow run/, `${name} must not dispatch this repository's own entry`);
    for (const token of REMOVED_SCHEDULE_TOKENS) {
      assert.equal(source.includes(token), false, `${name} must not name the deleted ${REMOVED_SCHEDULE_ENTRY}`);
    }
  }
  for (const name of readdirSync(join(repositoryRoot, 'scripts')).filter((file) => file.endsWith('.mjs')).sort()) {
    // The census names the deleted file and the forbidden dispatch shape to assert on them, so
    // it excludes itself from its own scan (the same exclusion `record-reader-census.test.mjs`
    // makes).
    if (`scripts/${name}` === CENSUS) continue;
    const source = readFileSync(join(repositoryRoot, 'scripts', name), 'utf8');
    assert.doesNotMatch(source, /gh workflow run/, `scripts/${name} must not dispatch this repository's own entry`);
    for (const token of REMOVED_SCHEDULE_TOKENS) {
      assert.equal(source.includes(token), false, `scripts/${name} must not name the deleted ${REMOVED_SCHEDULE_ENTRY}`);
    }
  }

  // The receiver keeps exactly what the Infra entry dispatches: the closed operation menu and
  // the `scheduled` trigger bound to the reconcile operation and slot offset 0.
  const scheduled = /^ {12}scheduled\)\n([\s\S]*?)^ {14};;$/m.exec(qualify)?.[1] ?? '';
  assert.ok(scheduled.length > 0, 'the preflight must keep the scheduled trigger');
  assert.match(scheduled, /trigger scheduled requires operation reconcile/);
  assert.match(scheduled, /trigger scheduled requires worker_slot_offset 0/);
  // #358: the retired values stay in the closed set beside the gate values until this issue's
  // step 5 deletes them from the input and the validator together.
  assert.match(inputBlock('trigger'), /options: \[manual, deploy-smoke, deploy-gate, release-gate, scheduled, deploy-qualify, release-qualify\]/);
  assert.match(inputBlock('operation'), /options: \[full, smoke, reconcile\]/);
});

test('the preflight admits a gate through one credential-free outbound writer read', () => {
  // #344: the admission is one check in the credential-free preflight, carried by two steps:
  // one mints its own read-only App token for `AnyWear-Infra` (`actions: read` only, #344
  // allocation 7) with the same app id and private key the Service read uses, and the other
  // reads the writer runs through `scripts/writer-admission.mjs`. The mint is a step of its own
  // because every App token in this repository is minted by that reviewed action.
  const preflight = job('preflight');
  const token = stepSection(preflight, 'Generate Infra writer read token');
  assert.match(token, /uses: actions\/create-github-app-token@v3/);
  assert.match(token, /app-id: \$\{\{ vars\.APP_ID \}\}/);
  assert.match(token, /private-key: \$\{\{ secrets\.APP_PRIVATE_KEY \}\}/);
  assert.match(token, /repositories: AnyWear-Infra/);
  assert.match(token, /permission-actions: read/);
  assert.doesNotMatch(token, /permission-contents|permission-actions: write/);

  const admission = stepSection(preflight, 'Admit this gate only when no Infra writer holds the tuple');
  assert.match(admission, /GH_TOKEN: \$\{\{ steps\.infra-writer-token\.outputs\.token \}\}/);
  assert.match(admission, /DISPATCHED_BY: \$\{\{ inputs\.dispatched_by \}\}/);
  // One declared command, and one input: the rule's only exemption is the dispatch's
  // `dispatched_by` matching a candidate run — there is no second exemption flag.
  assert.deepEqual(admission.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('run: ')),
    ['run: node scripts/writer-admission.mjs --dispatched-by "$DISPATCHED_BY"']);

  // #344 review: the read belongs to the operator entry. `manual` is the human dispatch of all
  // three operations and `release-gate` the human re-gate; the automated dispatches are the
  // writer's own children, so the gate skips the read entirely for them instead of letting a
  // queued foreign writer refuse them. Both steps carry the same gate, so an automated dispatch
  // mints no token either.
  //
  // #358: `release-qualify` is the retired spelling of `release-gate`. It stays in the gate
  // until the dispatcher's rename merges, because a dispatch that skipped the read would land a
  // gate on a tuple a writer is changing; this issue's step 5 deletes it.
  const gate = /^ {8}if: (.+)$/m.exec(admission)?.[1] ?? '';
  assert.equal(gate, "inputs.trigger == 'manual' || inputs.trigger == 'release-gate' || inputs.trigger == 'release-qualify'",
    'the admission must be gated on the operator triggers');
  assert.equal(/^ {8}if: (.+)$/m.exec(token)?.[1] ?? '', gate, 'the token mint must carry the admission gate');

  const gated = admittedTriggers(gate);
  assert.deepEqual([...gated].sort(), ['manual', 'release-gate', 'release-qualify'],
    'only the operator dispatch triggers may reach the admission read');
  // The deploy chain's `full` (`operation=full`, `trigger=deploy-gate`), the deployment smoke,
  // the daily reconcile and the retired automated spelling are automated: they do not run the
  // admission, so they cannot be refused by a queued foreign writer.
  for (const automated of ['deploy-gate', 'deploy-qualify', 'deploy-smoke', 'scheduled']) {
    assert.equal(gated.has(automated), false, `trigger ${automated} must skip the admission read`);
  }

  // The step sits after the source and operation-scope checks and before the Service read, so
  // it precedes every job that can hold an AWS credential; it declares no environment and no
  // AWS or OIDC material of its own.
  const admissionIndex = preflight.indexOf('- name: Admit this gate only when no Infra writer holds the tuple');
  assert.ok(admissionIndex > preflight.indexOf('- name: Require protected execution'));
  assert.ok(admissionIndex < preflight.indexOf('- name: Generate Service artifact read token'));
  assert.equal(existsSync(join(repositoryRoot, 'scripts', 'writer-admission.mjs')), true,
    'the admission program must be a shipped script');

  // Both new steps are credential-free: the job's permissions, its absent environment and the
  // pinned `contents: read` are unchanged by the addition.
  assert.match(preflight, /permissions:\n {6}contents: read\n/);
  for (const step of [token, admission]) assert.doesNotMatch(step, /configure-aws-credentials|id-token|environment:/);
});

// #287: the cleanup capability version ARN is read from the deployment by one resolver, pinned
// once per job, and gated before the first account or deletion. The retired repository variable
// must not return, and no second reader may appear.
function stepSection(section, header) {
  const start = section.indexOf(`- name: ${header}`);
  assert.ok(start >= 0, `${header} must be a step of this job`);
  const rest = section.slice(start + 1);
  const next = rest.search(/\n {6}- name: /);
  return `- name: ${header}` + (next < 0 ? rest : rest.slice(0, next));
}

test('both entries read the cleanup capability version from the deployment, once per job', () => {
  // No workflow reads the retired repository variable, in any spelling.
  for (const [name, source] of [['beta-e2e.yml', qualify], ['check.yml', check]]) {
    assert.doesNotMatch(source, /vars\.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN/, `${name} must not read the retired repository variable`);
  }
  const entries = [
    ['reconcile', 'Load the Beta pool and the live cleanup identity'],
    ['full', 'Load Beta test identity configuration'],
    ['smoke', 'Load Beta test identity configuration'],
  ];
  for (const [name, header] of entries) {
    const section = job(name);
    // Exactly one resolve in the job: nothing re-resolves the value for use.
    assert.equal([...section.matchAll(/node scripts\/cleanup-capability\.mjs resolve/g)].length, 1,
      `${name} must resolve the version exactly once in its job`);
    const identity = stepSection(section, header);
    // The resolve sits inside the identity-configuration step that fixes the envelope's Service
    // identity, and the command substitution is the command: a refused resolve fails the step.
    assert.match(identity, /version_arn=\$\(node scripts\/cleanup-capability\.mjs resolve\)/,
      `${name} must pin the resolved value with a command substitution that carries the failure`);
    // It is the step's first command, so a refused read stops the job before it reads anything
    // else, creates a test account or deletes an identity.
    const identityCommands = identity.split('\n').map((line) => line.trim()).filter(Boolean);
    assert.equal(identityCommands[identityCommands.indexOf('run: |') + 1],
      'version_arn=$(node scripts/cleanup-capability.mjs resolve)',
      `${name} must resolve the version as the first command of its identity step`);
    assert.match(identity, /echo "BETA_CLEANUP_STATE_MACHINE_VERSION_ARN=\$version_arn"/,
      `${name} must pin the resolved value in the job environment`);
    assert.match(identity, /\} >> "\$GITHUB_ENV"/,
      `${name} must append the resolved value to the job environment`);
    // The pin is written once: no later step re-derives or overwrites it.
    assert.equal([...section.matchAll(/BETA_CLEANUP_STATE_MACHINE_VERSION_ARN=/g)].length, 1,
      `${name} must write the pin exactly once`);
  }
  // The gate is the first command after the execution guard, before the point that creates the
  // first account (`full`, `smoke`) or deletes the first identity (`reconcile`).
  const gated = [
    ['full', 'Run the release-gating business regression suite', 'pnpm test'],
    ['smoke', 'Run deployed Beta smoke tests', 'pnpm test:smoke'],
    ['reconcile', 'Reconcile recent E2E leftover identities', 'node scripts/reconcile-accounts.mjs'],
  ];
  for (const [name, header, command] of gated) {
    const lines = stepSection(job(name), header).split('\n').map((line) => line.trim()).filter(Boolean);
    const run = lines.indexOf('run: |');
    assert.ok(run >= 0, `${name} suite step must declare a run block`);
    assert.deepEqual(lines.slice(run + 1),
      ['node scripts/execution-guard.mjs', 'node scripts/cleanup-capability.mjs gate', command],
      `${name}: the gate must be the first command after the execution guard`);
  }
  // The gate runs before the suite (or the reconcile pass) in every job, because it is earlier in
  // the same step. A run that cannot read the publication therefore creates no account.
  for (const [name] of gated) assert.match(job(name), /node scripts\/cleanup-capability\.mjs gate/);
});

test('no workflow or shipped script carries a version ARN or a second reader', () => {
  const scripts = readdirSync(join(repositoryRoot, 'scripts'))
    .filter((name) => /\.mjs$/.test(name) && !/\.test\.mjs$/.test(name)).sort();
  assert.ok(scripts.includes('cleanup-capability.mjs'), 'the resolver must exist');
  for (const name of scripts) {
    const text = readFileSync(join(repositoryRoot, 'scripts', name), 'utf8');
    // The only copy of the version-ARN grammar is the reviewed constant in the operation; a
    // shipped script carries no ARN literal, so no copy of a deployed revision is committed.
    assert.doesNotMatch(text, /arn:aws:states:[a-z0-9-]+:\d{12}:stateMachine:/, `${name} must not carry a version ARN`);
    assert.doesNotMatch(text, /list-state-machine-versions/, `${name} must not read the published-version list`);
  }
  for (const name of entries) {
    assert.doesNotMatch(read(name), /arn:aws:states:[a-z0-9-]+:\d{12}:stateMachine:/, `${name} must not carry a version ARN`);
  }
  // The resolver is the only reader: no other shipped script invokes it or the variable.
  const readers = scripts.filter((name) => name !== 'cleanup-capability.mjs'
    && readFileSync(join(repositoryRoot, 'scripts', name), 'utf8').includes('cleanup-capability.mjs'));
  assert.deepEqual(readers, ['cleanup-worker-accounts.mjs', 'reconcile-accounts.mjs'],
    'only the teardown and the reconcile import the start guard, and neither resolves the value');
  // `minimum-supported-client.json` remains the only committed live-path input.
  assert.equal(existsSync(join(repositoryRoot, 'minimum-supported-client.json')), true);
});

test('the retired workflow name is a refusal stub, not a gate entry', () => {
  // #358: the entry is renamed to `beta-e2e.yml`, but `AnyWear-Infra` keeps dispatching the old
  // file name until its step 4 merges. A dispatch under the old name must land on a run that
  // fails and says so, not on a 404 that leaves the Infra hold job with no run to observe. The
  // stub therefore declares the dispatcher's input names (an undeclared input is a 422, so the
  // dispatch would never reach the refusal) and does nothing else.
  assert.equal(existsSync(join(directory, RETIRED_STUB)), true,
    `${RETIRED_STUB} must stay as a refusal stub until this issue's step 5 deletes it`);
  assert.match(stub, /^ {2}workflow_dispatch:$/m);
  for (const name of ['operation', 'trigger', 'expected_service_commit', 'expected_client_commit',
    'worker_slot_offset', 'dispatched_by', 'reconcile_lookback_days']) {
    assert.match(stub, new RegExp(`^ {6}${name}:$`, 'm'),
      `${RETIRED_STUB} must declare the ${name} input the dispatcher sends`);
  }
  // Exactly one job with exactly one step, and that step refuses with a non-zero exit.
  assert.equal([...stub.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].length, 1, `${RETIRED_STUB} must declare exactly one job`);
  assert.match(stub, /^ {10}exit 1$/m, `${RETIRED_STUB} must exit non-zero`);
  assert.match(stub, /renamed to beta-e2e\.yml/, `${RETIRED_STUB} must name the new entry`);
  // It holds no credential and runs nothing: no action, no environment, no token scope, no
  // test command.
  assert.match(stub, /^permissions: \{\}$/m, `${RETIRED_STUB} must request no token scope`);
  for (const forbidden of [/uses:/, /environment:/, /id-token/, /configure-aws-credentials/, /secrets\./,
    /pnpm/, /playwright/, /actions\/upload-artifact|actions\/download-artifact/]) {
    assert.doesNotMatch(stub, forbidden, `${RETIRED_STUB} must hold no credential and run no test (${forbidden})`);
  }
  // It is not a ledger either: neither ledger artifact name may appear.
  for (const token of REMOVED_LEDGER_ARTIFACTS) assert.equal(stub.includes(token), false, `${RETIRED_STUB} must not name ${token}`);
});