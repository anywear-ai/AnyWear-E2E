import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CLEANUP_VERSION_ARN } from '../tests/support/service-cleanup-operation.ts';
import { parseStrictJson } from './evidence-contract.mjs';
import { CREDENTIAL_REGION, RUNTIME_STACK_NAME, TERMINAL_STACK_STATUSES } from './platform-entrypoints.mjs';

// #287: the one reader of the cleanup capability version ARN.
//
// `AnyWear-Infra` publishes the version ARN its current `AnyWearRuntimeStack-beta` template
// creates as a stack output; this repository reads that publication instead of a stored copy
// (ADR-0022 §Publication and read of the version ARN). The read is one rule for the `full`,
// `smoke` and `reconcile` entries:
//
//   - describe `AnyWearRuntimeStack-beta` with the qualification role's existing
//     `cloudformation:DescribeStacks` grant;
//   - require the stack to be in a terminal success status, because a stack mid-update cannot
//     state which version it publishes;
//   - select the single output **value** matching the reviewed version-ARN grammar
//     (`CLEANUP_VERSION_ARN` in `tests/support/service-cleanup-operation.ts`, the one source of
//     that grammar). The output's physical key is CDK-generated and is never read, only
//     reported;
//   - refuse, naming the value (or `<absent>`) and the stack plus the grammar, when the value is
//     absent, malformed, ambiguous or the stack is absent or in flight.
//
// `resolve` pins the value once per credentialed job and prints the ARN to stdout only.
// `gate` compares a pinned value with a fresh read and refuses with `drift` (naming both ARNs),
// or with the same `unset`/`malformed`/`absent`/`in-flight`/`ambiguous` reasons. The teardown and
// `reconcile` pass `cleanupStartGuard` into `runCleanupOperation`, so the same comparison runs
// before every new `StartExecution` and never before a resume or a verify.
export const CAPABILITY_VERSION_ENV = 'BETA_CLEANUP_STATE_MACHINE_VERSION_ARN';

/**
 * The closed refusal vocabulary. Every refusal names its reason, so a run's failure states what
 * the deployment did not publish rather than only that the run stopped.
 */
export const REFUSAL_REASONS = Object.freeze(['unset', 'malformed', 'absent', 'in-flight', 'ambiguous', 'drift']);

const CAPABILITY_READ_TIMEOUT_MS = 60_000;
const CAPABILITY_READ_MAX_BYTES = 1024 * 1024;

/** The value a refusal shows in place of an absent one. */
const ABSENT = '<absent>';

function shownValue(value) {
  const values = Array.isArray(value) ? value : [value];
  const present = values.filter((entry) => typeof entry === 'string' && entry.length > 0);
  return present.length === 0 ? ABSENT : present.map((entry) => JSON.stringify(entry)).join(', ');
}

/**
 * The refusal a value or a publication raises.
 *
 * The message always carries the reason, the value (or `<absent>`), the stack the read was bound
 * to and the grammar that was applied, so an operator can act on it without reading this file.
 */
export class CleanupCapabilityRefusal extends Error {
  constructor(reason, { value, detail } = {}) {
    if (!REFUSAL_REASONS.includes(reason)) throw new Error(`Unknown cleanup capability refusal reason: ${reason}`);
    super(`Cleanup capability version refused (${reason}): value=${shownValue(value)}; stack=${RUNTIME_STACK_NAME}; `
      + `grammar=${CLEANUP_VERSION_ARN.source}${detail ? `; ${detail}` : ''}`);
    this.name = 'CleanupCapabilityRefusal';
    this.code = 'E2E_CLEANUP_CAPABILITY_REFUSED';
    this.reason = reason;
    this.stack = RUNTIME_STACK_NAME;
    this.grammar = CLEANUP_VERSION_ARN.source;
    if (value !== undefined) this.value = value;
  }
}

/**
 * The live seam, in the shape `scripts/infra-observation.mjs` established: `aws` is the CLI this
 * job already holds a credential for, every read is a bounded subprocess, and `execute` is
 * injectable so the selection and gate logic is unit-tested without AWS.
 */
