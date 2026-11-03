import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import {
  QUALIFICATION_REPORT_ENV, QUALIFICATION_REPORT_PATH, QUALIFICATION_SUITE_STEP, QUALIFICATION_WORKFLOW_PATH,
  assertScenarioDeclarations, assertTestSelection, buildTestMember, qualificationInvocation, qualificationReportPath,
  qualificationSelection, qualificationSuiteStep, readPackageJson, reportScenarios, repositoryRoot, selectionTag,
  selectedScenarios,
} from './test-selection.mjs';

// These cases hold the qualification record's statement of its own selection to four
// independent sources: the qualification workflow's suite step, `package.json`, the run's
// Playwright JSON report and the spec titles/inventory. The producer and the verifier both
// call the module under test, so a case here is a case about both ends at once. Nothing
// below executes a deployed scenario or reads any cloud state.

const workflow = await readFile(join(repositoryRoot, QUALIFICATION_WORKFLOW_PATH), 'utf8');

async function temporaryRoot(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'anywear-test-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content, 'utf8');
  }
  return root;
}

// A minimal workflow with one step list: enough for the derivation, and nothing else.
const syntheticWorkflow = (run) => `name: Beta Qualification

jobs:
  qualify:
    steps:
      - name: Checkout E2E sources
        uses: actions/checkout@v4

      - name: Whatever a reader sees
        id: beta-suite
        run: |
${run.split('\n').map((line) => `          ${line}`).join('\n')}
`;

const reportTest = (status) => ({
  timeout: 30_000, annotations: [], expectedStatus: 'passed', projectId: 'chromium', projectName: 'chromium', results: [], status,
});

const describeSuite = (file, title, statuses) => ({
  title,
  file,
  line: 1,
  column: 1,
  specs: statuses.map((status, index) => ({
    title: `${title} case ${index}`,
    ok: status !== 'unexpected',
    tags: [],
    tests: [reportTest(status)],
    id: `${file}-${index}`,
    file,
    line: 1,
    column: 1,
  })),
});

const fileSuite = (file, statuses, nested = []) => ({
  title: file, file, line: 0, column: 0, specs: [], suites: [describeSuite(file, `${file} describe`, statuses), ...nested],
});

const reportBytes = (suites) => Buffer.from(`${JSON.stringify({ config: { rootDir: 'tests' }, suites, errors: [], stats: {} }, null, 2)}\n`);

const scenario = (file, overrides = {}) => ({ file, outcome: 'passed', collected: 1, skipped: 0, ...overrides });

const testMember = (tag, scenarios) => ({
  runner: 'playwright',
  result: scenarios.some(({ outcome }) => outcome === 'flaky') ? 'flaky' : 'passed',
  selection: { invocation: 'test', tag },
  report_sha256: 'a'.repeat(64),
  scenarios,
});

test('derives the qualification invocation from the beta-suite step, not from its display name', async (t) => {
  assert.equal(qualificationInvocation(), 'test');
  const suite = qualificationSuiteStep();
  assert.equal(suite.id, QUALIFICATION_SUITE_STEP);
  assert.equal(suite.name.length > 0, true);

  // Rename the step in a copy of the real workflow and derive again: a reader-facing name
  // cannot decide which selection issued a record.
  const renamed = workflow.replace(/( *- name: )([^\n]*)(\n\s+id: beta-suite)/, '$1A name that says nothing$3');
  assert.notEqual(renamed, workflow, 'the suite step name was not replaced in the copy');
  const root = await temporaryRoot(t, { [QUALIFICATION_WORKFLOW_PATH]: renamed });
  assert.equal(qualificationInvocation({ root }), 'test');
  assert.equal(qualificationSuiteStep({ root }).name, 'A name that says nothing');
});

