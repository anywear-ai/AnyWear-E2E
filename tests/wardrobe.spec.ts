import { expect, login, test } from './support/fixtures.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  requireEnvironment,
} from './support/account.js';
import { DirectTeardown, quarantinesScope, type ProductResult } from './support/cleanup-operation.js';
import { CLIENT_VERSION_HEADERS } from './support/client-version.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  readServiceJson,
  serviceOriginOf,
  serviceResponseMatcher,
} from './support/service-json-response.mjs';

const uploadFixture = fileURLToPath(new URL('./fixtures/dummy.png', import.meta.url));

interface WardrobeStatus {
  id: string;
  taggingStatus: string;
  taggingStateVersion: number;
}

interface WardrobeItem extends WardrobeStatus {
  name: string | null;
  category: string;
}

/** The acceptance answer one upload confirmation returns. */
interface AcceptedItem {
  itemId: string;
  taggingStatus: string;
}

test.describe('Wardrobe Management @regression @full-stack', () => {
  // This scenario invokes the external VLM. A failed attempt must not be
  // repeated automatically; a leftover is resolved by the reconcile operation
  // inside its 24-hour bound.
  test.describe.configure({ retries: 0 });

  // Every item this attempt confirmed. They are captured as the confirmations
  // arrive, so the attempt's teardown owns all of them even when a later product
  // assertion fails.
  let createdItemIds: string[] = [];
  let authorization: string | undefined;
  let teardown: DirectTeardown | undefined;
  let productResult: ProductResult = 'skipped';

  // One cleanup operation per scenario: a test registers its own attempt scope,
  // so the scenarios in this file never share a scope or a lease generation. A
  // renamed test fails here instead of silently reusing another scenario's scope.
  const attemptScopes = new Map([
    ['recovers an idempotent auto-tag request across reloads and browser pages, then edits and deletes it',
      'wardrobe.spec.ts::recovers-an-idempotent-auto-tag-request'],
    ['adds two photos in one action and both reach ready without a page reload',
      'wardrobe.spec.ts::adds-two-photos-in-one-action'],
  ]);

  // A stable numeric lease generation per attempt keeps every retry on a fresh
  // lease fence while staying reproducible within one attempt.
  const leaseGenerationFor = (seed: string) => (parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 6), 16) % 2_000_000) + 1;

  test.beforeEach(async ({ page, workerAccount }, testInfo) => {
    requireEnvironment('USER_POOL_ID');
    requireEnvironment('VITE_COGNITO_CLIENT_ID');
    createdItemIds = [];
    authorization = undefined;
    productResult = 'skipped';
    const testScope = attemptScopes.get(testInfo.title);
    if (!testScope) {
      throw new Error(`No cleanup test scope is declared for the wardrobe scenario ${JSON.stringify(testInfo.title)}`);
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
    // state. The readback and the teardown deletes inside `finalize` reuse it.
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
    for (const id of createdItemIds) teardown.capture('wardrobe_item', id);
    // `finalize` is the only terminal entry point: it deletes the captured items in
    // schema order, reads every one of them back, and only then writes the single
    // acknowledgement. It also closes the declaration when nothing was created or
    // when this attempt holds no bearer token, so there is no second call site.
    const result = await teardown.finalize(productResult, authorization);

    // A teardown failure fails the separate teardown gate without rewriting the
    // product outcome, and quarantines the scope so the next attempt is fresh.
    if (quarantinesScope(result.teardown_result)) {
      expect(result.scope_state, result.quarantine_reason ?? 'teardown quarantined its scope').toBe('quarantined');
      throw new Error(`Teardown gate failed (${result.teardown_result}): ${result.quarantine_reason ?? 'unknown'}`);
    }
  });

  test('recovers an idempotent auto-tag request across reloads and browser pages, then edits and deletes it', async ({ page, context }) => {
    // Cover the Service's nominal 552-second retry budget and bounded browser
    // overhead; this completion wait does not assert a latency SLA.
    test.setTimeout(720_000);

    page.on('dialog', async (dialog) => {
      await dialog.accept();
    });

    const serviceUrl = requireEnvironment('E2E_SERVICE_URL');
    const serviceOrigin = serviceOriginOf(serviceUrl);
    const serviceJson = (criteria: { method: string; path?: string }) => serviceResponseMatcher(serviceOrigin, criteria);

    // Every Service response waiter is scoped to the Service origin and to a
    // JSON content type. The Client SPA origin answers the same path with the
    // document shell at status 200, so an unscoped predicate would let
    // `page.goto('/wardrobe')` win the race and fail the later `.json()` parse.
    const initialWardrobe = page.waitForResponse(serviceJson({ method: 'GET', path: '/wardrobe' }));
    await page.goto('/wardrobe');
    await expect(page.getByRole('heading', { name: 'Wardrobe' })).toBeVisible();
    const initialWardrobeResponse = await initialWardrobe;
    expect(initialWardrobeResponse.status()).toBe(200);
    const baselineItems = await readServiceJson<WardrobeItem[]>(initialWardrobeResponse);

    await page.getByRole('button', { name: 'Add Item' }).click();
    await expect(page.getByRole('heading', { name: 'Add Wardrobe Item' })).toBeVisible();

    await page.locator('input[type="file"][multiple]').setInputFiles(uploadFixture);
    const uploaded = page.waitForResponse(serviceJson({ method: 'POST', path: '/wardrobe/upload-url' }));
    const confirmed = page.waitForResponse(serviceJson({ method: 'POST', path: '/wardrobe/upload' }));
    await page.getByRole('button', { name: 'Upload & Auto-Tag' }).click();

    const uploadedResponse = await uploaded;
    expect(uploadedResponse.status()).toBe(200);
    // The upload-url response books the upload; the item does not exist until the
    // confirmation has read the stored object back.
    const reservation = await readServiceJson<{ reservationId: string; expiresAt: string; upload: unknown }>(uploadedResponse);
    expect(reservation.reservationId).toBeTruthy();
    expect(reservation.expiresAt).toBeTruthy();
    // The reservation carries no object key (#232): `upload` is the signed S3
    // POST policy, and the image identity is minted only by the confirmation.
    expect(reservation.upload).toBeTruthy();
    authorization = await uploadedResponse.request().headerValue('authorization') ?? undefined;
    expect(authorization).toBeTruthy();

    const confirmedResponse = await confirmed;
    expect(confirmedResponse.status()).toBe(202);
    const accepted = await readServiceJson<{ itemId: string; taggingStatus: string }>(confirmedResponse);
    createdItemIds = [accepted.itemId];
    const [createdItemId] = createdItemIds;
    expect(createdItemId).toBeTruthy();
    expect(accepted).toEqual({ itemId: createdItemId, taggingStatus: 'processing' });
    const idempotencyKey = await confirmedResponse.request().headerValue('idempotency-key');
    expect(idempotencyKey).toBeTruthy();
    const headers = { ...CLIENT_VERSION_HEADERS, Authorization: authorization!, 'Idempotency-Key': idempotencyKey! };
    const ownedItemUrl = `${serviceUrl}/wardrobe/items/${createdItemId}`;

    const replay = await page.request.post(`${serviceUrl}/wardrobe/upload`, {
      headers,
      data: { reservationId: reservation.reservationId },
    });
    expect(replay.status()).toBe(202);
    expect(await readServiceJson(replay)).toEqual(accepted);

    await expect(page.getByRole('heading', { name: 'Add Wardrobe Item' })).not.toBeVisible();
    const observer = await context.newPage();
    await Promise.all([page.reload(), observer.goto('/wardrobe')]);
    await expect(observer.getByRole('heading', { name: 'Wardrobe' })).toBeVisible();

    let latest: WardrobeStatus | undefined;
    let lastVersion = 0;
    await expect.poll(async () => {
      const response = await page.request.get(ownedItemUrl, { headers });
      expect(response.status()).toBe(200);
      latest = await readServiceJson<WardrobeStatus>(response);
      expect(latest.id).toBe(createdItemId);
      expect(latest.taggingStateVersion).toBeGreaterThanOrEqual(lastVersion);
      lastVersion = latest.taggingStateVersion;
      return latest.taggingStatus;
    }, { timeout: 600_000, intervals: [1_000, 2_000, 5_000] }).toBe('ready');

    const terminalReplay = await observer.request.post(`${serviceUrl}/wardrobe/upload`, {
      headers,
      data: { reservationId: reservation.reservationId },
    });
    expect(terminalReplay.status()).toBe(202);
    expect(await readServiceJson(terminalReplay)).toEqual(accepted);
    const afterReplay = await observer.request.get(ownedItemUrl, { headers });
    expect(afterReplay.status()).toBe(200);
    const ownedItem = await readServiceJson<WardrobeItem>(afterReplay);
    expect(ownedItem).toMatchObject({
      id: createdItemId,
      taggingStatus: 'ready',
      taggingStateVersion: latest!.taggingStateVersion,
    });

    const ownedItemLabel = ownedItem.name || ownedItem.category || 'wardrobe item';
    const ownedCardName = `View ${ownedItemLabel} details`;
    const wardrobeBeforeEdit = await page.request.get(`${serviceUrl}/wardrobe`, { headers });
    expect(wardrobeBeforeEdit.status()).toBe(200);
    const itemsBeforeEdit = await readServiceJson<WardrobeItem[]>(wardrobeBeforeEdit);
    // The UI exposes a label rather than an ID. Fail before mutation if that
    // label cannot identify exactly the item created by this scenario.
    expect(itemsBeforeEdit.filter((item) => (
      (item.name || item.category || 'wardrobe item') === ownedItemLabel
    )).map((item) => item.id)).toEqual([createdItemId]);

    for (const viewer of [page, observer]) {
      const itemCard = viewer.getByRole('button', { name: ownedCardName, exact: true });
      await expect(itemCard).toHaveCount(1, { timeout: 15_000 });
      await expect(itemCard).toBeVisible();
      await expect(itemCard).toBeEnabled({ timeout: 15_000 });
      await expect(itemCard.getByText('Analyzing...')).not.toBeVisible();
      await expect(itemCard.getByText('Failed', { exact: true })).not.toBeVisible();
    }
    await observer.close();

    const itemCard = page.getByRole('button', { name: ownedCardName, exact: true });
    await expect(itemCard).toHaveCount(1);
    await itemCard.click();
    const details = page.getByRole('dialog', { name: 'Item Details', exact: true });
    await expect(details).toBeVisible();

    const editedItemName = `E2E Test Sweater ${createdItemId}`;
    await details.getByPlaceholder('e.g. My favorite hoodie').fill(editedItemName);
    await details.getByPlaceholder('e.g. Top').fill('Jacket');
    await details.getByPlaceholder('e.g. Black, White').fill('Red');
    await details.getByPlaceholder('e.g. Cotton').fill('Cotton');
    const saved = page.waitForResponse(serviceJson({ method: 'PATCH', path: new URL(ownedItemUrl).pathname }));
    await details.getByRole('button', { name: 'Save Changes', exact: true }).click();
    const savedResponse = await saved;
    expect(savedResponse.status()).toBe(200);
    expect(await readServiceJson(savedResponse)).toMatchObject({ id: createdItemId, name: editedItemName });
    await expect(details).not.toBeVisible();

    const editedCard = page.getByRole('button', { name: `View ${editedItemName} details`, exact: true });
    await expect(editedCard).toHaveCount(1, { timeout: 10_000 });
    await expect(editedCard.getByRole('heading', { name: editedItemName, exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(editedCard.getByText(/red.*cotton/i)).toBeVisible({ timeout: 5_000 });

    await editedCard.click();
    await expect(details).toBeVisible();
    const deleted = page.waitForResponse(serviceJson({ method: 'DELETE', path: new URL(ownedItemUrl).pathname }));
    await details.getByRole('button', { name: 'Delete', exact: true }).click();
    expect((await deleted).status()).toBe(200);
    await expect(details).not.toBeVisible();
    await expect(editedCard).toHaveCount(0);
    const deletedItem = await page.request.get(ownedItemUrl, { headers });
    expect(deletedItem.status()).toBe(404);

    const finalWardrobe = await page.request.get(`${serviceUrl}/wardrobe`, { headers });
    expect(finalWardrobe.status()).toBe(200);
    const finalItems = await readServiceJson<WardrobeItem[]>(finalWardrobe);
    expect(finalItems.map((item) => item.id)).not.toContain(createdItemId);
    for (const baselineItem of baselineItems) {
      expect(finalItems.find((item) => item.id === baselineItem.id)).toMatchObject({
        id: baselineItem.id,
        name: baselineItem.name,
      });
    }
    // The product assertion stands on its own; teardown runs separately in afterEach.
    productResult = 'passed';
  });

  test('adds two photos in one action and both reach ready without a page reload', async ({ page }) => {
    // Two real auto-tagging tasks run behind the provider on the deployed
    // platform. The bound covers the Service's nominal retry budget for the batch
    // and the browser-side render; it is not a latency SLA.
    test.setTimeout(720_000);

    const serviceUrl = requireEnvironment('E2E_SERVICE_URL');
    const serviceOrigin = serviceOriginOf(serviceUrl);
    const serviceJson = (criteria: { method: string; path?: string }) => serviceResponseMatcher(serviceOrigin, criteria);
    const headers = { ...CLIENT_VERSION_HEADERS, Authorization: authorization! };
    const photoNames = ['batch-photo-1.png', 'batch-photo-2.png'];

    // The confirmations name the two items. Capture each as it arrives, so the
    // attempt's teardown owns both even when a later assertion fails.
    const acceptedItems = new Map<string, AcceptedItem>();
    const isConfirmation = serviceJson({ method: 'POST', path: '/wardrobe/upload' });
    page.on('response', (response) => {
      if (!isConfirmation(response)) return;
      void readServiceJson<AcceptedItem>(response).then((accepted) => {
        if (typeof accepted?.itemId !== 'string' || accepted.itemId.length === 0) return;
        acceptedItems.set(accepted.itemId, accepted);
        if (!createdItemIds.includes(accepted.itemId)) createdItemIds.push(accepted.itemId);
      }, () => undefined);
    });

    const initialWardrobe = page.waitForResponse(serviceJson({ method: 'GET', path: '/wardrobe' }));
    await page.goto('/wardrobe');
    await expect(page.getByRole('heading', { name: 'Wardrobe' })).toBeVisible();
    const initialWardrobeResponse = await initialWardrobe;
    expect(initialWardrobeResponse.status()).toBe(200);
    const baselineItems = await readServiceJson<WardrobeItem[]>(initialWardrobeResponse);

    // The assertion below is that readiness arrives on the document that is
    // already open: a reload would record a second load, and this scenario never
    // asks for one.
    let documentLoads = 0;
    page.on('load', () => { documentLoads += 1; });

    await page.getByRole('button', { name: 'Add Item' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add Wardrobe Item', exact: true });
    await expect(dialog).toBeVisible();

    // One action: both photos enter the dialog from one selection, and the
    // submit button names the batch it will add.
    const photoBytes = readFileSync(uploadFixture);
    await page.locator('input[type="file"][multiple]').setInputFiles(photoNames.map((name) => ({
      name,
      mimeType: 'image/png',
      buffer: photoBytes,
    })));
    const rows = dialog.getByRole('list', { name: 'Added photos' }).getByRole('listitem');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(photoNames[0]);
    await expect(rows.nth(1)).toContainText(photoNames[1]);
    const addPhotos = dialog.getByRole('button', { name: 'Add 2 items', exact: true });
    await expect(addPhotos).toBeVisible();
    await addPhotos.click();

    await expect.poll(() => acceptedItems.size, { timeout: 120_000 }).toBe(2);
    const accepted = [...acceptedItems.values()];
    for (const item of accepted) {
      expect(item.taggingStatus).toBe('processing');
      // The dialog reports which wardrobe item each photo became.
      await expect(dialog.getByText(`Item ${item.itemId}`)).toBeVisible();
    }

    // Both rows leave processing on the same open page. The dialog reads an
    // item's live status from the wardrobe list the page's status stream
    // advances, so a row leaving `processing` here is exactly the delivery this
    // scenario observes; a silently failed delivery would sit on `Tagging
    // processing` until the wait expires.
    for (let index = 0; index < 2; index += 1) {
      await expect(rows.nth(index).getByText('Tagging ready')).toBeVisible({ timeout: 600_000 });
    }
    await expect(dialog.getByRole('status')).toHaveText('2 items added, 0 failed');

    expect(documentLoads).toBe(0);
    expect(new URL(page.url()).pathname).toBe('/wardrobe');

    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).not.toBeVisible();

    // Both confirmed items are in the wardrobe list and terminal `ready`, and the
    // list gained exactly those two items over the pre-run baseline.
    const wardrobeResponse = await page.request.get(`${serviceUrl}/wardrobe`, { headers });
    expect(wardrobeResponse.status()).toBe(200);
    const items = await readServiceJson<WardrobeItem[]>(wardrobeResponse);
    const createdIds = [...new Set(createdItemIds)];
    expect(createdIds).toHaveLength(2);
    expect(items.map((item) => item.id)).toEqual(expect.arrayContaining([...createdIds, ...baselineItems.map((item) => item.id)]));
    expect(items).toHaveLength(baselineItems.length + 2);
    const created = items.filter((item) => createdIds.includes(item.id));
    expect(created.map((item) => item.id).sort()).toEqual([...createdIds].sort());
    for (const item of created) {
      expect(item.taggingStatus).toBe('ready');
      expect(item.taggingStateVersion).toBeGreaterThanOrEqual(1);
    }

    // The rendered list holds every item the Service lists, and neither created
    // card is still waiting or failed: both readinesses were applied in place.
    const labelOf = (item: WardrobeItem) => item.name || item.category || 'wardrobe item';
    const cards = page.locator('article').filter({ has: page.getByRole('button', { name: /^View .+ details$/ }) });
    await expect(cards).toHaveCount(items.length);
    for (const item of created) {
      const label = labelOf(item);
      const occurrences = items.filter((candidate) => labelOf(candidate) === label).length;
      const card = page.getByRole('button', { name: `View ${label} details`, exact: true });
      await expect(card).toHaveCount(occurrences);
      await expect(card.first()).toBeEnabled();
      await expect(card.first().getByText('Analyzing...')).not.toBeVisible();
      await expect(card.first().getByText('Failed', { exact: true })).not.toBeVisible();
    }

    expect(documentLoads).toBe(0);
    // The product assertion stands on its own; teardown runs separately in afterEach.
    productResult = 'passed';
  });
});
