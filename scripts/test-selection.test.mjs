import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  INVENTORY_PATH, QUALIFICATION_WORKFLOW_PATH, deployedInvocationTag, inventorySections, inventoryTags,
  invocationTags, repositoryRoot, specDeclarations,
} from './test-selection.mjs';

// #358: the qualification ledger is removed, so this module now owns one thing - the
// declarative scenario parser that `tests/scenario-declarations.test.mjs` also uses. The
// cases below hold the parser to the real checkout: the five tracked spec files, their
// declared tags, and the inventory section that records the same classification.
//
// The record-only derivations this file used to cover - the workflow suite-step reader, the
// invocation/tag derivation, the Playwright report summariser and the record assertions - are
// deleted with the ledger. Nothing below executes a deployed scenario or reads cloud state.

test('the workflow path the module names is the gate entry', () => {
  // #358 renamed the entry. The constant keeps its name but now names `beta-e2e.yml`, and
  // this case is what keeps it pointing at a file that exists and is the gate: a dead path
  // would otherwise read as a passing check.
  assert.equal(QUALIFICATION_WORKFLOW_PATH, '.github/workflows/beta-e2e.yml');
  const workflowPath = join(repositoryRoot, QUALIFICATION_WORKFLOW_PATH);
  assert.equal(existsSync(workflowPath), true, `${QUALIFICATION_WORKFLOW_PATH} must exist`);
  const workflow = readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /^name: Beta E2E gate$/m);
  assert.match(workflow, /^run-name: "Beta E2E gate: /m);
  // The release-gating invocation is still the one the entry declares.
  assert.match(workflow, /^ {10}pnpm test$/m);
});

test('reads every tracked scenario declaration with its tags', () => {
  const declarations = specDeclarations();
  assert.deepEqual(declarations.map(({ file }) => file), [
    'tests/auth-startup.spec.ts', 'tests/rejection-contract.spec.ts',
    'tests/vto.spec.ts', 'tests/wardrobe.spec.ts', 'tests/worker-smoke.spec.ts',
  ]);
  for (const { file, title, tags } of declarations) {
    assert.ok(title, `${file} declares no test.describe title`);
    assert.ok(deployedInvocationTag.test(title), `${file} declares no deployed invocation tag: ${title}`);
    assert.equal(new Set(tags).size, tags.length, `${file} repeats a tag: ${tags.join(' ')}`);
  }
});

test('reads the scenario inventory sections and their declared tags', () => {
  const sections = inventorySections(readFileSync(join(repositoryRoot, INVENTORY_PATH), 'utf8'));
  assert.deepEqual([...sections.keys()].sort(), specDeclarations().map(({ file }) => file));
  for (const [file, section] of sections) {
    assert.ok(invocationTags(inventoryTags(section)).length > 0, `${INVENTORY_PATH} records no invocation tag for ${file}`);
  }
});

test('keeps only the deployed invocation tags in a declaration', () => {
  // A title may carry a tag that selects nothing (an evidence marker, for example); the
  // parser reports only the tags a deployed invocation selects.
  assert.deepEqual(invocationTags(['@regression', '@smoke', '@full-stack', '@drill', '@evidence']),
    ['@drill', '@full-stack', '@regression', '@smoke']);
  assert.deepEqual(invocationTags(['@evidence']), []);
  assert.equal(deployedInvocationTag.test('@regression'), true);
  assert.equal(deployedInvocationTag.test('@evidence'), false);
});