test('refuses a suite step that runs no pnpm script or more than one', async (t) => {
  for (const [label, run, expected] of [
    ['no pnpm script', 'node scripts/execution-guard.mjs', /runs no pnpm script/],
    ['two pnpm scripts', 'node scripts/execution-guard.mjs\npnpm test\npnpm test:smoke', /runs more than one pnpm script \(test, test:smoke\)/],
  ]) {
    const root = await temporaryRoot(t, { [QUALIFICATION_WORKFLOW_PATH]: syntheticWorkflow(run) });
    assert.throws(() => qualificationInvocation({ root }), expected, label);
  }
  // The refusal names what the step actually runs, so a reader is not sent looking for a
  // script that was never in the block.
  const empty = await temporaryRoot(t, { [QUALIFICATION_WORKFLOW_PATH]: syntheticWorkflow('node scripts/execution-guard.mjs') });
  assert.throws(() => qualificationInvocation({ root: empty }),
    /its run block is node scripts\/execution-guard\.mjs/, 'no pnpm script must name the commands it runs');
});

// A step's keys belong to the step, not to the position of a `run:` block inside it: a
// workflow that writes `id:` below its block `run:` is just as identifiable as one that
// writes it above.
test('derives the invocation when the step id is written after a block run block', async (t) => {
  const workflowWithLateId = `name: Beta Qualification

jobs:
  qualify:
    steps:
      - name: Checkout E2E sources
        uses: actions/checkout@v4

      - name: Whatever a reader sees
        run: |
          node scripts/execution-guard.mjs
          pnpm test
        id: beta-suite
`;
  const root = await temporaryRoot(t, { [QUALIFICATION_WORKFLOW_PATH]: workflowWithLateId });
  const suite = qualificationSuiteStep({ root });
  assert.equal(suite.id, QUALIFICATION_SUITE_STEP);
  assert.deepEqual(suite.run.map((line) => line.trim()).filter(Boolean), ['node scripts/execution-guard.mjs', 'pnpm test']);
  assert.equal(qualificationInvocation({ root }), 'test');
});

test('refuses a workflow with no beta-suite step and names the ids it found', async (t) => {
  // The `id:` and `- name:` lines below sit inside the run body, so neither may be read as
  // the step's own key or as a new step: the step genuinely has no beta-suite id.
  const noSuiteStep = `name: Beta Qualification

jobs:
  qualify:
    steps:
      - name: Checkout E2E sources
        id: checkout
        uses: actions/checkout@v4

      - name: Whatever a reader sees
        id: not-the-suite
        run: |
          node scripts/execution-guard.mjs
          pnpm test
          - name: Not a step
          id: beta-suite
`;
  const root = await temporaryRoot(t, { [QUALIFICATION_WORKFLOW_PATH]: noSuiteStep });
  assert.throws(() => qualificationInvocation({ root }),
    /declares no step with id beta-suite, so the selection that issued a record is unknown \(declared step ids: checkout, not-the-suite\)/);
  assert.throws(() => qualificationSuiteStep({ root }), /declared step ids: checkout, not-the-suite/);
});

// A workflow whose second step is written as `stepLines`, indented for the step list. The
// first step is fixed so the reader's indentation probe has a real step to find.
const stepWorkflow = (stepLines) => `name: Beta Qualification

jobs:
  qualify:
    steps:
      - name: Checkout E2E sources
        uses: actions/checkout@v4

${stepLines}
`;

test('reads every valid block run header as a block rather than as content', async (t) => {
  // `|-`, `|+`, an indentation indicator, `>`, and a trailing comment are all valid YAML
  // block headers. Reading any of them as script text would hide the block it introduces.
  for (const header of ['|', '|-', '|+', '|2', '|2-', '|-2', '|+2', '>', '>-', '>+', '| # comment', '|2 # comment']) {
    const workflow = stepWorkflow(`      - name: Whatever a reader sees
        id: beta-suite
        run: ${header}
          node scripts/execution-guard.mjs
          pnpm test`);
    const root = await temporaryRoot(t, { [QUALIFICATION_WORKFLOW_PATH]: workflow });
    assert.equal(qualificationInvocation({ root }), 'test', `header ${JSON.stringify(header)}`);
  }
});

