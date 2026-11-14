import { expect, login, test } from './support/fixtures.js';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { assertE2EExecution } from '../scripts/execution-guard.mjs';
import { requireEnvironment } from './support/account.js';
import { CLIENT_VERSION_HEADERS } from './support/client-version.js';
import {
  DirectTeardown,
  quarantinesScope,
  type ProductResult,
  type ResourceRef,
} from './support/cleanup-operation.js';
import {
  readServiceJson,
  serviceOriginOf,
  serviceResponseMatcher,
} from './support/service-json-response.mjs';

const uploadFixture = fileURLToPath(new URL('./fixtures/dummy.png', import.meta.url));

// The platform's recovery floor for virtual try-on, from the deployed Service task runtime
// policy at Service source commit
// `340df8cb79a878521b2a53fc3c2a2db09bbc9779` (`src/tasks/runtime-policy.json`): the vto queue
// declares a **900 s** visibility with a **180 s** database lease, so work a worker
// replacement interrupted cannot be redelivered and claimed before the longer of the two,
// 900,000 ms. The sizing documentation restated this floor as 960 s from a 960 s database
// lease; the deployed policy's vto database lease is 180 s, so the 900 s queue visibility is
// the binding value and 900 s is the floor this scenario must outlast.
const VTO_RECOVERY_FLOOR_MS = 900_000;

// The terminal wait is a bound on that floor, not a measurement of observed provider
// latency. A shorter wait gives up before the platform is allowed to redeliver the work it
// interrupted, and then reports the platform's own recovery as a product failure, which is
// exactly what issue #147 recorded. The budget stays a local constant of this scenario
// rather than a support module, because no other scenario waits on this task type.
const VTO_TERMINAL_WAIT_MS = 1_200_000;
if (!Number.isSafeInteger(VTO_TERMINAL_WAIT_MS) || VTO_TERMINAL_WAIT_MS <= VTO_RECOVERY_FLOOR_MS) {
  throw new Error(`The VTO terminal wait of ${VTO_TERMINAL_WAIT_MS} ms does not outlast the platform recovery floor of ${VTO_RECOVERY_FLOOR_MS} ms; a shorter wait reports the platform's own recovery as a product failure`);
}

interface WardrobeItem {
  id: string;
  name: string | null;
  category: string;
  taggingStatus: string;
  taggingStateVersion: number;
}

interface Generation {
  generation_id: string;
  status: string;
  state_version: number;
  // The reads identify the generation's image by the image's uuid and carry a URL that
  // the Service signs at read time; a generation that is still running or that failed
  // has both members null.
  imageId: string | null;
  url: string | null;
  error_message?: string | null;
}

