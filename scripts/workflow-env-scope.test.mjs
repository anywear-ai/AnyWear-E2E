import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { repositoryRoot } from './test-selection.mjs';

// #163 follow-up: an environment-scope guard for the workflows. A job that declares no
// `environment:` resolves `vars.*` and `secrets.*` at repository scope, so a value that
// only exists on the protected `beta` environment reads as empty there. The entry's
// environment-free `preflight` must therefore resolve the deployment account and region
// from workflow constants, and every environment-only value must stay in a job that
// declares `environment: beta`.
//
// The repository has no YAML parser in devDependencies, so this check reuses the
// indentation-aware slicing established by `scripts/entry-census.test.mjs`: the workflow
// files are machine-kept, and each job's text is sliced by its two-space job header.
//
// The `gh release verify` / `attestations: read` pin below is currently **vacuous**: no step
// in this repository invokes `gh release verify` today. It is kept generic so the first
// step that does must declare the attestation read scope.

const workflowDirectory = join(repositoryRoot, '.github', 'workflows');
// GitHub Actions accepts both workflow extensions. Scan both, so a `.yaml` workflow cannot
// escape the environment-scope guard by its suffix.
const files = readdirSync(workflowDirectory).filter((name) => /\.ya?ml$/.test(name)).sort();
const read = (name) => readFileSync(join(workflowDirectory, name), 'utf8');

// The names that exist only on the protected environment (or would only be correct there).
// Keep this list explicit: it is the reviewable statement of what a no-environment job may
// not resolve, independently of which job carries it. #180 keeps BETA_CLIENT_URL and
// BETA_SERVICE_URL here even though the qualification entry now reads the same public
// endpoints from workflow constants: the environment-scoped copies still exist, and a
// no-environment job that started resolving them again would read empty values.
const ENVIRONMENT_SCOPED = Object.freeze([
  'AWS_ACCOUNT_ID',
  'AWS_REGION',
  'BETA_CLIENT_URL',
  'BETA_SERVICE_URL',
  'BETA_CLEANUP_STATE_MACHINE_VERSION_ARN',
  'E2E_CLEANUP_SERVICE_IMAGE_DIGEST',
  'E2E_CLEANUP_SERVICE_SOURCE_SHA',
  'CLEANUP_MACHINE_AUTH_SECRET',
]);

// A top-level or job-level block: the header line plus every following indented line.
// Blank lines and comments are skipped, and the block ends at the first line indented at or
// above the header.
function blockAt(source, header) {
  const lines = source.split(/\r?\n/);
  const start = lines.indexOf(header);
  if (start < 0) return [];
  const indent = header.length - header.trimStart().length;
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent <= indent) break;
    block.push(line);
  }
  return block;
}

// The workflow-level `env:` mapping. Only column-zero `env:` matches, so job env blocks
// cannot be mistaken for it.
function workflowEnv(source) {
  const env = {};
  for (const line of blockAt(source, 'env:')) {
    const match = /^ {2}([A-Za-z_][A-Za-z0-9_]*):\s*(.+)$/.exec(line);
    if (match) env[match[1]] = match[2].trim();
  }
  return env;
}

function jobEnv(text) {
  const env = {};
  for (const line of blockAt(text, '    env:')) {
    const match = /^ {6}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (match) env[match[1]] = match[2].trim();
  }
  return env;
}

function jobPermissions(text) {
  const permissions = {};
  for (const line of blockAt(text, '    permissions:')) {
    const match = /^ {6}([a-z-]+):\s*(\S+)$/.exec(line);
    if (match) permissions[match[1]] = match[2];
  }
  return permissions;
}

// Slice a workflow into its jobs. A job starts at a two-space header that ends with the
// colon and nothing else; the slice runs to the next job header.
function workflowJobs(source) {
  const lines = source.split(/\r?\n/);
  const jobsStart = lines.indexOf('jobs:');
  assert.ok(jobsStart >= 0, 'workflow declares no jobs: mapping');
  const starts = [];
  for (let index = jobsStart + 1; index < lines.length; index += 1) {
    const header = /^ {2}([a-z][a-z0-9-]*):$/.exec(lines[index]);
    if (header) {
      starts.push({ index, name: header[1] });
      continue;
    }
    // A column-zero key ends the `jobs:` mapping.
    if (/^[A-Za-z_]/.test(lines[index])) break;
  }
  assert.ok(starts.length > 0, 'workflow declares no job');
  return starts.map((start, position) => {
    const end = position + 1 < starts.length ? starts[position + 1].index : lines.length;
    const text = lines.slice(start.index, end).join('\n');
    return {
      name: start.name,
      text,
      env: jobEnv(text),
      hasEnvironment: /^ {4}environment:\s*\S+/m.test(text),
      ifLine: text.match(/^ {4}if:\s*(.+)$/m)?.[1]?.trim() ?? '',
      needsLine: text.match(/^ {4}needs:\s*(.+)$/m)?.[1]?.trim() ?? '',
      permissions: jobPermissions(text),
    };
  });
}