test('discloses a run header it cannot parse instead of reporting it as the run block', async (t) => {
  const workflow = stepWorkflow(`      - name: Whatever a reader sees
        id: beta-suite
        run: |x not a header
          pnpm test`);
  const root = await temporaryRoot(t, { [QUALIFICATION_WORKFLOW_PATH]: workflow });
  let refusal;
  try { qualificationInvocation({ root }); } catch (error) { refusal = error; }
  assert.ok(refusal, 'an unparseable run header must refuse');
  assert.match(refusal.message, /its run header "\|x not a header" is not a block header this reader recognises, so the block was not read/);
  // Fail-closed and honest: the header is never accepted as an inline command, and it is
  // never presented as the block's content.
  assert.doesNotMatch(refusal.message, /its run block is/);
});

// A step may begin with `- id:`; its display name then comes from its `name:` key, or stays
// empty when it has none, and an `id:` line inside the run body is content.
test('finds a step written with its id on the dash line and ignores a decoy id in its run body', async (t) => {
  const workflow = stepWorkflow(`      - id: beta-suite
        name: Whatever a reader sees
        run: |
          node scripts/execution-guard.mjs
          pnpm test
          id: not-the-step`);
  const root = await temporaryRoot(t, { [QUALIFICATION_WORKFLOW_PATH]: workflow });
  const suite = qualificationSuiteStep({ root });
  assert.equal(suite.id, 'beta-suite');
  assert.equal(suite.name, 'Whatever a reader sees');
  assert.deepEqual(suite.run.map((line) => line.trim()).filter(Boolean),
    ['node scripts/execution-guard.mjs', 'pnpm test', 'id: not-the-step']);
  assert.equal(qualificationInvocation({ root }), 'test');

  // The same step without a `name:` key keeps an empty display name rather than inventing one.
  const nameless = await temporaryRoot(t, {
    [QUALIFICATION_WORKFLOW_PATH]: stepWorkflow(`      - id: beta-suite
        run: |
          pnpm test`),
  });
  assert.equal(qualificationSuiteStep({ root: nameless }).name, '');
  assert.equal(qualificationInvocation({ root: nameless }), 'test');
});

test('derives each invocation tag from package.json and refuses any that selects no single tag', () => {
  const pkg = readPackageJson();
  for (const [invocation, tag] of [
    ['test', '@regression'],
    ['test:smoke', '@smoke'],
    ['test:regression', '@regression'],
    ['test:full-stack', '@full-stack'],
  ]) {
    assert.equal(selectionTag(pkg, invocation), tag, invocation);
  }
  // Discovery, offline contracts and the deferred prototypes carry no single positive tag.
  for (const invocation of ['test:core', 'test:tool-regressions', 'test:deferred-sqs', 'test:list']) {
    assert.throws(() => selectionTag(pkg, invocation), /not a single positive --grep tag selection/, invocation);
  }
  assert.throws(() => selectionTag(pkg, 'test:undeclared'), /declares no test:undeclared script/);
  // A tag that is not a plain lowercase positive selection is refused rather than recorded.
  for (const command of ['playwright test', 'playwright test --grep=@regression', 'playwright test --grep @Regression',
    'playwright test --grep @regression --grep-invert @smoke', 'playwright test --list --grep @regression']) {
    assert.throws(() => selectionTag({ scripts: { test: command } }, 'test'), /not a single positive --grep tag selection/, command);
  }
});

test('the spec titles, the scenario inventory and the release-gating selection agree on the five members', () => {
  const declarations = assertScenarioDeclarations();
  assert.deepEqual(declarations.map(({ file }) => file), [
    'tests/auth-startup.spec.ts', 'tests/rejection-contract.spec.ts',
    'tests/vto.spec.ts', 'tests/wardrobe.spec.ts', 'tests/worker-smoke.spec.ts',
  ]);
  assert.deepEqual(qualificationSelection(), { invocation: 'test', tag: '@regression' });
  // Every tracked deployed scenario is in the release-gating selection.
  assert.deepEqual(selectedScenarios('@regression').map(({ file }) => file), [
    'tests/auth-startup.spec.ts', 'tests/rejection-contract.spec.ts', 'tests/vto.spec.ts',
    'tests/wardrobe.spec.ts', 'tests/worker-smoke.spec.ts',
  ]);
  assert.deepEqual(selectedScenarios('@full-stack').map(({ file }) => file), [
    'tests/auth-startup.spec.ts', 'tests/vto.spec.ts',
    'tests/wardrobe.spec.ts', 'tests/worker-smoke.spec.ts',
  ]);
});

