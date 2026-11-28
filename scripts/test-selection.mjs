import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The declarative scenario parser. A deployed invocation selects scenarios by tag, and a tag
// is a scenario's declared membership in an invocation. This module reads the two records of
// that classification — the `test.describe` titles of `tests/*.spec.ts` and
// `docs/scenario-inventory.md` — so the offline declaration check has one parser instead of a
// second copy that could agree with itself and disagree with the repository.
//
// #358 removed the qualification ledger, and with it the record-only derivations that used
// to live here: the workflow suite-step reader, the selection/tag derivation, the Playwright
// report summariser and the record-assertion helpers. The parser below is what
// `tests/scenario-declarations.test.mjs` still needs, and it serves that contract alone.
//
// Nothing here imports from `node_modules`, and nothing here reads a deployed system.

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

// Paths are resolved from this module, never from the process: the checks that import this
// module read the same checkout the module itself was loaded from.
export const repositoryRoot = resolve(moduleDirectory, '..');

// The one workflow file that owns the gate entry. #358 renamed the file; the constant keeps
// its name so the reference stays a single point of truth, and it now names the gate entry
// `beta-e2e.yml`. It carries no selection derivation any more: the release-gating invocation
// is asserted directly by `test-selection.test.mjs` and by the workflow census.
export const QUALIFICATION_WORKFLOW_PATH = '.github/workflows/beta-e2e.yml';
export const SCENARIO_DIRECTORY = 'tests/';
export const INVENTORY_PATH = 'docs/scenario-inventory.md';

// Invocation tags, and the scripts that select them. A scenario may carry several. This
// vocabulary is shared with the offline declaration check so both ends read a title the
// same way.
export const deployedInvocationTag = /@(smoke|regression|drill|full-stack)\b/;

function rootOf(options = {}) {
  return resolve(options.root ?? repositoryRoot);
}

// A spec declares a runtime skip when `test.skip(...)` starts with a computed condition. A
// quoted first argument names a test and skips it unconditionally, which is a declaration
// rather than a runtime reason a reader has to explain.
const runtimeSkip = /^[ \t]*test\.skip\(\s*(?![`'"])/m;

export function declaresRuntimeSkip(source) {
  return runtimeSkip.test(source);
}

export function specDeclarations(options = {}) {
  const directory = resolve(rootOf(options), SCENARIO_DIRECTORY);
  const entries = readdirSync(directory).filter((name) => name.endsWith('.spec.ts')).sort();
  if (entries.length === 0) throw new Error('no spec file was discovered: a check over an empty set proves nothing');
  return entries.map((name) => {
    // Keys are repository-relative paths, because the inventory names each scenario by the
    // path a reader can open.
    const file = `${SCENARIO_DIRECTORY}${name}`;
    const source = readFileSync(resolve(directory, name), 'utf8');
    const title = /test\.describe\(\s*'([^']+)'/.exec(source)?.[1];
    return { file, title, tags: title?.match(/@[a-z-]+/g) ?? [], declaresRuntimeSkip: declaresRuntimeSkip(source) };
  });
}

export function inventorySections(inventory) {
  // The inventory names each scenario with a level-three heading whose text is the spec
  // path. A section runs to the next heading of the same or a higher level.
  const headings = [...inventory.matchAll(/^(#{1,3}) (.+)$/gm)];
  const sections = new Map();
  headings.forEach((heading, index) => {
    const level = heading[1].length;
    const start = heading.index + heading[0].length;
    let end = inventory.length;
    for (const next of headings.slice(index + 1)) {
      if (next[1].length <= level) { end = next.index; break; }
    }
    const name = /^`([^`]+)`$/.exec(heading[2])?.[1];
    if (level === 3 && name) sections.set(name, inventory.slice(start, end));
  });
  return sections;
}

export function inventoryTags(section) {
  const declared = /^\| Tags \| (.+) \|$/m.exec(section)?.[1];
  if (!declared) throw new Error('the inventory section has no Tags row');
  return declared.match(/@[a-z-]+/g) ?? [];
}

export function invocationTags(tags) {
  return tags.filter((tag) => deployedInvocationTag.test(tag)).sort();
}
