import { expect, login, test } from './support/fixtures.js';
import { declareNoBusinessCleanup } from './support/attempt-cleanup-registry.js';
import { requireEnvironment } from './support/account.js';
import { isServiceJsonResponse, sanitizedServiceErrorCode } from './support/service-json-response.mjs';

// Issue #129 could only be read from CloudWatch because a failing first attempt
// left no trace: the global configuration records one on the first retry, which
// is the second attempt. The profile binding is what this test exists to
// observe, so this file records a trace for every attempt and keeps the failed
// one. `test.use` is file-scoped and top-level because it forces its own worker,
// and the scope is deliberately this file only so no other scenario inherits the
// trace setting or pays for that worker.
test.use({ trace: 'retain-on-failure' });

test.describe('Worker account smoke @smoke @regression @full-stack', () => {
  test('signs in and reaches the dashboard and wardrobe', async ({ page, workerAccount }, testInfo) => {
    // This attempt creates no business resources, so it declares that explicitly:
    // the worker-lease teardown then releases the address on a committed
    // declaration instead of quarantining an undeclared attempt.
    declareNoBusinessCleanup(testInfo, { teardownResult: 'passed', reason: 'this attempt creates no business resources' });

    // Observe the first profile read of this attempt's own synthetic identity.
    // The listener is registered before sign-in so that first `GET /users/me` is
    // never missed. It is a pure read of a row that already exists:
    // `provisionConfirmedTestAccount` created it through
    // `POST /identity-operations/provision` before sign-in (issue #230), so the
    // response is not the request that syncs the subject to a profile row, and
    // a non-200 here is a real binding failure rather than this attempt's own
    // write-on-read.
    const serviceOrigin = new URL(requireEnvironment('E2E_SERVICE_URL')).origin;
    const profile = page.waitForResponse((response) => (
      response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/users/me'
      && isServiceJsonResponse(response, serviceOrigin)
    ));

    await login(page, workerAccount);
    const response = await profile;
    const status = response.status();
    const error = status === 200 ? undefined : await sanitizedServiceErrorCode(response);
    await testInfo.attach('worker-profile-binding', {
      body: JSON.stringify({
        email: workerAccount.email,
        // The first status of the profile-binding request, and its Service error
        // vocabulary when it was refused. No body, message or token is recorded.
        profile: { status, ...(error ? { error } : {}) },
      }, null, 2),
      contentType: 'application/json',
    });
    expect(status, `the first profile read of ${workerAccount.email} must bind it`).toBe(200);

    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible({
      timeout: 10_000,
    });

    await page.goto('/wardrobe');
    await expect(page.getByRole('heading', { name: 'Wardrobe' })).toBeVisible({
      timeout: 10_000,
    });
  });
});