const qualify = read('beta-qualification.yml');
const qualifyJobs = workflowJobs(qualify);
const job = (name) => {
  const found = qualifyJobs.find((candidate) => candidate.name === name);
  assert.ok(found, `beta-qualification.yml must declare the ${name} job`);
  return found;
};
const environmentReference = (name) => new RegExp(`\\$\\{\\{\\s*(?:vars|secrets)\\.${name}\\s*\\}\\}`);

test('the deployment account and region are literal workflow constants', () => {
  const env = workflowEnv(qualify);
  assert.equal(env.AWS_ACCOUNT_ID, "'650880818323'", 'workflow AWS_ACCOUNT_ID must be the literal account');
  assert.equal(env.AWS_REGION, "'ap-east-1'", 'workflow AWS_REGION must be the literal region');

  // #180: the two public Beta endpoints are workflow constants for the same reason as the
  // account and region. The environment-free preflight must read the live tuple, and it
  // cannot resolve the environment-scoped copies. Exactly one declaration keeps the
  // preflight comparison, the suite and the record on the same endpoints.
  for (const name of ['E2E_CLIENT_URL', 'E2E_SERVICE_URL']) {
    assert.match(env[name], /^'https:\/\/[a-z0-9-]+\.cloudfront\.net'$/, `workflow ${name} must be the literal public endpoint`);
  }
  for (const candidate of qualifyJobs) {
    for (const name of ['E2E_CLIENT_URL', 'E2E_SERVICE_URL']) {
      assert.ok(!Object.hasOwn(candidate.env, name), `${candidate.name} must inherit the workflow ${name} constant rather than override it`);
    }
  }

  // These values are constants for every job, so no job may shadow them.
  for (const file of files) {
    for (const candidate of workflowJobs(read(file))) {
      assert.ok(!Object.hasOwn(candidate.env, 'AWS_ACCOUNT_ID'), `${file}:${candidate.name} must not shadow AWS_ACCOUNT_ID`);
      assert.ok(!Object.hasOwn(candidate.env, 'AWS_REGION'), `${file}:${candidate.name} must not shadow AWS_REGION`);
    }
  }

  // The environment-scoped repository variables must not be the source of account/region
  // anywhere: a job without an environment would read them as empty.
  const environmentAccount = /\$\{\{\s*vars\.AWS_(?:ACCOUNT_ID|REGION)\s*\}\}/;
  for (const file of files) {
    assert.doesNotMatch(read(file), environmentAccount, `${file} must not resolve the account/region from repository variables`);
  }
});

test('no job without an environment references an environment-scoped name', () => {
  const allJobs = files.flatMap((file) => workflowJobs(read(file)).map((candidate) => ({ file, ...candidate })));
  // Discovery sanity: the repository has both environment and environment-free jobs, so the
  // assertions below judge a real split rather than an empty set.
  assert.ok(allJobs.some((candidate) => candidate.hasEnvironment), 'no environment job was discovered');
  assert.ok(allJobs.some((candidate) => !candidate.hasEnvironment), 'no environment-free job was discovered');

  for (const candidate of allJobs) {
    if (candidate.hasEnvironment) continue;
    for (const name of ENVIRONMENT_SCOPED) {
      assert.doesNotMatch(candidate.text, environmentReference(name),
        `${candidate.file}:${candidate.name} declares no environment: and must not reference ${name}`);
    }
  }
});

