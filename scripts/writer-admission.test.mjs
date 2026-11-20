import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateWriterAdmission,
  holdingJob,
  INFRA_WRITER_HOLD_JOBS,
  NONTERMINAL_RUN_STATUSES,
  parseWriterJobs,
  parseWriterRuns,
  runWriterAdmission,
  writerAdmissionArguments,
  writerRunJobsApiPath,
  writerRunsApiPath,
} from './writer-admission.mjs';

// #344: the single-writer admission rule, exercised offline. Every read goes through the
// injected `run` seam, so no test reaches the network, mints a token or touches GitHub.

const INFRA = 'anywear-ai/AnyWear-Infra';
const runUrl = (id) => `https://github.com/${INFRA}/actions/runs/${id}`;
const runsPath = (workflow, status) => `repos/${INFRA}/actions/workflows/${workflow}/runs?status=${status}&per_page=100`;
const jobsPath = (id) => `repos/${INFRA}/actions/runs/${id}/jobs?per_page=100`;

const runEntry = (id, workflow = 'mutate.yml') => ({
  id,
  html_url: runUrl(id),
  path: `.github/workflows/${workflow}`,
});
const runList = (...runs) => JSON.stringify({ total_count: runs.length, workflow_runs: runs });
const jobList = (...jobs) => JSON.stringify({ total_count: jobs.length, jobs });

// A read seam over a fixture. A path a test does not name answers an empty run list, so each
// test states only the reads it means to exercise; `unreadable` names the paths that fail.
function reader({ runs = {}, jobs = {}, unreadable = [] } = {}) {
  const reads = [];
  const read = (path) => {
    reads.push(path);
    if (unreadable.includes(path)) throw new Error('HTTP 502 Bad Gateway');
    if (Object.hasOwn(jobs, path)) return jobs[path];
    if (Object.hasOwn(runs, path)) return runs[path];
    return runList();
  };
  read.reads = reads;
  return read;
}

// (a) The deploying run's own `full` is exempt by construction: its `dispatched_by` names the
// Infra run that is holding it, so that run is never a foreign holder even while its hold job
// is nonterminal.
test('a self-dispatched writer run is admitted while its own hold job is nonterminal', async () => {
  const parent = 101;
  const read = reader({
    runs: { [runsPath('mutate.yml', 'in_progress')]: runList(runEntry(parent)) },
    jobs: { [jobsPath(parent)]: jobList({ name: 'qualify-hold', status: 'in_progress' }) },
  });
  const result = await evaluateWriterAdmission({ dispatchedBy: runUrl(parent), run: read });

  assert.equal(result.admitted, true);
  assert.equal(result.holder, null);
  assert.equal(result.refusal, null);
  assert.deepEqual(result.warnings, []);
  // The exemption is applied before the job read, so the parent is never treated as a
  // candidate holder at all: there is no second exemption path behind the URL comparison.
  assert.equal(read.reads.includes(jobsPath(parent)), false, 'the parent run must not be read as a candidate holder');
});

// (b) A foreign nonterminal writer run whose hold job is nonterminal refuses, and the refusal
// names it and points at the queued alternative.
test('a foreign writer run with a nonterminal hold job refuses by name', async () => {
  const holder = 202;
  const read = reader({
    runs: { [runsPath('mutate.yml', 'in_progress')]: runList(runEntry(holder)) },
    jobs: { [jobsPath(holder)]: jobList({ name: 'deploy', status: 'completed' }, { name: 'qualify-hold', status: 'in_progress' }) },
  });
  const result = await evaluateWriterAdmission({ dispatchedBy: runUrl(101), run: read });

  assert.equal(result.admitted, false);
  assert.equal(result.holder.url, runUrl(holder));
  assert.equal(result.holder.holdJob, 'qualify-hold');
  assert.equal(result.holder.holdStatus, 'in_progress');
  // The first thing the operator reads is the run they have to wait for or cancel.
  assert.equal(result.refusal.startsWith(`${runUrl(holder)} is holding the Beta tuple`), true);
  assert.match(result.refusal, /its qualify-hold job is "in_progress"/);
  // The queued alternative: the Infra scheduled entry, which waits in the group.
  assert.match(result.refusal, /schedule\.yml/);
  assert.match(result.refusal, /operation=smoke/);
  assert.match(result.refusal, /operation=full/);
  assert.match(result.refusal, /anywear-infra-runtime/);
});

// The scheduled entry's hold job is `hold`, not `qualify-hold`; the map is the Infra contract
// and each workflow is judged by its own job name.
test('the scheduled entry holds through its hold job', async () => {
  const holder = 203;
  const read = reader({
    runs: { [runsPath('schedule.yml', 'waiting')]: runList(runEntry(holder, 'schedule.yml')) },
    jobs: { [jobsPath(holder)]: jobList({ name: 'hold', status: 'queued' }) },
  });
  const result = await evaluateWriterAdmission({ run: read });

  assert.equal(result.admitted, false);
  assert.equal(result.holder.holdJob, 'hold');
  assert.ok(result.refusal.includes(runUrl(holder)));
});

