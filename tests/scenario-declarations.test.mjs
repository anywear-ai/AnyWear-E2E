import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  deployedInvocationTag,
  inventorySections,
  inventoryTags,
  invocationTags,
  specDeclarations,
} from '../scripts/test-selection.mjs';

// The deployed invocations select scenarios by tag, so a tag is the scenario's
// declared membership in an invocation. This offline check holds the two ends of
// that contract together: every spec file declares at least one invocation tag on
// its `test.describe` title, and the deployed invocation scripts in package.json
// are exactly the ones the inventory document describes. A renamed or removed tag
// would otherwise drop a scenario out of the release-qualifying selection with
// nothing left to fail, which is the failure this file exists to prevent.
//
// The selection itself is not executed here. A discovery run cannot establish a
// deployed claim, and an offline file cannot load the deployed environment.
//
// The parsers are the qualification record's own: the record states which scenarios
// the release-gating selection contains, and it is derived from these titles, so a
// second copy of the parser here could agree with itself and disagree with the
// record. `scripts/test-selection.mjs` owns them and both callers read them.

const inventoryUrl = new URL('../docs/scenario-inventory.md', import.meta.url);
const packageUrl = new URL('../package.json', import.meta.url);
const inventoryPath = 'docs/scenario-inventory.md';

test('every scenario declares its deployed invocation membership as a tag', async () => {
  for (const { file, title, tags } of await specDeclarations()) {
    assert.ok(deployedInvocationTag.test(title),
      `${file} declares no deployed invocation tag in its describe title: ${title}`);
    assert.equal(new Set(tags).size, tags.length, `${file} repeats a tag: ${tags.join(' ')}`);
  }
});

test('every scenario is classified in the scenario inventory and vice versa', async () => {
  const specs = await specDeclarations();
  const inventory = await readFile(inventoryUrl, 'utf8');
  const sections = inventorySections(inventory);
  for (const { file, title } of specs) {
    const section = sections.get(file);
    assert.ok(section, `${inventoryPath} has no section for ${file}`);
    assert.ok(section.includes(title),
      `${inventoryPath} does not record the current title of ${file}: ${title}`);
  }
  for (const heading of sections.keys()) {
    assert.ok(specs.some(({ file }) => file === heading),
      `${inventoryPath} classifies ${heading}, which is not a tracked scenario`);
  }
});

test('the inventory and every spec agree about which invocations select the scenario', async () => {
  const inventory = await readFile(inventoryUrl, 'utf8');
  const sections = inventorySections(inventory);
  for (const { file, tags } of await specDeclarations()) {
    const section = sections.get(file);
    assert.ok(section, `${inventoryPath} has no section for ${file}`);
    assert.deepEqual(invocationTags(inventoryTags(section)), invocationTags(tags),
      `${inventoryPath} and ${file} disagree about the invocations that select it. `
      + 'A scenario that loses a tag leaves its invocation, so both must move in one change');
  }
});

test('the documented deployed invocations are exactly the scripts that select them', async () => {
  const inventory = await readFile(inventoryUrl, 'utf8');
  // The `## Deployed invocations` table is the record of what exists today. The
  // change that finishes the release-gating split extends that table, and this check
  // fails until it does, so the inventory cannot drift behind package.json.
  const section = /^## Deployed invocations$([\s\S]*?)(?=^## )/m.exec(inventory)?.[1];
  assert.ok(section, `${inventoryPath} has no "Deployed invocations" section`);
  const documented = new Set([...section.matchAll(/`(test(?::[a-z-]+)?)`/g)].map(([, name]) => name));
  documented.delete('test:list'); // Discovery, documented in prose rather than as an invocation.
  assert.ok(documented.size > 0, `${inventoryPath} documents no deployed invocation`);

  const pkg = JSON.parse(await readFile(packageUrl, 'utf8'));
  const declared = new Set(Object.keys(pkg.scripts).filter((name) => name.startsWith('test') && name !== 'test:list'));
  for (const name of declared) assert.ok(documented.has(name),
    `package.json declares ${name} but ${inventoryPath} does not document it`);
  for (const name of documented) assert.ok(declared.has(name),
    `${inventoryPath} documents ${name} but package.json does not declare it`);
});

// #226: the deploy chain dispatches one `full` per deployment and relies on the
// release-gating `@regression` selection to carry the smoke evidence inside it. A spec
// tagged `@smoke` without `@regression` would leave the smoke coverage out of the single
// release-gating run and out of the qualification record's `test` member, so it fails here
// rather than during a deployed qualification. This is the `@smoke ⊆ @regression` bound the
// issue requires; the selection itself stays the spec-level `@regression` superset.
test('every @smoke scenario is also selected by the release-gating @regression selection', async () => {
  const specs = await specDeclarations();
  const smoke = specs.filter(({ tags }) => tags.includes('@smoke'));
  assert.ok(smoke.length > 0, 'no spec declares @smoke, so the subset check would be vacuous');
  for (const { file, title, tags } of smoke) {
    assert.ok(tags.includes('@regression'),
      `${file} declares @smoke without @regression, so the release-gating selection would not carry its smoke evidence: ${title}`);
  }
});