test('preflight is environment-free and its effective env resolves at repository scope', () => {
  const preflight = job('preflight');
  assert.equal(preflight.hasEnvironment, false, 'preflight must not declare an environment');
  assert.equal(preflight.permissions['id-token'], undefined, 'preflight must not request an OIDC token');

  // Effective env = the workflow constants merged with the job env. Anything that names an
  // environment-only value would read as empty here, before the credential jobs.
  const effective = { ...workflowEnv(qualify), ...preflight.env };
  for (const [key, value] of Object.entries(effective)) {
    for (const name of ENVIRONMENT_SCOPED) {
      assert.doesNotMatch(value, new RegExp(`\\b${name}\\b`),
        `preflight env ${key} must not resolve environment-scoped ${name}`);
    }
    assert.doesNotMatch(value, /\$\{\{\s*secrets\./, `preflight env ${key} must not read a secret`);
  }

  // The names the preflight does read are dispatch inputs or repository-scope values.
  const workflowVariables = Object.values(effective).flatMap((value) => [...value.matchAll(/\$\{\{\s*vars\.([A-Za-z0-9_]+)\s*\}\}/g)].map((match) => match[1]));
  for (const name of workflowVariables) {
    assert.ok(!ENVIRONMENT_SCOPED.includes(name), `preflight env must not read repository variable ${name}, which is environment-scoped`);
  }
});

test('the cleanup capability version is read from the deployment, never from a repository variable', () => {
  // #287: the value is the one `AnyWearRuntimeStack-beta` publishes. A workflow or a shipped
  // script that read it back from a repository variable would reintroduce exactly the stale copy
  // the issue removed, so the read is refused here.
  const readVariable = /\$\{\{\s*vars\.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN\s*\}\}/;
  for (const file of files) {
    assert.doesNotMatch(read(file), readVariable, `${file} must not read the retired repository variable`);
    assert.doesNotMatch(read(file), /BETA_CLEANUP_STATE_MACHINE_VERSION_ARN:\s*\$\{\{/,
      `${file} must not declare the capability version from a workflow expression`);
  }
  const scripts = readdirSync(join(repositoryRoot, 'scripts'))
    .filter((name) => /\.mjs$/.test(name) && !/\.test\.mjs$/.test(name)).sort();
  assert.ok(scripts.includes('cleanup-capability.mjs'), 'the one resolver must exist');
  for (const name of scripts) {
    const text = readFileSync(join(repositoryRoot, 'scripts', name), 'utf8');
    assert.doesNotMatch(text, readVariable, `scripts/${name} must not read the retired repository variable`);
    assert.doesNotMatch(text, /actions\/variables|gh variable get/,
      `scripts/${name} must not reach the repository-variable API`);
  }
  // Only the resolver's own job step writes the name, and it writes the value it just read.
  for (const name of files) {
    for (const match of read(name).matchAll(/BETA_CLEANUP_STATE_MACHINE_VERSION_ARN=("?)([^\s"]*)\1/g)) {
      assert.equal(match[2], '$version_arn', `${name} must set the capability version only from the resolved value`);
    }
  }
});

test('every job that invokes gh release verify declares attestations: read', () => {
  // Vacuous today: no step in this repository runs `gh release verify`. The pin is generic
  // so the first step that does must declare the attestation read scope.
  for (const file of files) {
    for (const candidate of workflowJobs(read(file))) {
      if (!candidate.text.includes('gh release verify')) continue;
      assert.equal(candidate.permissions.attestations, 'read',
        `${file}:${candidate.name} runs gh release verify and must declare permissions.attestations: read`);
    }
  }
});

test('every operation gate uses the preflight-validated operation output', () => {
  const preflight = job('preflight');
  // The preflight publishes the operation it validated, and the output is wired to it.
  assert.match(preflight.text, /^ {4}outputs:\n(?: {6}#[^\n]*\n)* {6}operation: \$\{\{ steps\.operation-scope\.outputs\.operation \}\}$/m,
    'preflight must expose the validated operation as the operation output');
  assert.match(preflight.text, /^ {6}- name: Validate the dispatch operation, trigger and input scope$/m);
  assert.match(preflight.text, /^ {8}id: operation-scope$/m);
  assert.ok(preflight.text.includes('echo "operation=$OPERATION" >> "$GITHUB_OUTPUT"'),
    'the operation validation step must publish the validated operation');

  for (const operation of ['full', 'smoke']) {
    const candidate = job(operation);
    assert.match(candidate.needsLine, /preflight/, `${operation} must need preflight`);
    assert.match(candidate.ifLine, new RegExp(`needs\\.preflight\\.outputs\\.operation == '${operation}'`),
      `${operation} must gate on the validated preflight output`);
    assert.doesNotMatch(candidate.ifLine, /inputs\.operation/,
      `${operation} must not gate its job on the raw dispatch input`);
  }

  // #217: the reconcile job serves its own operation and runs before every qualification
  // suite, so its gate names all three operations and still reads only the validated output.
  const reconcile = job('reconcile');
  assert.match(reconcile.needsLine, /preflight/, 'reconcile must need preflight');
  for (const operation of ['reconcile', 'full', 'smoke']) {
    assert.match(reconcile.ifLine, new RegExp(`needs\\.preflight\\.outputs\\.operation == '${operation}'`),
      `reconcile must gate on the validated ${operation} operation`);
  }
  assert.doesNotMatch(reconcile.ifLine, /inputs\.operation/, 'reconcile must not gate its job on the raw dispatch input');

  // `record` gates on the same validated output, so it must also need the job that
  // produces it: `needs: full` alone would leave needs.preflight.outputs unresolved.
  const record = job('record');
  assert.match(record.ifLine, /needs\.preflight\.outputs\.operation == 'full'/, 'record must gate on the validated operation');
  assert.doesNotMatch(record.ifLine, /inputs\.operation/, 'record must not gate its job on the raw dispatch input');
  assert.match(record.needsLine, /preflight/, 'record must need preflight for its output to resolve');
  assert.match(record.needsLine, /full/, 'record must still need full');
});
