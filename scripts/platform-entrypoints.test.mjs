import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as entrypoints from './platform-entrypoints.mjs';

// #228: the census of the only committed platform knowledge. `platform-entrypoints.mjs`
// holds exactly the reviewed entry-point identifiers — the stage path, the two name
// prefixes, the one publisher stack the cleanup capability read is bound to (#287), the
// account reader (the account id itself comes from the execution
// environment's `AWS_ACCOUNT_ID` and the STS guard), the two observation regions, the
// terminal stack statuses and the pagination page bound. The runtime export set must be
// exactly this, and the module source must name nothing else: no stage-parameter name,
// no other stack/resource name, no other region, no other stack status and no
// other number. A committed name list returning is a source change this census refuses.
const source = readFileSync(new URL('./platform-entrypoints.mjs', import.meta.url), 'utf8');

test('the platform entry points are exactly the reviewed identifiers', () => {
  assert.deepEqual(Object.keys(entrypoints).sort(), [
    'BILLING_REGION', 'CREDENTIAL_REGION', 'OBSERVATION_REGIONS', 'PAGINATION_PAGE_BOUND',
    'QUEUE_NAME_PREFIX', 'RUNTIME_STACK_NAME', 'STACK_NAME_PREFIX', 'STAGE_PATH', 'TERMINAL_STACK_STATUSES', 'account',
  ]);
  assert.equal(entrypoints.STAGE_PATH, '/anywear/beta/');
  assert.equal(entrypoints.STACK_NAME_PREFIX, 'AnyWear');
  // #287: the one stack whose published cleanup version ARN the qualification reads. The name
  // states a deployment, never a revision: no version number or version ARN is committed.
  assert.equal(entrypoints.RUNTIME_STACK_NAME, 'AnyWearRuntimeStack-beta');
  assert.doesNotMatch(entrypoints.RUNTIME_STACK_NAME, /arn:|:stateMachine:|:[0-9]+$/, 'the publisher stack name may not carry a revision');
  assert.equal(entrypoints.QUEUE_NAME_PREFIX, 'beta-anywear-');
  assert.equal(entrypoints.CREDENTIAL_REGION, 'ap-east-1');
  assert.equal(entrypoints.BILLING_REGION, 'us-east-1');
  assert.deepEqual(entrypoints.OBSERVATION_REGIONS, ['ap-east-1', 'us-east-1']);
  assert.deepEqual(entrypoints.TERMINAL_STACK_STATUSES, ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE']);
  assert.equal(entrypoints.PAGINATION_PAGE_BOUND, 50);
});

test('the account identity comes from the execution environment, never from the module', () => {
  assert.equal(entrypoints.account({ AWS_ACCOUNT_ID: '650880818323' }), '650880818323');
  for (const environment of [{}, { AWS_ACCOUNT_ID: '' }, { AWS_ACCOUNT_ID: 'account' }, { AWS_ACCOUNT_ID: 650880818323 }]) {
    assert.throws(() => entrypoints.account(environment), /AWS_ACCOUNT_ID is required/);
  }
  // The reviewed account id itself is not committed in this module: it arrives through
  // the environment and is verified by the observation's STS guard.
  assert.doesNotMatch(source, /6\d{11}/, 'the module must not commit a reviewed account id');
});

test('the module source names no platform member beyond the reviewed identifiers', () => {
  // No committed stage-parameter name: the stage path appears only as the prefix itself.
  assert.doesNotMatch(source, /\/anywear\/beta\/[a-z0-9_]/, 'no stage-parameter name may be committed');
  // No committed stack name beyond the one publisher the capability read is bound to (#287).
  const stackNames = [...new Set([...source.matchAll(/AnyWear[A-Za-z0-9-]+/g)].map((match) => match[0]))].sort();
  assert.deepEqual(stackNames, ['AnyWearRuntimeStack-beta'], 'no other AnyWear stack name may be committed');
  // No committed queue or Lambda name: the prefix appears only as the bare prefix.
  assert.doesNotMatch(source, /beta-anywear-[a-z0-9]/, 'no beta-anywear queue or Lambda name may be committed');
  // No region beyond the two observation regions.
  const regions = [...source.matchAll(/[a-z]{2}(?:-[a-z]+)+-[0-9]/g)].map((match) => match[0]);
  assert.deepEqual([...new Set(regions)].sort(), ['ap-east-1', 'us-east-1'], 'no region beyond the observation regions may be committed');
  // No stack status beyond the three terminal statuses.
  const statuses = [...source.matchAll(/[A-Z]+_COMPLETE/g)].map((match) => match[0]);
  assert.deepEqual([...new Set(statuses)].sort(), ['CREATE_COMPLETE', 'IMPORT_COMPLETE', 'UPDATE_COMPLETE'],
    'no stack status beyond the terminal statuses may be committed');
  // No number beyond the pagination page bound (comments, string literals and regex
  // literals are not knowledge the module carries).
  const stripped = source
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/\/[^/\n]*\/[a-z]*/g, ' ');
  const numbers = [...stripped.matchAll(/\b[0-9]+\b/g)].map((match) => match[0]);
  assert.deepEqual(numbers, ['50'], 'no number beyond the pagination page bound may be committed');
});