export function liveCapabilityIo({ execute = execFileSync, environment = process.env } = {}) {
  return {
    aws(args, region = CREDENTIAL_REGION) {
      let stdout;
      try {
        stdout = execute('aws', [...args, '--region', region, '--output', 'json', '--no-cli-pager'], {
          encoding: 'utf8', timeout: CAPABILITY_READ_TIMEOUT_MS, maxBuffer: CAPABILITY_READ_MAX_BYTES,
          stdio: ['ignore', 'pipe', 'pipe'], env: environment,
        });
      } catch (error) {
        const detail = (error.stderr?.toString?.() || error.message || String(error))
          .trim().split('\n').slice(0, 4).join(' ');
        throw new Error(`AWS read failed for ${args.join(' ')}: ${detail}`, { cause: error });
      }
      return stdout.trim() ? parseStrictJson(stdout) : {};
    },
  };
}

/**
 * Select the one published version ARN from `cloudformation describe-stacks` rows.
 *
 * Pure: the rows are the AWS CLI response's `Stacks` array and the only input. Selection is by
 * output **value** against the one reviewed grammar, so a renamed output key still selects; the
 * key is reported for the run summary and is not part of the decision.
 */
export function selectVersionPublication(stacks) {
  const rows = Array.isArray(stacks) ? stacks : [];
  const named = rows.filter((row) => row?.StackName === RUNTIME_STACK_NAME);
  if (named.length === 0) {
    throw new CleanupCapabilityRefusal('absent', {
      detail: rows.length === 0
        ? 'the deployment publishes no such stack'
        : `observed stacks: ${rows.map((row) => row?.StackName ?? '<unnamed>').join(', ')}`,
    });
  }
  if (named.length > 1) {
    throw new CleanupCapabilityRefusal('ambiguous', {
      value: named.map((row) => row.StackId ?? row.StackName),
      detail: `describe-stacks returned ${named.length} rows for the one publisher`,
    });
  }
  const stack = named[0];
  if (!TERMINAL_STACK_STATUSES.includes(stack.StackStatus)) {
    throw new CleanupCapabilityRefusal('in-flight', {
      detail: `stack status ${JSON.stringify(stack.StackStatus ?? null)} is not one of ${TERMINAL_STACK_STATUSES.join(', ')}`,
    });
  }
  const outputs = Array.isArray(stack.Outputs) ? stack.Outputs : [];
  const values = outputs.map((output) => output?.OutputValue).filter((value) => typeof value === 'string');
  const matches = values.filter((value) => CLEANUP_VERSION_ARN.test(value));
  if (matches.length > 1) {
    throw new CleanupCapabilityRefusal('ambiguous', {
      value: matches,
      detail: `the stack published ${matches.length} output values matching the grammar; the capability has one publisher`,
    });
  }
  if (matches.length === 0) {
    // A published value that names a state machine but fails the grammar is malformed, and is
    // detected by its value alone: the decision never reads the CDK-generated output key.
    const malformed = values.filter((value) => /stateMachine/.test(value));
    if (malformed.length > 0) {
      throw new CleanupCapabilityRefusal('malformed', {
        value: malformed,
        detail: malformed.length > 1 ? 'several published values name a state machine' : 'the published value is not a version ARN',
      });
    }
    const observed = outputs.map((output) => output?.OutputKey).filter((key) => typeof key === 'string');
    throw new CleanupCapabilityRefusal('absent', {
      detail: observed.length === 0
        ? 'the stack declares no outputs'
        : `the stack published no output value matching the grammar (observed output keys: ${observed.join(', ')})`,
    });
  }
  const versionArn = matches[0];
  const source = outputs.find((output) => output?.OutputValue === versionArn);
  return {
    versionArn,
    stackName: RUNTIME_STACK_NAME,
    outputKey: typeof source?.OutputKey === 'string' ? source.OutputKey : '<unnamed>',
  };
}