test('derives one entry per selected spec from the run report with the documented outcome priority', () => {
  const scenarios = reportScenarios(reportBytes([
    // Two nested describe suites under one file suite: a retry-only pass outranks a pass.
    {
      title: 'tests/alpha.spec.ts', file: 'tests/alpha.spec.ts', line: 0, column: 0, specs: [],
      suites: [describeSuite('tests/alpha.spec.ts', 'Alpha', ['expected']), describeSuite('tests/alpha.spec.ts', 'Alpha more', ['expected', 'flaky'])],
    },
    // Every collected test skipped is the only way a file is `skipped`.
    fileSuite('tests/beta.spec.ts', ['skipped', 'skipped']),
    // A partial skip is a pass with a counted skip, not a skipped scenario.
    fileSuite('tests/gamma.spec.ts', ['skipped', 'expected']),
    // A failure outranks a retry-only pass.
    fileSuite('tests/delta.spec.ts', ['unexpected', 'flaky']),
  ]));
  assert.deepEqual(scenarios, [
    { file: 'tests/alpha.spec.ts', outcome: 'flaky', collected: 3, skipped: 0 },
    { file: 'tests/beta.spec.ts', outcome: 'skipped', collected: 2, skipped: 2 },
    { file: 'tests/delta.spec.ts', outcome: 'failed', collected: 2, skipped: 0 },
    { file: 'tests/gamma.spec.ts', outcome: 'passed', collected: 2, skipped: 1 },
  ]);
});

test('refuses a report with no scenario, an unknown status, or a file that disagrees with its suite chain', () => {
  assert.throws(() => reportScenarios(reportBytes([])), /records no scenario/);
  assert.throws(() => reportScenarios(reportBytes([{ title: 'tests/alpha.spec.ts', file: 'tests/alpha.spec.ts', specs: [], suites: [] }])),
    /records no scenario/);
  assert.throws(() => reportScenarios(Buffer.from('{}')), /declares no suites/);
  assert.throws(() => reportScenarios(Buffer.from('not json')), /is not JSON/);
  assert.throws(() => reportScenarios(Buffer.from([0xc0, 0xaf])), /not valid UTF-8/);
  assert.throws(() => reportScenarios(reportBytes([fileSuite('tests/alpha.spec.ts', ['silent'])])), /unknown test status "silent"/);

  const disagreed = fileSuite('tests/alpha.spec.ts', ['expected']);
  disagreed.suites[0].specs[0].file = 'tests/beta.spec.ts';
  assert.throws(() => reportScenarios(reportBytes([disagreed])),
    /places the tests\/beta\.spec\.ts spec in a suite for tests\/alpha\.spec\.ts/);

  const noTests = fileSuite('tests/alpha.spec.ts', ['expected']);
  noTests.suites[0].specs[0].tests = [];
  assert.throws(() => reportScenarios(reportBytes([noTests])), /records a spec in tests\/alpha\.spec\.ts with no test/);
});

test('refuses a selection that omits a declared member or adds one the tag does not select', () => {
  const regression = ['tests/auth-startup.spec.ts', 'tests/rejection-contract.spec.ts', 'tests/vto.spec.ts', 'tests/wardrobe.spec.ts', 'tests/worker-smoke.spec.ts'];
  // A record that drops a declared member silently narrows what it claims to have qualified.
  assert.throws(() => assertTestSelection(testMember('@regression', [
    scenario('tests/auth-startup.spec.ts'), scenario('tests/rejection-contract.spec.ts'),
    scenario('tests/vto.spec.ts'), scenario('tests/worker-smoke.spec.ts'),
  ])), /omits tests\/wardrobe\.spec\.ts/);
  // A scenario file neither the tag nor this repository selects is refused rather than added
  // to the record's claim.
  assert.throws(() => assertTestSelection(testMember('@regression', [
    ...regression.map((file) => scenario(file)), scenario('tests/retired.spec.ts'),
  ])), /adds tests\/retired\.spec\.ts/);
  // Stating the discovery selection is refused before the scenario list is even compared:
  // the qualification workflow's suite step does not run `@full-stack`.
  assert.throws(() => assertTestSelection(testMember('@full-stack', [
    ...regression.map((file) => scenario(file)),
  ])), /Qualification selection mismatch/);
  // The declared selection itself is accepted.
  assert.doesNotThrow(() => assertTestSelection(testMember('@regression', [
    ...regression.map((file) => scenario(file)),
  ])));
});