// (c) A nonterminal writer run whose hold job already completed, or that never created one,
// does not hold.
test('a nonterminal writer run whose hold job is terminal or absent admits', async () => {
  const terminal = 303;
  const absent = 304;
  const read = reader({
    runs: { [runsPath('mutate.yml', 'queued')]: runList(runEntry(terminal), runEntry(absent)) },
    jobs: {
      [jobsPath(terminal)]: jobList({ name: 'qualify-hold', status: 'completed' }),
      [jobsPath(absent)]: jobList({ name: 'verify', status: 'in_progress' }, { name: 'deploy', status: 'queued' }),
    },
  });
  const result = await evaluateWriterAdmission({ dispatchedBy: '', run: read });

  assert.equal(result.admitted, true);
  assert.deepEqual(result.warnings, []);
  assert.equal(holdingJob([{ name: 'qualify-hold', status: 'completed' }], 'qualify-hold'), null);
  assert.equal(holdingJob([{ name: 'deploy', status: 'in_progress' }], 'qualify-hold'), null);
});

// (d) Fail open: an unreadable run list warns and admits, and an unreadable job list warns
// about that run and treats it as not holding.
test('an unreadable run list or job list warns and admits', async () => {
  const listRead = reader({ unreadable: [runsPath('mutate.yml', 'in_progress')] });
  const listResult = await evaluateWriterAdmission({ run: listRead });
  assert.equal(listResult.admitted, true);
  assert.equal(listResult.warnings.length, 1);
  assert.match(listResult.warnings[0], /mutate\.yml runs with status in_progress could not be read/);
  assert.match(listResult.warnings[0], /HTTP 502/);
  assert.match(listResult.warnings[0], /admitting/);

  const unreadableRun = 404;
  const jobsRead = reader({
    runs: { [runsPath('schedule.yml', 'waiting')]: runList(runEntry(unreadableRun, 'schedule.yml')) },
    unreadable: [jobsPath(unreadableRun)],
  });
  const jobsResult = await evaluateWriterAdmission({ run: jobsRead });
  assert.equal(jobsResult.admitted, true);
  assert.equal(jobsResult.warnings.length, 1);
  assert.ok(jobsResult.warnings[0].includes(runUrl(unreadableRun)));
  assert.match(jobsResult.warnings[0], /treating it as not holding/);

  // A payload that is not the documented run list is not a successful read either.
  const malformedRead = reader({ runs: { [runsPath('mutate.yml', 'pending')]: JSON.stringify({ runs: [] }) } });
  const malformedResult = await evaluateWriterAdmission({ run: malformedRead });
  assert.equal(malformedResult.admitted, true);
  assert.equal(malformedResult.warnings.length, 1);
  assert.match(malformedResult.warnings[0], /not a workflow-run list/);
});

// (e) The query is exactly the five documented nonterminal statuses against exactly the two
// writer workflows, one request per pair.
test('the read queries exactly the five nonterminal statuses and both writer workflows', async () => {
  assert.deepEqual([...NONTERMINAL_RUN_STATUSES], ['requested', 'waiting', 'pending', 'queued', 'in_progress']);
  assert.deepEqual({ ...INFRA_WRITER_HOLD_JOBS }, { 'mutate.yml': 'qualify-hold', 'schedule.yml': 'hold' });

  const read = reader();
  const result = await evaluateWriterAdmission({ run: read });
  assert.equal(result.admitted, true);
  const expected = Object.keys(INFRA_WRITER_HOLD_JOBS)
    .flatMap((workflow) => NONTERMINAL_RUN_STATUSES.map((status) => runsPath(workflow, status)));
  assert.deepEqual(read.reads, expected, 'one read per workflow and status, and nothing else');
  assert.equal(expected.length, 10);
  // Both path builders are the documented REST endpoints, bounded to one page.
  assert.equal(writerRunsApiPath('mutate.yml', 'in_progress'), runsPath('mutate.yml', 'in_progress'));
  assert.equal(writerRunJobsApiPath({ id: 7 }), jobsPath(7));
  assert.throws(() => writerRunsApiPath('check.yml', 'queued'), /not an AnyWear-Infra writer workflow/);
  assert.throws(() => writerRunsApiPath('mutate.yml', 'completed'), /not a nonterminal workflow-run status/);
});

