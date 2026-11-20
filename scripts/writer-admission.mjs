import { pathToFileURL } from 'node:url';
import { parseStrictJson, repositories, requireId } from './evidence-contract.mjs';
import { ghApi, repositoryReadEnvironment } from './github-read.mjs';

// #344: the outbound half of the writer/starter pair. `AnyWear-Infra` is the single writer of
// Beta's served tuple and the single starter of automated qualifications, so a qualification
// that a human starts is admitted only when no Infra writer run is holding the tuple. The
// admission rule has one exact condition:
//
//   refuse only when a *successfully read* list of nonterminal Infra writer runs names a run
//   that is not the run in this dispatch's `dispatched_by`, while that run's hold job is
//   nonterminal.
//
// Everything else admits, and an unreadable list records a warning and admits: an operator
// diagnosing a failing writer must not be locked out by the failure of the writer under
// diagnosis. The automated dispatches are admitted by construction rather than by a second
// exemption path, because the Infra run that holds them is the run their `dispatched_by`
// names: `mutate.yml`'s `qualify-hold` job holds its `full`, and the scheduled entry's `hold`
// job holds its `reconcile`. The deploying run's own `full` is therefore exempt because it is
// named, not because it is special-cased here.
//
// The read is credential-free for AWS: it mints nothing itself, declares no environment and
// makes no cloud call. Its only input is one App installation token narrowed to
// `AnyWear-Infra` with `actions: read`, which the preflight step supplies as `GH_TOKEN`.
//
// Nothing here waits, polls or has a ceiling. `mutate.yml`'s own pre-mutation admission is
// the waiting half of the pair, in the other repository; this half answers once and refuses
// by name, so the operator waits on a run they were told about rather than on a timer.

export const INFRA_WRITER_REPOSITORY = repositories.infra;

// The five nonterminal workflow-run statuses the REST API documents. One read per workflow and
// status: a run is listed under exactly one of them, so this closed set is the whole query.
export const NONTERMINAL_RUN_STATUSES = Object.freeze([
  'requested',
  'waiting',
  'pending',
  'queued',
  'in_progress',
]);

// The Infra hold-job contract (§7 of ADR-0033). A writer run holds the served tuple while its
// hold job exists and that job has not reached `completed`. The job name is the only
// per-workflow fact this read needs, and it is the reviewed contract with the other
// repository's workflows.
export const INFRA_WRITER_HOLD_JOBS = Object.freeze({
  'mutate.yml': 'qualify-hold',
  'schedule.yml': 'hold',
});

export const RUN_PAGE_SIZE = 100;

const TERMINAL_JOB_STATUS = 'completed';
const WORKFLOW_DIRECTORY = '.github/workflows';
const describe = (value) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};
const readFailure = (error) => String(error?.message ?? error).split('\n')[0];

const writerRunUrl = new RegExp(`^https://github\\.com/${INFRA_WRITER_REPOSITORY}/actions/runs/([1-9]\\d*)$`);

function requireWriterWorkflow(workflow) {
  if (typeof workflow !== 'string' || !Object.hasOwn(INFRA_WRITER_HOLD_JOBS, workflow)) {
    throw new Error(`${describe(workflow)} is not an AnyWear-Infra writer workflow`);
  }
  return workflow;
}

function requireWriterRunUrl(value, label) {
  const match = typeof value === 'string' ? writerRunUrl.exec(value) : null;
  if (!match) throw new Error(`${label} is not an AnyWear-Infra workflow run URL`);
  return { url: value, id: Number(match[1]) };
}

// One workflow-runs read, bounded to a single page. The query is scoped twice: the workflow
// path is server-side, and the status is the one list this read asked for.
export function writerRunsApiPath(workflow, status, repository = INFRA_WRITER_REPOSITORY) {
  requireWriterWorkflow(workflow);
  if (!NONTERMINAL_RUN_STATUSES.includes(status)) throw new Error(`${describe(status)} is not a nonterminal workflow-run status`);
  return `repos/${repository}/actions/workflows/${workflow}/runs?status=${status}&per_page=${RUN_PAGE_SIZE}`;
}

