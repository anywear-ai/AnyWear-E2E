import { expect, login, test } from './support/fixtures.js';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import type { Page, Request } from '@playwright/test';
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

/**
 * One outfit as both composition paths' read model reports it.
 *
 * `latestGeneration` and `look` are the two null members that make a saved-without-look
 * outfit the never-generated state, and `generationCount` is the outfit's own
 * `outfit_generations` row count: a second compose of one item set either appends a row
 * to the outfit that set already has or creates a second outfit, and never both.
 */
interface Outfit {
  id: string;
  name: string | null;
  wearableItems: { id: string }[];
  latestGeneration: { id: string; status: string } | null;
  look: { generationId: string; url: string | null } | null;
  generationCount: number;
}

/** The room `GET /fitting-rooms` opened; the scenario itself creates no room. */
interface FittingRoom {
  id: string;
  name: string;
  isDefault: boolean;
  itemCount: number;
}

/** A Service response predicate scoped to one origin, for one method and path. */
type ServiceJson = (criteria: { method: string; path?: string }) => ReturnType<typeof serviceResponseMatcher>;

/** The Service response predicate every waiter in this file uses. */
function serviceJsonFor(serviceUrl: string): ServiceJson {
  const serviceOrigin = serviceOriginOf(serviceUrl);
  return (criteria) => serviceResponseMatcher(serviceOrigin, criteria);
}

/**
 * The caller's daily credit balance, read straight from the profile endpoint.
 *
 * It is read before the first paid step of every attempt, so a pre-existing debit can
 * never be mistaken for one this attempt made.
 */
async function dailyCredits(page: Page, serviceUrl: string, headers: Record<string, string>): Promise<number> {
  const response = await page.request.get(`${serviceUrl}/users/me`, { headers });
  expect(response.status()).toBe(200);
  return Number((await readServiceJson<{ dailyCredits: number }>(response)).dailyCredits);
}

/**
 * Create one garment through the real Client wardrobe flow and wait for auto-tagging to
 * reach terminal `ready`.
 *
 * Auto-tagging names the item, so the item's own terminal body carries the label the
 * Fitting Room's `Wardrobe` area lists; `ready` is also what gives the item the stored
 * image the save path requires of every member.
 */
async function uploadTaggedGarment(
  page: Page,
  serviceUrl: string,
  serviceJson: ServiceJson,
  headers: Record<string, string>,
): Promise<{ id: string; label: string }> {
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
  return { id: garmentId, label: garmentLabel };
}

/**
 * Open the Fitting Room and return the room the page opened.
 *
 * `GET /fitting-rooms` is the creating read: a caller with no room is given one in this
 * same response, so entering the tab needs no creation step and this file sends no
 * `POST /fitting-rooms`. The default room is first in the Service's order, and the two
 * areas it renders are named regions whose headings are exactly `Wardrobe` and
 * `To try on`; the scenarios scope every locator to one of them.
 */
async function openFittingRoom(page: Page, serviceJson: ServiceJson): Promise<FittingRoom> {
  const roomsResponse = page.waitForResponse(serviceJson({ method: 'GET', path: '/fitting-rooms' }));
  await page.goto('/fitting-room');
  await expect(page.getByRole('heading', { name: 'Fitting Room', level: 1 })).toBeVisible();
  const response = await roomsResponse;
  expect(response.status()).toBe(200);
  const { fittingRooms } = await readServiceJson<{ fittingRooms: FittingRoom[] }>(response);
  expect(fittingRooms.length).toBeGreaterThanOrEqual(1);
  const [opened] = fittingRooms;
  expect(opened.isDefault).toBe(true);
  await expect(page.getByRole('region', { name: 'Wardrobe' }).getByRole('heading', { name: 'Wardrobe', level: 2 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'To try on' }).getByRole('heading', { name: 'To try on', level: 2 })).toBeVisible();
  return opened;
}

/** The room's `To try on` region: the staged list, its ticks and its removal control. */
function toTryOnArea(page: Page) {
  return page.getByRole('region', { name: 'To try on' });
}

/**
 * Stage one piece in `To try on` and tick it there.
 *
 * The two steps are two different actions on the delivered surface and both are
 * assertions: the `Wardrobe` area's `Add <name> to try on` stages a piece without ticking
 * it, and the staged row's own `Select <name>` control is what ticks it. The tick is then
 * read back through the same control's `Deselect` name and `aria-pressed` state, and the
 * `N / 5` counter says the tick sits inside the per-try-on bound.
 */