test.describe('Virtual try-on @regression @full-stack', () => {
  // This scenario spends real provider work: one upload, one auto-tagging call and one VTO
  // generation per attempt. A failed attempt must not be repeated automatically; a leftover is
  // resolved by the reconcile operation inside its 24-hour bound.
  test.describe.configure({ retries: 0 });

  let teardown: DirectTeardown | undefined;
  // The bearer header this attempt authenticated with; never persisted.
  let authorization: string | undefined;
  // The refs captured as they were created, replayed into the attempt's own teardown.
  let captured: ResourceRef[] = [];
  let productResult: ProductResult = 'skipped';

  // A stable numeric lease generation per attempt keeps every retry on a fresh
  // lease fence while staying reproducible within one attempt.
  const leaseGenerationFor = (seed: string) => (parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 6), 16) % 2_000_000) + 1;

  test.beforeEach(async ({ page, workerAccount }, testInfo) => {
    requireEnvironment('USER_POOL_ID');
    requireEnvironment('VITE_COGNITO_CLIENT_ID');
    requireEnvironment('E2E_SERVICE_URL');
    authorization = undefined;
    captured = [];
    productResult = 'skipped';
    // Register before the first business side effect, on a scope unique to this
    // attempt so a retry always allocates a fresh operation and lease generation.
    teardown = new DirectTeardown({
      runScope: requireEnvironment('E2E_CLEANUP_RUN_SCOPE'),
      testScope: 'vto.spec.ts::generates-one-single-garment-try-on-end-to-end',
      retryIndex: testInfo.retry,
      leaseId: randomUUID(),
      leaseGeneration: leaseGenerationFor(`${workerAccount.email}:${testInfo.retry}:${randomUUID()}`),
      expectedUsername: workerAccount.email,
      expectedEmail: workerAccount.email,
      serviceUrl: requireEnvironment('E2E_SERVICE_URL'),
      request: page.request,
      // This attempt's own key: the worker-lease teardown that runs after
      // `afterEach` reads this attempt's business-cleanup outcome from it.
      testInfo,
    });
    await teardown.register();
    // Obtain the real Client's bearer header without persisting a token or browser
    // state. Fixture leasing and protected account cleanup remain the identity owners.
    const authorized = page.waitForRequest(request => new URL(request.url()).pathname === '/users/me'
      && request.headers().authorization !== undefined);
    await login(page, workerAccount);
    authorization = (await authorized).headers().authorization;
    // The owner binds only after Cognito confirmation, and only to this subject.
    if (!workerAccount.subject) throw new Error('Login did not capture the confirmed Cognito subject');
    await teardown.bindOwner(workerAccount.subject);
  });

  // Playwright requires the first hook argument to destructure fixtures. This
  // teardown needs none now that the absence read-back lives inside `finalize`.
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the object destructuring pattern.
  test.afterEach(async ({}, testInfo) => {
    if (!teardown) return;
    // A failed product assertion is reported as `failed`; an unrun body is `skipped`.
    if (productResult === 'skipped') {
      productResult = testInfo.status === testInfo.expectedStatus ? 'skipped' : 'failed';
    }
    for (const { kind, id } of captured) teardown.capture(kind, id);
    // `finalize` is the only terminal entry point: it deletes the captured refs in
    // schema order, reads every one of them back, and only then writes the single
    // acknowledgement. It also closes the declaration when nothing was captured or
    // when this attempt holds no bearer token, so there is no second call site.
    const result = await teardown.finalize(productResult, authorization);

    // A teardown failure fails the separate teardown gate without rewriting the product
    // outcome, and quarantines the scope so the next attempt is fresh.
    if (quarantinesScope(result.teardown_result)) {
      expect(result.scope_state, result.quarantine_reason ?? 'teardown quarantined its scope').toBe('quarantined');
      throw new Error(`Teardown gate failed (${result.teardown_result}): ${result.quarantine_reason ?? 'unknown'}`);
    }
  });

  test('generates one single-garment try-on end to end', async ({ page }) => {
    // Auto-tagging and the VTO generation run behind the provider on the deployed platform.
    // The bound covers the tagging completion wait, the VTO recovery floor and the
    // browser-side render; it is not a latency SLA.
    test.setTimeout(2_000_000);

    const serviceUrl = requireEnvironment('E2E_SERVICE_URL');
    const serviceOrigin = serviceOriginOf(serviceUrl);
    const serviceJson = (criteria: { method: string; path?: string }) => serviceResponseMatcher(serviceOrigin, criteria);
    const headers = { ...CLIENT_VERSION_HEADERS, Authorization: authorization! };
    const credit = async () => {
      const response = await page.request.get(`${serviceUrl}/users/me`, { headers });
      expect(response.status()).toBe(200);
      return Number((await readServiceJson<{ dailyCredits: number }>(response)).dailyCredits);
    };

    // Confirm the baseline before the first paid side effect: the scenario asserts exactly
    // one debit from this value, so a pre-existing debit cannot be mistaken for its own.
    const baselineCredits = await credit();
    expect(Number.isInteger(baselineCredits)).toBe(true);
    expect(baselineCredits).toBeGreaterThan(0);

    // Create the garment through the real Client wardrobe flow. Auto-tagging names it, so
    // the item's own terminal body carries the label the Mirror selector will list.
    const initialWardrobe = page.waitForResponse(serviceJson({ method: 'GET', path: '/wardrobe' }));
    await page.goto('/wardrobe');
    await expect(page.getByRole('heading', { name: 'Wardrobe' })).toBeVisible();
    expect((await initialWardrobe).status()).toBe(200);
    await page.getByRole('button', { name: 'Add Item' }).click();
    await expect(page.getByRole('heading', { name: 'Add Wardrobe Item' })).toBeVisible();
    await page.locator('input[type="file"][multiple]').setInputFiles(uploadFixture);
    const confirmed = page.waitForResponse(serviceJson({ method: 'POST', path: '/wardrobe/upload' }));
    await page.getByRole('button', { name: 'Upload & Auto-Tag' }).click();
    const confirmedResponse = await confirmed;
    expect(confirmedResponse.status()).toBe(202);
    const accepted = await readServiceJson<{ itemId: string; taggingStatus: string }>(confirmedResponse);
    expect(accepted.taggingStatus).toBe('processing');
    const garmentId = accepted.itemId;
    expect(garmentId).toBeTruthy();
    captured.push({ kind: 'wardrobe_item', id: garmentId });

    let latestItem: WardrobeItem | undefined;
    let lastTaggingVersion = 0;
    await expect.poll(async () => {
      const response = await page.request.get(`${serviceUrl}/wardrobe/items/${garmentId}`, { headers });
      expect(response.status()).toBe(200);
      latestItem = await readServiceJson<WardrobeItem>(response);
      expect(latestItem.id).toBe(garmentId);
      expect(latestItem.taggingStateVersion).toBeGreaterThanOrEqual(lastTaggingVersion);
      lastTaggingVersion = latestItem.taggingStateVersion;
      return latestItem.taggingStatus;
    }, { timeout: 600_000, intervals: [1_000, 2_000, 5_000] }).toBe('ready');
    const garmentLabel = latestItem!.name || latestItem!.category || 'wardrobe item';
    expect(garmentLabel).toBeTruthy();

    // Upload the base photo through the Mirror UI. The Client reserves and confirms the
    // upload itself and auto-selects the first photo, so the selection is asserted rather
    // than clicked blindly.
    await page.goto('/mirror');
    await expect(page.getByRole('heading', { name: 'The Mirror' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Upload', exact: true })).toBeVisible();
    const photoConfirmed = page.waitForResponse(serviceJson({ method: 'POST', path: '/vto/base-photos/upload' }));
    await page.locator('input[type="file"]').setInputFiles(uploadFixture);
    const photoResponse = await photoConfirmed;
    expect(photoResponse.status()).toBe(201);
    const basePhoto = await readServiceJson<{ id: string }>(photoResponse);
    expect(basePhoto.id).toBeTruthy();
    captured.push({ kind: 'base_photo', id: basePhoto.id });
    const basePhotoButton = page.getByRole('button', { name: /base photo 1/ });
    await expect(basePhotoButton).toHaveCount(1);
    await expect(basePhotoButton).toHaveAttribute('aria-pressed', 'true');

    // Select exactly the garment this attempt created. The selector is searched by the
    // generated label, and the single match is asserted before it is clicked.
    await page.getByPlaceholder('Search wearable items...').fill(garmentLabel);
    const garmentButton = page.getByRole('button', { name: `Select ${garmentLabel}`, exact: true });
    await expect(garmentButton).toHaveCount(1);
    await garmentButton.click();
    await expect(page.getByRole('button', { name: `Remove ${garmentLabel}`, exact: true }))
      .toHaveAttribute('aria-pressed', 'true');

    // Submit through the Client. The 202 body is the acceptance answer, and it names the
    // outfit the generation will be released through, so both are captured together.
    const generateButton = page.getByRole('button', { name: 'Generate try-on', exact: true });
    await expect(generateButton).toBeEnabled();
    const generationAccepted = page.waitForResponse(serviceJson({ method: 'POST', path: '/vto/generations' }));
    assertE2EExecution();
    await generateButton.click();
    const generationResponse = await generationAccepted;
    expect(generationResponse.status()).toBe(202);
    const generation = await readServiceJson<{ generation_id: string; outfit_id: string }>(generationResponse);
    expect(generation.generation_id).toBeTruthy();
    expect(generation.outfit_id).toBeTruthy();
    const generationId = generation.generation_id;
    captured.push({ kind: 'outfit', id: generation.outfit_id });
    captured.push({ kind: 'outfit_generation', id: generationId });

    // One debit is taken at acceptance.
    expect(baselineCredits - await credit()).toBe(1);

    let latestGeneration: Generation | undefined;
    let lastStateVersion = 0;
    // The budget is the platform's own recovery floor, never a measurement of observed
    // provider latency: a shorter wait gives up before the platform is allowed to
    // redeliver work a worker replacement interrupted, and then reports that recovery as
    // a product failure (issue #147). A `Failed` terminal state fails immediately instead
    // of waiting out the floor.
    await expect.poll(async () => {
      const response = await page.request.get(`${serviceUrl}/vto/generations/${generationId}`, { headers });
      expect(response.status()).toBe(200);
      latestGeneration = await readServiceJson<Generation>(response);
      expect(latestGeneration.generation_id).toBe(generationId);
      expect(latestGeneration.state_version).toBeGreaterThanOrEqual(lastStateVersion);
      lastStateVersion = latestGeneration.state_version;
      if (latestGeneration.status === 'Failed') {
        throw new Error(`VTO generation failed: ${latestGeneration.error_message ?? 'no error message'}`);
      }
      return latestGeneration.status;
    }, { timeout: VTO_TERMINAL_WAIT_MS, intervals: [1_000, 2_000, 5_000] }).toBe('Complete');

    // The terminal body identifies the generated image by its uuid and carries a URL
    // freshly signed at read time; retrieve it and assert real bytes.
    const terminal = latestGeneration!;
    expect(typeof terminal.imageId).toBe('string');
    const image = await page.request.get(String(terminal.url));
    expect(image.ok()).toBe(true);
    expect((await image.body()).length).toBeGreaterThan(0);

    // The Client's own result area renders the completed generation.
    await expect(page.getByRole('img', { name: 'Try-on result' })).toBeVisible({ timeout: 30_000 });

    // Terminal state takes no further debit: exactly one credit is spent by this attempt.
    expect(await credit()).toBe(baselineCredits - 1);
    // The product assertion stands on its own; teardown runs separately in afterEach.
    productResult = 'passed';
  });
});