export function writerRunJobsApiPath(run, repository = INFRA_WRITER_REPOSITORY) {
  if (!run || typeof run !== 'object') throw new Error('An AnyWear-Infra writer run is required');
  return `repos/${repository}/actions/runs/${requireId(run.id, 'AnyWear-Infra writer run id')}/jobs?per_page=${RUN_PAGE_SIZE}`;
}

// A list counts as successfully read only when it is the documented run-list document and
// every entry names one run of the workflow that was queried. Anything else is an unreadable
// list, which the caller turns into a warning rather than into evidence of a holder.
export function parseWriterRuns(bytes, workflow) {
  requireWriterWorkflow(workflow);
  const payload = parseStrictJson(bytes);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.workflow_runs)) {
    throw new Error(`The ${workflow} run list is not a workflow-run list`);
  }
  return payload.workflow_runs.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`The ${workflow} run list contains a run that is not an object`);
    }
    const id = requireId(entry.id, `A run id in the ${workflow} run list`);
    const fromUrl = requireWriterRunUrl(entry.html_url, `A run in the ${workflow} run list`);
    if (id !== fromUrl.id) throw new Error(`The ${workflow} run ${fromUrl.url} names run ${describe(id)}`);
    if (entry.path !== `${WORKFLOW_DIRECTORY}/${workflow}`) {
      throw new Error(`The run ${fromUrl.url} belongs to ${describe(entry.path)}, not ${workflow}`);
    }
    return { id, url: fromUrl.url, workflow, holdJob: INFRA_WRITER_HOLD_JOBS[workflow] };
  });
}

export function parseWriterJobs(bytes, run) {
  const payload = parseStrictJson(bytes);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.jobs)) {
    throw new Error(`The job list of ${run?.url ?? 'an AnyWear-Infra writer run'} is not a job list`);
  }
  return payload.jobs;
}

// The hold rule itself: the named job exists and has not reached a terminal state. A job the
// run never created, and a job that already completed, both stop holding.
export function holdingJob(jobs, holdJob) {
  if (!Array.isArray(jobs)) throw new Error('An AnyWear-Infra writer run job list must be a list');
  return jobs.filter((job) => job && typeof job === 'object' && !Array.isArray(job) && job.name === holdJob)
    .find((job) => job.status !== TERMINAL_JOB_STATUS) ?? null;
}

// The refusal names the run that is holding the tuple, so the operator knows what to wait for
// or cancel, and it names the queued alternative, which waits for the writer in the same
// `anywear-infra-runtime` group instead of racing it.
export function writerRefusal({ url, holdJob, holdStatus }) {
  return `${url} is holding the Beta tuple: its ${holdJob} job is ${describe(holdStatus)}, so this qualification is not admitted while an AnyWear-Infra writer holds the served tuple. `
    + 'Wait for that run to finish, cancel it, or dispatch this qualification again after it concludes. '
    + `To queue behind the writer instead of being refused, dispatch ${INFRA_WRITER_REPOSITORY}'s schedule.yml with workflow_dispatch and operation=smoke (diagnostic) or operation=full (qualification): that entry shares the anywear-infra-runtime group, so it waits for the writer and then holds its own qualification to a terminal state.`;
}

/**
 * Read the nonterminal Infra writer runs and decide whether this qualification is admitted.
 *
 * `run` is the credential seam: it receives one GitHub REST path and returns the response
 * body, so a test injects a fixture and never touches the network. Without it the read uses
 * the shared `gh api` reader under the environment scoped to `AnyWear-Infra`, which is the
 * only repository this token may read.
 */