async function stageAndSelect(page: Page, label: string): Promise<void> {
  const addToTryOn = page.getByRole('region', { name: 'Wardrobe' })
    .getByRole('button', { name: `Add ${label} to try on`, exact: true });
  await expect(addToTryOn).toHaveCount(1, { timeout: 15_000 });
  await addToTryOn.click();
  const select = toTryOnArea(page).getByRole('button', { name: `Select ${label}`, exact: true });
  await expect(select).toHaveCount(1, { timeout: 15_000 });
  await select.click();
  await expect(toTryOnArea(page).getByRole('button', { name: `Deselect ${label}`, exact: true }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('to-try-on-counter')).toHaveText('1 / 5');
}

/**
 * Upload one base photo through the Fitting Room's own selector.
 *
 * The Client reserves and confirms the upload itself and adopts the confirmed photo as the
 * effective selection, so the selection is asserted rather than clicked blindly.
 */
async function uploadBasePhoto(page: Page, serviceJson: ServiceJson): Promise<string> {
  await expect(page.getByRole('button', { name: 'Upload', exact: true })).toBeVisible();
  const photoConfirmed = page.waitForResponse(serviceJson({ method: 'POST', path: '/vto/base-photos/upload' }));
  await page.locator('input[type="file"]').setInputFiles(uploadFixture);
  const photoResponse = await photoConfirmed;
  expect(photoResponse.status()).toBe(201);
  const basePhoto = await readServiceJson<{ id: string }>(photoResponse);
  expect(basePhoto.id).toBeTruthy();
  const basePhotoButton = page.getByRole('button', { name: /base photo 1/ });
  await expect(basePhotoButton).toHaveCount(1);
  await expect(basePhotoButton).toHaveAttribute('aria-pressed', 'true');
  return basePhoto.id;
}

/**
 * Poll one generation to a terminal state through the Service API.
 *
 * The budget is the platform's own recovery floor, never a measurement of observed
 * provider latency (see `VTO_TERMINAL_WAIT_MS`): a shorter wait gives up before the
 * platform is allowed to redeliver work a worker replacement interrupted, and then
 * reports that recovery as a product failure (issue #147). A `Failed` terminal state
 * fails immediately instead of waiting out the floor.
 */
async function awaitTerminalGeneration(
  page: Page,
  serviceUrl: string,
  headers: Record<string, string>,
  generationId: string,
): Promise<Generation> {
  let latestGeneration: Generation | undefined;
  let lastStateVersion = 0;
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
  return latestGeneration!;
}

/**
 * The caller's outfits, through the same read the Wardrobe cards render from.
 *
 * The list carries each outfit's `generationCount`, so a scenario states what happened to
 * one item set's outfit without asking for an outfit endpoint the Client never reads.
 */
async function listOutfits(page: Page, serviceUrl: string, headers: Record<string, string>): Promise<Outfit[]> {
  const response = await page.request.get(`${serviceUrl}/outfits`, { headers });
  expect(response.status()).toBe(200);
  return (await readServiceJson<{ outfits: Outfit[] }>(response)).outfits;
}

/** The outfits whose member set is exactly this item set, whatever order it was picked in. */
function outfitsForSet(outfits: Outfit[], itemIds: string[]): Outfit[] {
  const wanted = [...itemIds].sort().join(',');
  return outfits.filter((outfit) => outfit.wearableItems.map((item) => item.id).sort().join(',') === wanted);
}

test.describe('Virtual try-on @regression @full-stack', () => {
  // This file spends real provider work: an upload, an auto-tagging call and, on the
  // render path, VTO generations per attempt. A failed attempt must not be repeated
  // automatically; a leftover is resolved by the reconcile operation inside its 24-hour
  // bound.
  test.describe.configure({ retries: 0 });

  let teardown: DirectTeardown | undefined;
  // The bearer header this attempt authenticated with; never persisted.
  let authorization: string | undefined;
  // The refs captured as they were created, replayed into the attempt's own teardown.
  let captured: ResourceRef[] = [];
  let productResult: ProductResult = 'skipped';

  // One cleanup operation per scenario: each test registers its own attempt scope, so the
  // three scenarios in this file never share a scope or a lease generation. A renamed test
  // fails here instead of silently reusing another scenario's scope.
  const attemptScopes = new Map([
    ['generates one single-garment try-on end to end',
      'vto.spec.ts::generates-one-single-garment-try-on-end-to-end'],
    ['reuses the same outfit for a second try-on of the same ticked set',
      'vto.spec.ts::reuses-one-outfit-for-a-second-try-on'],
    ['saves the ticked set without a look and returns the same outfit on the second save',
      'vto.spec.ts::saves-the-ticked-set-without-a-look'],
  ]);

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
    const testScope = attemptScopes.get(testInfo.title);
    if (!testScope) {
      throw new Error(`No cleanup test scope is declared for the try-on scenario ${JSON.stringify(testInfo.title)}`);
    }
    // Register before the first business side effect, on a scope unique to this
    // attempt so a retry always allocates a fresh operation and lease generation.
    teardown = new DirectTeardown({
      runScope: requireEnvironment('E2E_CLEANUP_RUN_SCOPE'),
      testScope,
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
    const serviceJson = serviceJsonFor(serviceUrl);
    const headers = { ...CLIENT_VERSION_HEADERS, Authorization: authorization! };

    // Confirm the baseline before the first paid side effect: the scenario asserts exactly
    // one debit from this value, so a pre-existing debit cannot be mistaken for its own.
    const baselineCredits = await dailyCredits(page, serviceUrl, headers);
    expect(Number.isInteger(baselineCredits)).toBe(true);
    expect(baselineCredits).toBeGreaterThan(0);

    // Create the garment through the real Client wardrobe flow. Auto-tagging names it, so
    // the item's own terminal body carries the label the Fitting Room's `Wardrobe` area
    // lists it under.
    const garment = await uploadTaggedGarment(page, serviceUrl, serviceJson, headers);
    captured.push({ kind: 'wardrobe_item', id: garment.id });

    // Enter the Fitting Room. The tab's own list read opens the default room, so the
    // scenario creates no room and the composition below runs on that room's two areas.
    await openFittingRoom(page, serviceJson);

    // Upload the base photo through the Fitting Room's own selector. The Client reserves
    // and confirms the upload itself and auto-selects the first photo, so the selection is
    // asserted rather than clicked blindly.
    const basePhotoId = await uploadBasePhoto(page, serviceJson);
    captured.push({ kind: 'base_photo', id: basePhotoId });

    // Pick the piece from `Wardrobe` into `To try on` and tick it there. Adding stages a
    // piece — it does not try it on — so the tick is the staged row's own control.
    await stageAndSelect(page, garment.label);

    // Removal touches only this room's staged row: the piece stays in the wardrobe, and
    // adding it back is one click on the same card. Exercised here because the composed set
    // has to survive a removal, and the add-back below is what the submit uses.
    await toTryOnArea(page).getByRole('button', { name: `Remove ${garment.label} from try on`, exact: true }).click();
    await expect(toTryOnArea(page).getByRole('button', { name: `Select ${garment.label}`, exact: true }))
      .toHaveCount(0, { timeout: 15_000 });
    await expect(toTryOnArea(page)).toContainText('Nothing is staged yet.');
    await stageAndSelect(page, garment.label);

    // The compose step renders the ticked set while its switch is on, which is the default.
    await expect(page.getByRole('switch', { name: 'Try it on now (1 credit)' }))
      .toHaveAttribute('aria-checked', 'true');

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
    expect(baselineCredits - await dailyCredits(page, serviceUrl, headers)).toBe(1);

    // The budget is the platform's own recovery floor, never a measurement of observed
    // provider latency: a shorter wait gives up before the platform is allowed to redeliver
    // work a worker replacement interrupted, and then reports that recovery as a product
    // failure (issue #147). A `Failed` terminal state fails immediately instead of waiting
    // out the floor.
    const terminal = await awaitTerminalGeneration(page, serviceUrl, headers, generationId);

    // The terminal body identifies the generated image by its uuid and carries a URL
    // freshly signed at read time; retrieve it and assert real bytes.
    expect(typeof terminal.imageId).toBe('string');
    const image = await page.request.get(String(terminal.url));
    expect(image.ok()).toBe(true);
    expect((await image.body()).length).toBeGreaterThan(0);

    // The Client's own result area renders the completed generation.
    await expect(page.getByRole('img', { name: 'Try-on result' })).toBeVisible({ timeout: 30_000 });

    // Terminal state takes no further debit: exactly one credit is spent by this attempt.
    expect(await dailyCredits(page, serviceUrl, headers)).toBe(baselineCredits - 1);
    // The product assertion stands on its own; teardown runs separately in afterEach.
    productResult = 'passed';
  });

  // Issue 313 — the Fitting Room is the only place an outfit is composed, so composing one
  // item set twice must reach the outfit that set already has. This scenario spends two VTO
  // generations and one auto-tagging call per attempt.
  test.describe('Fitting Room generate path composes one outfit per item set @regression @full-stack', () => {
    test('reuses the same outfit for a second try-on of the same ticked set', async ({ page }) => {
      // Two recovery-floor-bounded generation waits, one auto-tagging wait and the
      // browser-side render; the bound is the sum of those waits, not a latency SLA.
      test.setTimeout(3_400_000);

      const serviceUrl = requireEnvironment('E2E_SERVICE_URL');
      const serviceJson = serviceJsonFor(serviceUrl);
      const headers = { ...CLIENT_VERSION_HEADERS, Authorization: authorization! };

      // Each generation is charged one credit, so the baseline must afford both before the
      // first paid step; a drained balance would otherwise disable the second submit.
      const baselineCredits = await dailyCredits(page, serviceUrl, headers);
      expect(Number.isInteger(baselineCredits)).toBe(true);
      expect(baselineCredits).toBeGreaterThanOrEqual(2);

      const garment = await uploadTaggedGarment(page, serviceUrl, serviceJson, headers);
      captured.push({ kind: 'wardrobe_item', id: garment.id });

      const room = await openFittingRoom(page, serviceJson);
      expect(room.isDefault).toBe(true);
      // A rendered try-on needs a base photo; the same upload-and-adopt contract as the
      // single-garment scenario, on the same page.
      const basePhotoId = await uploadBasePhoto(page, serviceJson);
      captured.push({ kind: 'base_photo', id: basePhotoId });
      await stageAndSelect(page, garment.label);

      // The switch is on by default, so the primary action renders the ticked set.
      await expect(page.getByRole('switch', { name: 'Try it on now (1 credit)' }))
        .toHaveAttribute('aria-checked', 'true');
      const generateButton = page.getByRole('button', { name: 'Generate try-on', exact: true });
      await expect(generateButton).toBeEnabled();

      // First composition of the set: no outfit exists for it yet, so this is the create.
      const firstAccepted = page.waitForResponse(serviceJson({ method: 'POST', path: '/vto/generations' }));
      assertE2EExecution();
      await generateButton.click();
      const firstResponse = await firstAccepted;
      expect(firstResponse.status()).toBe(202);
      const first = await readServiceJson<{ generation_id: string; outfit_id: string }>(firstResponse);
      expect(first.generation_id).toBeTruthy();
      expect(first.outfit_id).toBeTruthy();
      captured.push({ kind: 'outfit', id: first.outfit_id });
      captured.push({ kind: 'outfit_generation', id: first.generation_id });

      // One debit per accepted generation, taken at acceptance.
      expect(baselineCredits - await dailyCredits(page, serviceUrl, headers)).toBe(1);
      await awaitTerminalGeneration(page, serviceUrl, headers, first.generation_id);
      await expect(page.getByRole('img', { name: 'Try-on result' })).toBeVisible({ timeout: 30_000 });

      // The set's outfit holds exactly the one record this composition added.
      const afterFirst = await listOutfits(page, serviceUrl, headers);
      const outfitCountAfterFirst = afterFirst.length;
      const setAfterFirst = outfitsForSet(afterFirst, [garment.id]);
      expect(setAfterFirst).toHaveLength(1);
      expect(setAfterFirst[0].id).toBe(first.outfit_id);
      expect(setAfterFirst[0].generationCount).toBe(1);

      // Second composition of the same ticked set. The primary action returns once the
      // first generation settles and the page stops polling it.
      await expect(generateButton).toBeEnabled({ timeout: 60_000 });
      const secondAccepted = page.waitForResponse(serviceJson({ method: 'POST', path: '/vto/generations' }));
      await generateButton.click();
      const secondResponse = await secondAccepted;
      expect(secondResponse.status()).toBe(202);
      const second = await readServiceJson<{ generation_id: string; outfit_id: string }>(secondResponse);
      // One item set is one outfit: the second attempt names the outfit the set already
      // had, and the record it adds is a new generation rather than a replay of the first.
      expect(second.outfit_id).toBe(first.outfit_id);
      expect(second.generation_id).not.toBe(first.generation_id);
      captured.push({ kind: 'outfit_generation', id: second.generation_id });
      // Both attempts are charged, and a successful attempt is never refunded.
      expect(baselineCredits - await dailyCredits(page, serviceUrl, headers)).toBe(2);
      await awaitTerminalGeneration(page, serviceUrl, headers, second.generation_id);
      await expect(page.getByRole('img', { name: 'Try-on result' })).toBeVisible({ timeout: 30_000 });

      // No second outfit for the set, and the one it has gained exactly one row.
      const afterSecond = await listOutfits(page, serviceUrl, headers);
      expect(afterSecond).toHaveLength(outfitCountAfterFirst);
      const setAfterSecond = outfitsForSet(afterSecond, [garment.id]);
      expect(setAfterSecond).toHaveLength(1);
      expect(setAfterSecond[0].id).toBe(first.outfit_id);
      expect(setAfterSecond[0].generationCount).toBe(2);
      // The product assertion stands on its own; teardown runs separately in afterEach.
      productResult = 'passed';
    });
  });

  // Issue 313 — the compose step can save the same ticked set without rendering it. This
  // scenario spends no credit, but it still creates a wardrobe item and an outfit, and both
  // are captured so the attempt's teardown disposes of them.
  test.describe('Fitting Room save path stores an outfit without a look @regression @full-stack', () => {
    test('saves the ticked set without a look and returns the same outfit on the second save', async ({ page }) => {
      // One auto-tagging wait and the browser-side render; no generation is waited on.
      test.setTimeout(900_000);

      const serviceUrl = requireEnvironment('E2E_SERVICE_URL');
      const serviceJson = serviceJsonFor(serviceUrl);
      const headers = { ...CLIENT_VERSION_HEADERS, Authorization: authorization! };

      // Nothing on this path is metered, so the balance is read only to prove it never moves.
      const baselineCredits = await dailyCredits(page, serviceUrl, headers);
      expect(Number.isInteger(baselineCredits)).toBe(true);

      const garment = await uploadTaggedGarment(page, serviceUrl, serviceJson, headers);
      captured.push({ kind: 'wardrobe_item', id: garment.id });

      await openFittingRoom(page, serviceJson);
      await stageAndSelect(page, garment.label);

      // The switch is on by default; turning it off is the user's explicit choice to save
      // the same ticked set instead of rendering it, and it never changes the ticks.
      const tryItOnNow = page.getByRole('switch', { name: 'Try it on now (1 credit)' });
      await expect(tryItOnNow).toHaveAttribute('aria-checked', 'true');
      await tryItOnNow.click();
      await expect(tryItOnNow).toHaveAttribute('aria-checked', 'false');
      await expect(toTryOnArea(page).getByRole('button', { name: `Deselect ${garment.label}`, exact: true }))
        .toHaveAttribute('aria-pressed', 'true');
      const saveButton = page.getByRole('button', { name: 'Save outfit', exact: true });
      await expect(saveButton).toBeEnabled();

      // The set has no outfit yet, so the first save is the create.
      const outfitsBefore = await listOutfits(page, serviceUrl, headers);
      expect(outfitsForSet(outfitsBefore, [garment.id])).toHaveLength(0);
      const outfitCountBefore = outfitsBefore.length;

      const firstSaved = page.waitForResponse(serviceJson({ method: 'POST', path: '/outfits' }));
      await saveButton.click();
      const firstResponse = await firstSaved;
      expect(firstResponse.status()).toBe(201);
      // The save request carries the member list and nothing else: no base photo, no
      // prompt, no name. Any of those would be composing a render, not saving the set.
      const savedBody = await firstResponse.request().postDataJSON() as { wearable_item_ids?: string[] } | null;
      expect(savedBody).not.toBeNull();
      expect(Object.keys(savedBody ?? {}).sort()).toEqual(['wearable_item_ids']);
      expect(savedBody?.wearable_item_ids).toEqual([garment.id]);
      const saved = await readServiceJson<Outfit>(firstResponse);
      expect(saved.id).toBeTruthy();
      // The never-generated state: no generation row, so neither member has a value.
      expect(saved.latestGeneration).toBeNull();
      expect(saved.look).toBeNull();
      expect(saved.generationCount).toBe(0);
      expect(saved.wearableItems.map((item) => item.id)).toEqual([garment.id]);
      captured.push({ kind: 'outfit', id: saved.id });

      const afterFirstSave = await listOutfits(page, serviceUrl, headers);
      expect(afterFirstSave).toHaveLength(outfitCountBefore + 1);
      const setAfterFirstSave = outfitsForSet(afterFirstSave, [garment.id]);
      expect(setAfterFirstSave).toHaveLength(1);
      expect(setAfterFirstSave[0].id).toBe(saved.id);
      expect(setAfterFirstSave[0].generationCount).toBe(0);
      expect(await dailyCredits(page, serviceUrl, headers)).toBe(baselineCredits);

      // The second save is the find: the same set answers with the outfit it already has.
      const secondSaved = page.waitForResponse(serviceJson({ method: 'POST', path: '/outfits' }));
      await saveButton.click();
      const secondResponse = await secondSaved;
      expect(secondResponse.status()).toBe(200);
      const secondOutfit = await readServiceJson<Outfit>(secondResponse);
      expect(secondOutfit.id).toBe(saved.id);
      expect(secondOutfit.latestGeneration).toBeNull();
      expect(secondOutfit.look).toBeNull();
      expect(secondOutfit.generationCount).toBe(0);

      // Between the two saves nothing moved: no second outfit, no generation row, no credit.
      const afterSecondSave = await listOutfits(page, serviceUrl, headers);
      expect(afterSecondSave).toHaveLength(outfitCountBefore + 1);
      const setAfterSecondSave = outfitsForSet(afterSecondSave, [garment.id]);
      expect(setAfterSecondSave).toHaveLength(1);
      expect(setAfterSecondSave[0].id).toBe(saved.id);
      expect(setAfterSecondSave[0].generationCount).toBe(0);
      expect(await dailyCredits(page, serviceUrl, headers)).toBe(baselineCredits);

      // The card this outfit produces. `latestGeneration` and `look` are both null, so the
      // card paints the Client's bundled placeholder and `Generate look`; that is a
      // different state from image-unavailable, and it needs no image of its own.
      const requests: { method: string; url: string }[] = [];
      const recordRequest = (request: Request) => requests.push({ method: request.method(), url: request.url() });
      page.on('request', recordRequest);
      try {
        const outfitsList = page.waitForResponse(serviceJson({ method: 'GET', path: '/outfits' }));
        await page.goto('/wardrobe');
        expect((await outfitsList).status()).toBe(200);
        const outfitName = saved.name || 'outfit';
        const outfitCard = page.locator('article')
          .filter({ has: page.getByRole('button', { name: `Edit ${outfitName}`, exact: true }) });
        await expect(outfitCard).toHaveCount(1);
        const placeholder = outfitCard.getByTestId('outfit-cover-placeholder');
        await expect(placeholder).toBeVisible();
        await expect(placeholder).toContainText('No look yet');
        await expect(outfitCard.getByRole('button', { name: `Generate look for ${outfitName}`, exact: true }))
          .toBeVisible({ timeout: 15_000 });
        await expect(page.getByText('Image unavailable')).toHaveCount(0);
      } finally {
        page.off('request', recordRequest);
      }

      const pathOf = (url: string) => {
        try { return new URL(url).pathname; } catch { return ''; }
      };
      // The card was read from the outfits list, and the page asked for no single outfit of
      // its own while painting it.
      expect(requests.some((request) => request.method === 'GET' && pathOf(request.url) === '/outfits')).toBe(true);
      expect(requests.filter((request) => pathOf(request.url) === `/outfits/${saved.id}`)).toEqual([]);
      // No image was fetched for a look this outfit does not have: the placeholder is a
      // bundled resource, and a generated-look object would travel under this prefix.
      expect(requests.filter((request) => request.url.includes('/outfit-generations/'))).toEqual([]);
      // The product assertion stands on its own; teardown runs separately in afterEach.
      productResult = 'passed';
    });
  });
});