/** Read `AnyWearRuntimeStack-beta` and select its published version ARN. */
export async function readVersionPublication(io) {
  const response = await io.aws(['cloudformation', 'describe-stacks', '--stack-name', RUNTIME_STACK_NAME]);
  const stacks = response?.Stacks;
  if (!Array.isArray(stacks)) throw new Error(`CloudFormation describe-stacks for ${RUNTIME_STACK_NAME} returned no readable stack list`);
  return selectVersionPublication(stacks);
}

/** The published version ARN alone, which is what `resolve` prints. */
export async function resolveVersionArn(io) {
  return (await readVersionPublication(io)).versionArn;
}

/**
 * Compare a pinned value with the publication read now.
 *
 * The pin is validated before the read, so a run refuses an unusable pin even when AWS answers
 * slowly or not at all. A pin the stack no longer publishes is `drift`, and the refusal names
 * both ARNs.
 */
export async function gateVersionArn(pinned, io) {
  const value = typeof pinned === 'string' ? pinned : '';
  if (value === '') throw new CleanupCapabilityRefusal('unset', { value });
  if (!CLEANUP_VERSION_ARN.test(value)) throw new CleanupCapabilityRefusal('malformed', { value });
  const publication = await readVersionPublication(io);
  if (publication.versionArn !== value) {
    throw new CleanupCapabilityRefusal('drift', {
      value,
      detail: `the stack publishes ${JSON.stringify(publication.versionArn)} now`,
    });
  }
  return publication;
}

/**
 * The start guard the teardown and `reconcile` pass into `runCleanupOperation`.
 *
 * It re-applies the same comparison immediately before each new execution start, so a
 * superseded-but-still-published version never binds a deterministic execution name to a
 * definition pair later dispatches cannot verify.
 */
export function cleanupStartGuard({ environment = process.env, io } = {}) {
  const capabilityIo = io ?? liveCapabilityIo({ environment });
  return async () => await gateVersionArn(environment[CAPABILITY_VERSION_ENV], capabilityIo);
}

/**
 * Append the resolved value and where it came from to the run's step summary.
 *
 * The value is the run's own pinned ARN and the source is the stack output key the stack
 * published it under — reported, never selected by. Outside GitHub Actions (no
 * `GITHUB_STEP_SUMMARY`) nothing is written.
 */
export function appendResolutionSummary(publication, environment = process.env) {
  const path = environment.GITHUB_STEP_SUMMARY;
  if (typeof path !== 'string' || path.length === 0) return false;
  appendFileSync(path, [
    '### Resolved cleanup capability version',
    '',
    `- Version ARN: \`${publication.versionArn}\``,
    `- Read from: \`${publication.stackName}\` output \`${publication.outputKey}\``,
    '',
  ].join('\n'));
  return true;
}

/**
 * The command surface, injectable so the CLI contract itself is unit-tested.
 *
 * `resolve` prints the ARN to stdout and nothing else there; `gate` prints one confirmation
 * line. A refusal — from either command — goes to stderr and returns a non-zero exit code, and
 * the nonzero result means the step that ran it fails. Nothing is written to stdout on a
 * refusal, so a caller that captures the value with `$(...)` never receives a partial value.
 */
export async function runCapabilityCli(argv, {
  environment = process.env, io, write = (text) => process.stdout.write(text),
  writeError = (text) => process.stderr.write(text),
} = {}) {
  const [command] = argv;
  const capabilityIo = io ?? liveCapabilityIo({ environment });
  try {
    if (command === 'resolve') {
      const publication = await readVersionPublication(capabilityIo);
      appendResolutionSummary(publication, environment);
      write(`${publication.versionArn}\n`);
      return 0;
    }
    if (command === 'gate') {
      const publication = await gateVersionArn(environment[CAPABILITY_VERSION_ENV], capabilityIo);
      write(`Pinned cleanup capability version ${publication.versionArn} is the one ${publication.stackName} publishes.\n`);
      return 0;
    }
    throw new Error('Usage: node scripts/cleanup-capability.mjs <resolve|gate>');
  } catch (error) {
    writeError(`${error instanceof Error ? error.message : 'Cleanup capability resolution failed'}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCapabilityCli(process.argv.slice(2));
}