export async function evaluateWriterAdmission({ dispatchedBy = '', environment = process.env, run, warn = () => {} } = {}) {
  const warnings = [];
  const record = (message) => {
    warnings.push(message);
    warn(message);
  };

  let read = run;
  if (!read) {
    let scoped;
    try {
      scoped = repositoryReadEnvironment(INFRA_WRITER_REPOSITORY, environment);
    } catch (error) {
      record(`the ${INFRA_WRITER_REPOSITORY} reader token could not be scoped (${readFailure(error)}); admitting this qualification`);
      return { admitted: true, warnings, holder: null, refusal: null };
    }
    read = (path) => ghApi(path, false, scoped);
  }

  const examined = new Set();
  for (const [workflow, holdJob] of Object.entries(INFRA_WRITER_HOLD_JOBS)) {
    for (const status of NONTERMINAL_RUN_STATUSES) {
      let runs;
      try {
        runs = parseWriterRuns(await read(writerRunsApiPath(workflow, status)), workflow);
      } catch (error) {
        record(`the ${workflow} runs with status ${status} could not be read (${readFailure(error)}); admitting this qualification on that list`);
        continue;
      }
      for (const candidate of runs) {
        // The parent exemption: this dispatch's own writer run is the run that is holding it.
        if (candidate.url === dispatchedBy) continue;
        if (examined.has(candidate.url)) continue;
        examined.add(candidate.url);
        let jobs;
        try {
          jobs = parseWriterJobs(await read(writerRunJobsApiPath(candidate)), candidate);
        } catch (error) {
          record(`${candidate.url} job list could not be read (${readFailure(error)}); treating it as not holding`);
          continue;
        }
        const hold = holdingJob(jobs, holdJob);
        if (hold) {
          const holder = { url: candidate.url, workflow, holdJob, holdStatus: hold.status };
          return { admitted: false, warnings, holder, refusal: writerRefusal(holder) };
        }
      }
    }
  }
  return { admitted: true, warnings, holder: null, refusal: null };
}

const USAGE = `Usage: node scripts/writer-admission.mjs [--dispatched-by <url>]

Reads the nonterminal AnyWear-Infra writer runs (mutate.yml and the scheduled entry) across
requested, waiting, pending, queued and in_progress, and admits this qualification unless one
of them is a foreign run whose hold job (qualify-hold or hold) is nonterminal. It fails open
with a warning when a list or a run's job list cannot be read, and it refuses by naming the
holding run and the queued alternative. It makes no AWS call, holds no environment and writes
nothing.
`;

export function writerAdmissionArguments(argv = []) {
  if (argv.includes('--help')) return { help: true };
  let dispatchedBy = '';
  let seen = false;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (flag !== '--dispatched-by') throw new Error(`Unknown writer-admission argument ${describe(flag)}`);
    if (seen) throw new Error('Duplicate writer-admission argument --dispatched-by');
    const value = argv[index + 1];
    if (typeof value !== 'string') throw new Error('Writer-admission argument --dispatched-by requires a value');
    dispatchedBy = value;
    seen = true;
  }
  return { dispatchedBy };
}

export async function runWriterAdmission({
  argv = process.argv.slice(2), environment = process.env, run,
  write = (text) => process.stdout.write(text), writeError = (text) => process.stderr.write(text),
} = {}) {
  let options;
  try {
    options = writerAdmissionArguments(argv);
  } catch (error) {
    writeError(`${readFailure(error)}\n${USAGE}`);
    return 1;
  }
  if (options.help) {
    write(USAGE);
    return 0;
  }
  const result = await evaluateWriterAdmission({
    dispatchedBy: options.dispatchedBy,
    environment,
    run,
    warn: (message) => write(`::warning title=Infra writer admission::${message}\n`),
  });
  if (!result.admitted) {
    write(`::error title=Infra writer holds the Beta tuple::${result.refusal}\n`);
    return 1;
  }
  write(result.warnings.length === 0
    ? 'Admitted: no AnyWear-Infra writer run is holding the Beta tuple.\n'
    : 'Admitted with warnings: at least one writer run list or job list could not be read.\n');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runWriterAdmission();
}