test('refuses a skipped scenario whose spec declares no runtime skip', () => {
  const member = testMember('@regression', [
    scenario('tests/auth-startup.spec.ts'),
    scenario('tests/rejection-contract.spec.ts'),
    scenario('tests/vto.spec.ts'),
    // wardrobe.spec.ts has no `test.skip(condition)` at all: a collected-and-skipped entry
    // here would excuse an acceptance path that never ran.
    scenario('tests/wardrobe.spec.ts', { outcome: 'skipped', skipped: 1 }),
    scenario('tests/worker-smoke.spec.ts'),
  ]);
  assert.throws(() => assertTestSelection(member), /tests\/wardrobe\.spec\.ts declares no runtime skip/);
  // A partial skip needs the declaration too, because the counts would otherwise read as a
  // completed spec.
  assert.throws(() => assertTestSelection(testMember('@regression', [
    scenario('tests/auth-startup.spec.ts'),
    scenario('tests/rejection-contract.spec.ts'),
    scenario('tests/vto.spec.ts'),
    scenario('tests/wardrobe.spec.ts', { collected: 2, skipped: 1 }),
    scenario('tests/worker-smoke.spec.ts'),
  ])), /tests\/wardrobe\.spec\.ts records 1 skipped test/);
});

test('refuses a failed scenario even when the run reported success', () => {
  const failed = testMember('@regression', [
    scenario('tests/auth-startup.spec.ts'),
    scenario('tests/rejection-contract.spec.ts'),
    scenario('tests/vto.spec.ts'),
    scenario('tests/wardrobe.spec.ts', { outcome: 'failed' }),
    scenario('tests/worker-smoke.spec.ts'),
  ]);
  assert.equal(failed.result, 'passed');
  assert.throws(() => assertTestSelection(failed), /tests\/wardrobe\.spec\.ts failed, so the run cannot issue a qualification record/);
  // The report is where the failure is read from, and the workflow's literal `passed` result
  // never reaches it.
  assert.throws(() => buildTestMember(reportBytes([
    fileSuite('tests/auth-startup.spec.ts', ['expected']),
    fileSuite('tests/rejection-contract.spec.ts', ['expected']),
    fileSuite('tests/vto.spec.ts', ['expected']),
    fileSuite('tests/wardrobe.spec.ts', ['unexpected']),
    fileSuite('tests/worker-smoke.spec.ts', ['expected']),
  ])), /tests\/wardrobe\.spec\.ts failed/);
});

test('refuses a run where nothing executed, using a synthetic spec that declares its skip', async (t) => {
  // No current deployed spec declares a runtime skip, so an all-skipped real run is already
  // refused by the declaration rule above. The "nothing executed" rule still needs coverage,
  // so this case builds the smallest checkout in which every skip is legally declared.
  const root = await temporaryRoot(t, {
    [QUALIFICATION_WORKFLOW_PATH]: syntheticWorkflow('node scripts/execution-guard.mjs\npnpm test'),
    'package.json': JSON.stringify({ scripts: { test: 'playwright test --grep @regression' } }),
    'docs/scenario-inventory.md': '# Scenario inventory\n\n### `tests/alpha.spec.ts`\n\n'
      + '| Field | Value |\n| --- | --- |\n| Declared title | `Alpha @regression @full-stack` |\n'
      + '| Tags | `@regression @full-stack` |\n',
    'tests/alpha.spec.ts': "test.describe('Alpha @regression @full-stack', () => {\n"
      + "  test.skip(process.env.E2E_ALPHA !== 'true', 'alpha is optional');\n});\n",
  });
  const skipped = testMember('@regression', [scenario('tests/alpha.spec.ts', { outcome: 'skipped', skipped: 1 })]);
  assert.throws(() => assertTestSelection(skipped, { root }), /requires at least one scenario that executed/);
  // The same skip with a second case executed is a legal pass with a counted skip.
  assert.doesNotThrow(() => assertTestSelection(testMember('@regression', [
    scenario('tests/alpha.spec.ts', { collected: 2, skipped: 1 }),
  ]), { root }));
});

