import { defineConfig, devices, type ReporterDescription } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));

function configuredWorkers(): number | undefined {
  const raw = process.env.E2E_WORKERS;
  if (raw === undefined) return process.env.CI ? 1 : undefined;
  const workers = Number(raw);
  if (!Number.isInteger(workers) || workers < 1 || workers > 8) {
    throw new Error('E2E_WORKERS must be an integer between 1 and 8');
  }
  return workers;
}

function validateAccountBudget(workers: number | undefined): void {
  if (workers === undefined) return;
  const maxActiveAccounts = Number(process.env.E2E_MAX_ACTIVE_ACCOUNTS ?? workers);
  // Same attempt arithmetic as `accountBudgetConfig` in tests/support/account-budget.ts:
  // `workers` parallel attempts plus Playwright's two CI retries per slot.
  const raw = process.env.E2E_MAX_NEW_ACCOUNTS_PER_RUN ?? String(workers * 3);
  const maxNewAccounts = Number(raw);
  if (!Number.isInteger(maxActiveAccounts) || maxActiveAccounts < workers) {
    throw new Error('E2E_MAX_ACTIVE_ACCOUNTS must be an integer at least E2E_WORKERS');
  }
  if (!Number.isInteger(maxNewAccounts) || maxNewAccounts < maxActiveAccounts) {
    throw new Error('E2E_MAX_NEW_ACCOUNTS_PER_RUN must be an integer at least E2E_WORKERS');
  }
}

dotenv.config({ path: path.join(repositoryRoot, '.env') });

const workers = configuredWorkers();
validateAccountBudget(workers);

// #358: the gate run keeps its own Playwright JSON report for a reader. The report is written
// only where the gate workflow declares a path for it, and never by `playwright test --list`:
// discovery calls no test, so it must not produce — or overwrite — the report a run is read
// from. `pnpm test` keeps its exact command line, so the report path travels through the job
// environment rather than a reporter flag.
const gateReportPath = process.env.E2E_REPORT_PATH;
const listOnly = process.argv.includes('--list');
const reporter: ReporterDescription[] = process.env.CI
  ? [['github'], ['html', { open: 'never' }]]
  : [['list'], ['html', { open: 'never' }]];
if (gateReportPath && !listOnly) reporter.push(['json', { outputFile: gateReportPath }]);

export default defineConfig({
  testDir: './tests',
  globalSetup: './tests/support/deployed-environment.ts',
  outputDir: process.env.E2E_PLAYWRIGHT_OUTPUT_DIR ?? 'test-results',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers,
  reporter,
  use: {
    baseURL: process.env.E2E_CLIENT_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