// (f) A manual dispatch names no dispatching run, so every holding writer run is foreign.
test('a manual dispatch with no dispatched_by is admitted only when no foreign holder exists', async () => {
  const holder = 505;
  const heldRead = reader({
    runs: { [runsPath('schedule.yml', 'in_progress')]: runList(runEntry(holder, 'schedule.yml')) },
    jobs: { [jobsPath(holder)]: jobList({ name: 'hold', status: 'in_progress' }) },
  });
  const refused = await evaluateWriterAdmission({ dispatchedBy: '', run: heldRead });
  assert.equal(refused.admitted, false);
  assert.ok(refused.refusal.includes(runUrl(holder)));
  assert.match(refused.refusal, /its hold job is "in_progress"/);

  const open = await evaluateWriterAdmission({ dispatchedBy: '', run: reader() });
  assert.equal(open.admitted, true);
});

test('a run naming an unknown workflow, another workflow or a mismatched URL is not a read', async () => {
  // The response must belong to the workflow that was queried: a run whose path names another
  // workflow cannot be judged by this workflow's hold job.
  assert.throws(() => parseWriterRuns(JSON.stringify({
    workflow_runs: [{ id: 11, html_url: runUrl(11), path: '.github/workflows/other.yml' }],
  }), 'mutate.yml'), /belongs to "\.github\/workflows\/other\.yml", not mutate\.yml/);
  // A URL that is not an Infra run URL cannot be compared with `dispatched_by`.
  assert.throws(() => parseWriterRuns(JSON.stringify({
    workflow_runs: [{ id: 12, html_url: 'https://github.com/anywear-ai/AnyWear-E2E/actions/runs/12', path: '.github/workflows/mutate.yml' }],
  }), 'mutate.yml'), /not an AnyWear-Infra workflow run URL/);
  // The URL and the id must name the same run, so the exemption cannot bind to another run's
  // URL than the one whose jobs were read.
  assert.throws(() => parseWriterRuns(JSON.stringify({
    workflow_runs: [{ id: 13, html_url: runUrl(14), path: '.github/workflows/mutate.yml' }],
  }), 'mutate.yml'), /names run 13/);
  assert.throws(() => parseWriterJobs(JSON.stringify({ jobs: {} }), { url: runUrl(15) }), /is not a job list/);
});

test('a run that is listed twice is judged once', async () => {
  const holder = 606;
  const read = reader({
    runs: {
      [runsPath('mutate.yml', 'requested')]: runList(runEntry(holder)),
      [runsPath('mutate.yml', 'queued')]: runList(runEntry(holder)),
    },
    jobs: { [jobsPath(holder)]: jobList({ name: 'qualify-hold', status: 'completed' }) },
  });
  const result = await evaluateWriterAdmission({ run: read });
  assert.equal(result.admitted, true);
  assert.equal(read.reads.filter((path) => path === jobsPath(holder)).length, 1, 'the holder job list is read once');
});

test('the command line refuses with an error annotation and admits with a warning annotation', async () => {
  const holder = 707;
  const held = reader({
    runs: { [runsPath('mutate.yml', 'in_progress')]: runList(runEntry(holder)) },
    jobs: { [jobsPath(holder)]: jobList({ name: 'qualify-hold', status: 'in_progress' }) },
  });
  const refusedOut = [];
  const refusedCode = await runWriterAdmission({
    argv: ['--dispatched-by', runUrl(101)], run: held, write: (text) => refusedOut.push(text), writeError: () => {},
  });
  assert.equal(refusedCode, 1);
  assert.match(refusedOut.join(''), /^::error title=Infra writer holds the Beta tuple::/m);
  assert.match(refusedOut.join(''), new RegExp(runUrl(holder)));

  const warnedOut = [];
  const warnedCode = await runWriterAdmission({
    argv: ['--dispatched-by', ''], run: reader({ unreadable: [runsPath('schedule.yml', 'queued')] }),
    write: (text) => warnedOut.push(text), writeError: () => {},
  });
  assert.equal(warnedCode, 0);
  assert.match(warnedOut.join(''), /::warning title=Infra writer admission::/);
  assert.match(warnedOut.join(''), /Admitted with warnings/);

  const admittedOut = [];
  assert.equal(await runWriterAdmission({ argv: [], run: reader(), write: (text) => admittedOut.push(text), writeError: () => {} }), 0);
  assert.equal(admittedOut.join(''), 'Admitted: no AnyWear-Infra writer run is holding the Beta tuple.\n');

  assert.deepEqual(writerAdmissionArguments([]), { dispatchedBy: '' });
  assert.deepEqual(writerAdmissionArguments(['--dispatched-by', runUrl(9)]), { dispatchedBy: runUrl(9) });
  const errors = [];
  assert.equal(await runWriterAdmission({ argv: ['--operation', 'full'], run: reader(), write: () => {}, writeError: (text) => errors.push(text) }), 1);
  assert.match(errors.join(''), /Unknown writer-admission argument "--operation"/);
});