test('the qualification workflow writes the report the record reads, in every artifact list', () => {
  const configured = workflow.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith(`${QUALIFICATION_REPORT_ENV}:`))
    ?.slice(QUALIFICATION_REPORT_ENV.length + 1).trim();
  assert.equal(configured, QUALIFICATION_REPORT_PATH);
  // One declaration drives both ends: the workflow's reporter output and the module default.
  assert.equal(qualificationReportPath(), resolve(repositoryRoot, QUALIFICATION_REPORT_PATH));

  // #163: the full job hands the report to the credential-free record job, which attaches
  // the released artifact; the diagnostics list retains it beside them.
  for (const upload of ['Upload the qualification record handoff', 'Upload qualification diagnostics', 'Attach the qualification evidence']) {
    const start = workflow.indexOf(`- name: ${upload}`);
    assert.ok(start > 0, `${upload} step is missing`);
    const next = workflow.indexOf('- name: ', start + 1);
    const block = workflow.slice(start, next < 0 ? undefined : next);
    assert.ok(block.includes(QUALIFICATION_REPORT_PATH), `${upload} must retain the report the record hashes`);
  }

  // The suite step still runs the guard and exactly one release-gating invocation, and adds
  // no reporter flag: the report path travels through the job environment, not the command.
  const suite = qualificationSuiteStep();
  assert.deepEqual(suite.run.map((line) => line.trim()).filter(Boolean), ['node scripts/execution-guard.mjs', 'pnpm test']);
  assert.doesNotMatch(suite.run.join('\n'), /--reporter|--output/);
});

// #180: the entries that carry a qualification are the live-tuple dispatch and the recorded
// release approval. This is a source assertion so the next workflow change cannot quietly
// reintroduce a committed compatibility read into the active qualification path.
test('the qualification entry dispatches the live tuple and approves through the recorded gate', () => {
  assert.doesNotMatch(workflow, /compatibility\.json/);
  assert.doesNotMatch(workflow, /check-compatibility\.mjs/);
  assert.doesNotMatch(workflow, /trusted-deployment-inputs\.mjs/);
  assert.doesNotMatch(workflow, /\.infra-source/);
  assert.match(workflow, /node scripts\/service-release\.mjs/);
  assert.match(workflow, /minimum-supported-client\.json/);
  for (const input of ['expected_service_commit', 'expected_client_commit', 'trigger', 'dispatched_by']) {
    assert.ok(workflow.includes(`\n      ${input}:\n`), `${input} must be a declared dispatch input`);
  }
  // #217 adds the daily `scheduled` trigger, which may only ask for the reconcile operation.
  // #226 adds the deploy chain's `deploy-qualify`, which may only ask for full.
  assert.match(workflow, /options: \[manual, deploy-smoke, deploy-qualify, release-qualify, scheduled\]/);
  // The release decision is the green full run plus the sealed record: no approval
  // Environment and no approval job exist.
  assert.doesNotMatch(workflow, /beta-release-approval|\n {2}approve:\n|AwaitingApproval/);
  assert.match(workflow, /node scripts\/verify-qualification-record\.mjs/);
  // The live endpoints the preflight compares are workflow constants, so they are readable
  // without the protected environment.
  assert.match(workflow, /E2E_CLIENT_URL: 'https:\/\/[a-z0-9-]+\.cloudfront\.net'/);
  assert.match(workflow, /E2E_SERVICE_URL: 'https:\/\/[a-z0-9-]+\.cloudfront\.net'/);
});
