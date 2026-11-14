import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import {
  bindAttemptBusinessCleanup,
  closeAttemptBusinessCleanup,
  type AttemptKey,
} from './attempt-cleanup-registry.ts';
import { CLIENT_VERSION_HEADERS } from './client-version.ts';

/**
 * Issue 86 ordinary-path direct teardown.
 *
 * Every test attempt owns exactly one Service-recorded cleanup operation. The
 * operation is registered before any identity provisioning or first business
 * side effect, the owner subject is bound after Cognito confirmation, every
 * created business resource ID is captured as an exact reference, and
 * teardown runs in `finally` through the existing user-facing DELETE routes.
 *
 * Product result, teardown result and scope state are independent: a teardown
 * failure never rewrites the product assertion, but it still quarantines the
 * scope so the next attempt allocates a fresh one. Nothing here invokes a
 * reconciler, Step Functions, ECS, `:3`, or an owner-wide scan.
 */

export type TeardownResult = 'passed' | 'failed' | 'partial';
export type ScopeState = 'released' | 'quarantined';
export type ProductResult = 'passed' | 'failed' | 'skipped';
export type ResourceKind = 'wardrobe_item' | 'outfit' | 'outfit_generation' | 'base_photo' | 'object_key';

export const RESOURCE_KINDS: readonly ResourceKind[] = [
  'wardrobe_item',
  'outfit',
  'outfit_generation',
  'base_photo',
  'object_key',
];

/**
 * The schema contract this teardown deletes against.
 *
 * Of the references between these resources, Service's
 * `outfit_wearable_items -> outfits` is the only one that cascades:
 * `outfit_generations -> outfits`, `outfit_generations -> base_photos` and
 * `outfit_wearable_items -> wearable_items` are all `no action`. So an outfit, a
 * wearable item and a base photo each have rows that reference them, and
 * deleting one of those parents while its referencing rows still exist is
 * refused by the database rather than cascaded. A capturing attempt therefore
 * deletes every referencing kind before the kind it references:
 *
 * 1. `outfit_generation` - references both its outfit and its base photo, so it
 *    is deleted before either, and it is the only kind referencing them.
 * 2. `outfit` - owns the joining `outfit_wearable_items` rows, which the cascade
 *    releases along with the items they held, and no generation references it
 *    any more.
 * 3. `wardrobe_item` - referenced through those joining rows, which the outfit
 *    delete released.
 * 4. `base_photo` - referenced by generations, which are gone.
 *
 * `object_key` holds no position: it has no delete route and never reaches one.
 */
export const SCHEMA_DELETE_ORDER: readonly ResourceKind[] = [
  'outfit_generation',
  'outfit',
  'wardrobe_item',
  'base_photo',
  'object_key',
];

const SCHEMA_DELETE_RANK = new Map(SCHEMA_DELETE_ORDER.map((kind, index) => [kind, index]));

export interface ResourceRef {
  kind: ResourceKind;
  id: string;
}

/** The captured refs in the order the schema contract allows them to be deleted. */
export function schemaDeleteOrder(refs: readonly ResourceRef[]): ResourceRef[] {
  return [...refs].sort((left, right) => (SCHEMA_DELETE_RANK.get(left.kind) ?? 0) - (SCHEMA_DELETE_RANK.get(right.kind) ?? 0));
}

/**
 * The kind of resource that structurally owns this one, when a single kind does.
 *
 * An outfit owns its generations outright: `outfit_generations.outfit_id`
 * references `outfits.id` with `no action`, so deleting a generation does not
 * release its outfit, and deleting an outfit is refused while a generation still
 * references it. A spec that creates a generation must therefore capture its
 * outfit too, or the attempt holds a row it can never release.
 *
 * `undefined` means the resource has no owning kind and can exist on its own: an
 * outfit is user-owned, and a base photo or a wardrobe item is released by its
 * own delete route whenever no outfit references it.
 *
 * A wardrobe item is deliberately not modelled as owned here. An outfit holds an
 * item through the joining `outfit_wearable_items` rows, which makes the outfit a
 * *reference* the item's delete must follow — that ordering is what
 * `SCHEMA_DELETE_ORDER` states, and it is a different relation from ownership.
 */
export function structuralOwnerKind(kind: ResourceKind): ResourceKind | undefined {
  return kind === 'outfit_generation' ? 'outfit' : undefined;
}

export interface OperationState {
  operation_id: string;
  state_version: number;
  phase: string;
  product_result: string | null;
  teardown_result: string | null;
  scope_state: string | null;
  active_tasks: number;
  pending_outbox: number;
}

export interface RegisterResponse {
  operation_id: string;
  state_version: number;
  phase: string;
  intent_hash: string;
  replayed: boolean;
}

export const MACHINE_AUTH_CAPABILITIES = ['operation:register', 'operation:bind', 'operation:acknowledge', 'identity:provision'] as const;
export type MachineAuthCapability = typeof MACHINE_AUTH_CAPABILITIES[number];

const DEFAULT_TTL_MS = 120_000;
const MAX_ID_LENGTH = 128;
const RUN_SCOPE = /^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-[a-f0-9]{16}$/;
const SUBJECT = /^[a-f0-9-]{36}$/;

function bodyDigest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function machineAuthSignatureInput(fields: {
  callerId: string;
  capability: string;
  requestId: string;
  expiresAt: number;
  bodySha256: string;
}): string {
  return [fields.callerId, fields.capability, fields.requestId, String(fields.expiresAt), fields.bodySha256].join('\n');
}

/** Signed, short-lived, capability-scoped headers for one cleanup-operations call. */
export function machineAuthHeaders(
  capability: MachineAuthCapability,
  body: string,
  environment: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): Record<string, string> {
  if (!(MACHINE_AUTH_CAPABILITIES as readonly string[]).includes(capability)) throw new Error('Machine capability is invalid');
  const secret = environment.CLEANUP_MACHINE_AUTH_SECRET;
  if (!secret) throw new Error('CLEANUP_MACHINE_AUTH_SECRET is required for the cleanup operation surface');
  const callerId = environment.E2E_MACHINE_CALLER_ID ?? 'anywear-e2e-suite';
  const requestId = randomUUID();
  const expiresAt = now + DEFAULT_TTL_MS;
  const signature = createHmac('sha256', secret)
    .update(machineAuthSignatureInput({ callerId, capability, requestId, expiresAt, bodySha256: bodyDigest(body) }))
    .digest('hex');
  return {
    'Content-Type': 'application/json',
    'X-AnyWear-Machine-Caller': callerId,
    'X-AnyWear-Machine-Signature': signature,
    'X-AnyWear-Machine-Expires-At': String(expiresAt),
    'X-Request-Id': requestId,
  };
}

function assertRef(ref: ResourceRef): void {
  if (!(RESOURCE_KINDS as readonly string[]).includes(ref.kind)) throw new Error('Cleanup resource kind is invalid: ' + ref.kind);
  if (typeof ref.id !== 'string' || ref.id.length < 1 || ref.id.length > MAX_ID_LENGTH) {
    throw new Error('Cleanup resource id is malformed for kind ' + ref.kind);
  }
}

/**
 * Exact user-facing DELETE routes. `object_key` has no ordinary user route, so it
 * quarantines its scope instead of being silently skipped.
 */
export function deleteRouteFor(ref: ResourceRef): string | undefined {
  const id = encodeURIComponent(ref.id);
  switch (ref.kind) {
    case 'wardrobe_item': return '/wardrobe/items/' + id;
    case 'outfit': return '/outfits/' + id;
    case 'outfit_generation': return '/vto/generations/' + id;
    case 'base_photo': return '/vto/base-photos/' + id;
    case 'object_key': return undefined;
  }
}

export interface DirectTeardownOptions {
  runScope: string;
  testScope: string;
  retryIndex: number;
  leaseId: string;
  leaseGeneration: number;
  expectedUsername: string;
  expectedEmail: string;
  serviceUrl: string;
  request: APIRequestContext;
  /**
   * The owning attempt, so this operation's business-cleanup outcome is
   * addressable by the attempt teardown that runs after the spec's `afterEach`
   * hooks. It is the Playwright `TestInfo` object and is never inspected here,
   * only used as the per-attempt key.
   */
  testInfo: AttemptKey;
  environment?: NodeJS.ProcessEnv;
  /** Overrides for tests; the Playwright request context is used otherwise. */
  io?: DirectTeardownIo;
  deleteIo?: DirectTeardownDeleteIo;
  readIo?: DirectTeardownReadIo;
}

/** What one read-back could observe about a captured reference. */
export type ReferenceReadback = 'absent' | 'present' | 'error';

/**
 * What the teardown can honestly say about one captured reference.
 *
 * Absence decides this, never the delete status. `removed` and `already_absent`
 * both mean the read-back proved the reference gone; the delete status only
 * attributes that absence to this attempt (`2xx`) or to an earlier state (`404`).
 * `absent_unattributed` is proven absence that no delete outcome explains (a
 * `5xx`, a thrown request, or no status at all). A reference that is still
 * readable is `present` whatever its delete returned, and one whose absence
 * could not be proven is `unverified`.
 */
export type ReferenceDisposition = 'removed' | 'already_absent' | 'absent_unattributed' | 'present' | 'unverified';

export interface ReferenceEvidence {
  ref: ResourceRef;
  delete_status?: number;
  readback: ReferenceReadback;
  disposition: ReferenceDisposition;
  reason?: string;
}

/** The delete half of one reference's record, before its absence is read back. */
export interface ReferenceDelete {
  ref: ResourceRef;
  delete_status?: number;
  reason?: string;
}

export interface DirectTeardownResult {
  operation_id: string;
  product_result: ProductResult;
  teardown_result: TeardownResult;
  scope_state: ScopeState;
  quarantine_reason?: string;
  /** One honest record per captured reference, in schema-delete order. */
  evidence: ReferenceEvidence[];
}

export interface DirectTeardownCall {
  status: number;
  body: unknown;
}

/** Injected transport for the machine-authenticated operation surface. */
export type DirectTeardownIo = (path: string, init: {
  method: 'post' | 'get';
  headers: Record<string, string>;
  data?: string;
}) => Promise<DirectTeardownCall>;

/** Injected transport for the ordinary user-facing DELETE routes. */
export type DirectTeardownDeleteIo = (url: string, authorization: string) => Promise<number>;

/**
 * Injected transport for the ordinary user-facing read-back routes.
 *
 * It exists so the offline suite can drive the whole read-back contract with no
 * Playwright request context, exactly as `deleteIo` lets it drive the deletes.
 */
export type DirectTeardownReadIo = (url: string, authorization: string) => Promise<{ status: number; body?: unknown }>;

/** The Service refuses a quarantine reason above this bound (its route caps it at 512). */
export const QUARANTINE_REASON_MAX_BYTES = 512;

/** Absence first; the delete status only attributes it. */
function dispositionOf(deleteStatus: number | undefined, readback: ReferenceReadback): ReferenceDisposition {
  if (readback === 'present') return 'present';
  if (readback === 'error') return 'unverified';
  if (deleteStatus === 200 || deleteStatus === 204) return 'removed';
  if (deleteStatus === 404) return 'already_absent';
  return 'absent_unattributed';
}

/** `present` and `unverified` are the two dispositions that withhold a passing teardown. */
function withholdsAbsence(evidence: ReferenceEvidence): boolean {
  return evidence.disposition === 'present' || evidence.disposition === 'unverified';
}

/** Zero withholding references pass, all of them fail, and a mixed set is partial. */
function teardownResultFor(evidence: readonly ReferenceEvidence[]): TeardownResult {
  const failing = evidence.filter(withholdsAbsence).length;
  if (failing === 0) return 'passed';
  return failing === evidence.length ? 'failed' : 'partial';
}

function joinReasons(...parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((part): part is string => typeof part === 'string' && part.length > 0);
  return kept.length > 0 ? kept.join('; ') : undefined;
}

/** The captured base-photo ids a tolerantly parsed list body reports as still present. */
function listedBasePhotoIds(body: unknown): Set<string> | undefined {
  let list: unknown;
  if (Array.isArray(body)) list = body;
  else if (body !== null && typeof body === 'object') {
    const holder = body as { photos?: unknown; base_photos?: unknown };
    list = Array.isArray(holder.photos) ? holder.photos : holder.base_photos;
  }
  if (!Array.isArray(list)) return undefined;
  const ids = new Set<string>();
  for (const entry of list) {
    if (typeof entry === 'string') ids.add(entry);
    else if (entry !== null && typeof entry === 'object') {
      const id = (entry as { id?: unknown }).id;
      if (typeof id === 'string') ids.add(id);
    }
  }
  return ids;
}

function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let kept = '';
  let used = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (used + size > maxBytes) break;
    kept += character;
    used += size;
  }
  return kept;
}

/**
 * A deterministic quarantine reason inside the Service's 512-byte budget.
 *
 * Counts come first, then the withholding references in schema-delete order as
 * `kind:id(disposition)`, then `+N more` naming what did not fit. The same input
 * always produces the same string, and the reason is truncated here rather than
 * refused by the Service's own strict body schema.
 */
function buildQuarantineReason(teardownResult: TeardownResult, evidence: readonly ReferenceEvidence[]): string {
  const counts: Record<ReferenceDisposition, number> = {
    removed: 0,
    already_absent: 0,
    absent_unattributed: 0,
    present: 0,
    unverified: 0,
  };
  for (const entry of evidence) counts[entry.disposition] += 1;
  const head = 'teardown ' + teardownResult + '; references ' + evidence.length
    + ': removed ' + counts.removed
    + ', already_absent ' + counts.already_absent
    + ', absent_unattributed ' + counts.absent_unattributed
    + ', present ' + counts.present
    + ', unverified ' + counts.unverified
    + '; failing';
  const failing = evidence.filter(withholdsAbsence)
    .map((entry) => entry.ref.kind + ':' + entry.ref.id + '(' + entry.disposition + ')');
  const compose = (shown: number): string => {
    const hidden = failing.length - shown;
    return head
      + (shown > 0 ? ': ' + failing.slice(0, shown).join(', ') : '')
      + (hidden > 0 ? '; +' + hidden + ' more' : '');
  };
  for (let shown = failing.length; shown >= 0; shown -= 1) {
    const candidate = compose(shown);
    if (Buffer.byteLength(candidate, 'utf8') <= QUARANTINE_REASON_MAX_BYTES) return candidate;
  }
  return truncateToBytes(head, QUARANTINE_REASON_MAX_BYTES);
}

/**
 * One Service-owned cleanup operation for a single test attempt.
 *
 * Call order is enforced by construction: `register()` before provisioning,
 * `bindOwner()` after Cognito confirmation, `capture()` during the test body, and
 * `finalize()` in `finally`. `finalize()` deletes, reads absence back, and only
 * then writes the single acknowledgement, so `passed` is never recorded before
 * the proof. It is the only terminal entry point and is idempotent per attempt.
 */
export class DirectTeardown {
  private readonly options: DirectTeardownOptions;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly refs: ResourceRef[] = [];
  private operationId: string | undefined;
  private finalized: DirectTeardownResult | undefined;

  constructor(options: DirectTeardownOptions) {
    if (!RUN_SCOPE.test(options.runScope)) throw new Error('Cleanup operation run scope is invalid');
    if (options.testScope.length < 1 || options.testScope.length > MAX_ID_LENGTH) throw new Error('Cleanup test scope is invalid');
    if (!Number.isInteger(options.retryIndex) || options.retryIndex < 0 || options.retryIndex > 999) throw new Error('Cleanup retry index is invalid');
    if (!Number.isInteger(options.leaseGeneration) || options.leaseGeneration < 1) throw new Error('Cleanup lease generation is invalid');
    if (options.leaseId.length < 1 || options.leaseId.length > MAX_ID_LENGTH) throw new Error('Cleanup lease id is invalid');
    this.options = options;
    this.environment = options.environment ?? process.env;
  }

  get id(): string | undefined { return this.operationId; }

  get captured(): readonly ResourceRef[] { return this.refs; }

  requireOperation(): string {
    if (!this.operationId) throw new Error('Cleanup operation must be registered before this step');
    return this.operationId;
  }

  private headers(capability: MachineAuthCapability, body: string): Record<string, string> {
    const headers = machineAuthHeaders(capability, body, this.environment);
    if (body === '') delete headers['Content-Type'];
    return headers;
  }

  async call(capability: MachineAuthCapability, method: 'post' | 'get', path: string, payload?: unknown): Promise<DirectTeardownCall> {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const { request, serviceUrl } = this.options;
    if (this.options.io) {
      return this.options.io(path, { method, headers: this.headers(capability, body), ...(method === 'get' ? {} : { data: body }) });
    }
    const response = await request.fetch(serviceUrl + path, {
      method,
      headers: this.headers(capability, body),
      data: method === 'get' ? undefined : body,
    });
    let parsed: unknown;
    try { parsed = await response.json(); } catch { parsed = undefined; }
    return { status: response.status(), body: parsed };
  }

  /** Register before the first identity provisioning or business side effect. */
  async register(): Promise<RegisterResponse> {
    const { status, body } = await this.call('operation:register', 'post', '/cleanup-operations/register', {
      run_scope: this.options.runScope,
      test_scope: this.options.testScope,
      retry_index: this.options.retryIndex,
      lease_id: this.options.leaseId,
      lease_generation: this.options.leaseGeneration,
      expected_username: this.options.expectedUsername,
      expected_email: this.options.expectedEmail,
    });
    if (status !== 201 && status !== 200) throw new Error('Cleanup operation registration refused with ' + status);
    const result = body as RegisterResponse | undefined;
    if (!result || typeof result.operation_id !== 'string' || !Number.isInteger(result.state_version)) {
      throw new Error('Cleanup operation registration response is malformed');
    }
    this.operationId = result.operation_id;
    // The attempt now owns business cleanup for this scope, so its lease
    // disposition waits for an outcome instead of assuming one.
    bindAttemptBusinessCleanup(this.options.testInfo, this.options.expectedEmail);
    return result;
  }

  /** Bind only after Cognito confirmation, and only to this exact subject. */
  async bindOwner(ownerSub: string): Promise<OperationState> {
    const operationId = this.requireOperation();
    if (!SUBJECT.test(ownerSub)) throw new Error('Cleanup owner subject is malformed');
    const { status, body } = await this.call('operation:bind', 'post', '/cleanup-operations/owner-binding', {
      operation_id: operationId,
      lease_generation: this.options.leaseGeneration,
      owner_sub: ownerSub,
    });
    if (status !== 200) throw new Error('Cleanup owner binding refused with ' + status);
    return body as OperationState;
  }

  /** Record one exact created resource ID. Duplicate refs collapse. */
  capture(kind: ResourceKind, id: string): void {
    const ref: ResourceRef = { kind, id };
    assertRef(ref);
    if (!this.refs.some((existing) => existing.kind === kind && existing.id === id)) this.refs.push(ref);
  }

  async readState(): Promise<OperationState> {
    const operationId = this.requireOperation();
    const { status, body } = await this.call('operation:acknowledge', 'get', '/cleanup-operations/' + encodeURIComponent(operationId) + '/state');
    if (status !== 200) throw new Error('Cleanup operation state read refused with ' + status);
    return body as OperationState;
  }

  /**
   * Delete every captured reference through its user-facing DELETE route, and
   * record what each call returned.
   *
   * A `404` is not recorded as a deletion: it says the resource was not there.
   * Absence is what the read-back decides, and the status only attributes it, so
   * this step publishes `delete_status` and never a success flag.
   *
   * The captured set is traversed in schema order, not capture order: the order
   * is the contract described on `SCHEMA_DELETE_ORDER`, because a parent deleted
   * before the rows that reference it is refused by the database and turns a
   * complete cleanup into a partial one.
   */
  async runDeletes(authorization: string): Promise<ReferenceDelete[]> {
    const deletes: ReferenceDelete[] = [];
    for (const ref of schemaDeleteOrder(this.refs)) {
      const route = deleteRouteFor(ref);
      if (!route) {
        deletes.push({ ref, reason: 'no ordinary user-facing delete route' });
        continue;
      }
      try {
        if (this.options.deleteIo) {
          deletes.push({ ref, delete_status: await this.options.deleteIo(this.options.serviceUrl + route, authorization) });
          continue;
        }
        const response = await this.options.request.delete(this.options.serviceUrl + route, {
          // The Service's client-version gate covers the ordinary user-facing DELETE
          // routes, so a teardown delete carries the committed floor like every other
          // direct Service request. The `/cleanup-operations*` machine surface this class
          // also calls is exempt and stays headerless.
          headers: { ...CLIENT_VERSION_HEADERS, Authorization: authorization },
        });
        deletes.push({ ref, delete_status: response.status() });
      } catch (error) {
        deletes.push({ ref, reason: error instanceof Error ? error.message : 'unknown error' });
      }
    }
    return deletes;
  }

  /** One ordinary user-facing read, through the injected seam when a test supplies it. */
  private async read(url: string, authorization: string): Promise<{ status: number; body?: unknown }> {
    if (this.options.readIo) return this.options.readIo(url, authorization);
    const response = await this.options.request.get(url, {
      // The same client-version floor the deletes present: the read-back is an
      // ordinary user-facing request as well.
      headers: { ...CLIENT_VERSION_HEADERS, Authorization: authorization },
    });
    let body: unknown;
    try { body = await response.json(); } catch { body = undefined; }
    return { status: response.status(), body };
  }

  /**
   * The single base-photo read an attempt is allowed: `GET /vto/base-photos`.
   *
   * A base photo has no single-resource GET route, so the authenticated list is
   * its only absence proof. The body is parsed tolerantly because the only fact
   * this read needs is whether the captured id is still in it.
   */
  private async readBasePhotoList(authorization: string): Promise<{ ids?: Set<string>; reason?: string }> {
    try {
      const response = await this.read(this.options.serviceUrl + '/vto/base-photos', authorization);
      if (response.status < 200 || response.status >= 300) return { reason: 'base-photo list refused with ' + response.status };
      const ids = listedBasePhotoIds(response.body);
      return ids ? { ids } : { reason: 'base-photo list response is unrecognised' };
    } catch (error) {
      return { reason: error instanceof Error ? error.message : 'base-photo list request failed' };
    }
  }

  /**
   * Prove absence for every captured reference, before the acknowledgement.
   *
   * One routed `GET` per reference that has a read route (`wardrobe_item`,
   * `outfit` and `outfit_generation` reuse their delete path, because there is no
   * separate GET path), and at most one `GET /vto/base-photos` for all captured
   * base photos. `object_key` has neither a delete nor a read route, so it stays
   * fail-closed with no request. No retry: a read-back that fails proves nothing,
   * and `unverified` is the honest record.
   */
  private async readBack(deletes: readonly ReferenceDelete[], authorization: string): Promise<ReferenceEvidence[]> {
    const evidence: ReferenceEvidence[] = [];
    let basePhotoList: { ids?: Set<string>; reason?: string } | undefined;
    for (const record of deletes) {
      const deleteNote = record.reason ? 'delete failed: ' + record.reason : undefined;
      if (record.ref.kind === 'base_photo') {
        basePhotoList ??= await this.readBasePhotoList(authorization);
        const readback: ReferenceReadback = basePhotoList.ids
          ? (basePhotoList.ids.has(record.ref.id) ? 'present' : 'absent')
          : 'error';
        evidence.push(this.evidenceOf(record, readback, joinReasons(deleteNote, basePhotoList.reason)));
        continue;
      }
      const route = deleteRouteFor(record.ref);
      if (!route) {
        // `object_key`: neither route exists, so nothing can be proven. Unchanged
        // fail-closed, and deliberately no request of either kind.
        evidence.push({ ref: record.ref, readback: 'error', disposition: 'unverified', reason: 'no ordinary user-facing read route' });
        continue;
      }
      let readback: ReferenceReadback;
      let readNote: string | undefined;
      try {
        const response = await this.read(this.options.serviceUrl + route, authorization);
        if (response.status === 404) readback = 'absent';
        else if (response.status >= 200 && response.status < 300) readback = 'present';
        else { readback = 'error'; readNote = 'read-back refused with ' + response.status; }
      } catch (error) {
        readback = 'error';
        readNote = error instanceof Error ? error.message : 'read-back request failed';
      }
      evidence.push(this.evidenceOf(record, readback, joinReasons(deleteNote, readNote)));
    }
    return evidence;
  }

  private evidenceOf(record: ReferenceDelete, readback: ReferenceReadback, reason: string | undefined): ReferenceEvidence {
    return {
      ref: record.ref,
      ...(record.delete_status === undefined ? {} : { delete_status: record.delete_status }),
      readback,
      disposition: dispositionOf(record.delete_status, readback),
      ...(reason === undefined ? {} : { reason }),
    };
  }

  /**
   * Write the attempt's single terminal acknowledgement.
   *
   * Private by design: the read-back must not be skippable, so `finalize` is the
   * only caller and the delete-read-acknowledge order is a property of the type
   * rather than of reviewer attention.
   *
   * The product result is never rewritten by teardown; teardown alone picks the
   * scope state. This is also the attempt's single business-cleanup declaration
   * point: the declared outcome is recorded only once the Service has accepted
   * it, so a refused acknowledgement leaves the attempt's declaration open and
   * its lease fails closed.
   */
  private async acknowledge(productResult: ProductResult, teardownResult: TeardownResult, quarantineReason?: string): Promise<OperationState> {
    const operationId = this.requireOperation();
    const scopeState: ScopeState = teardownResult === 'passed' ? 'released' : 'quarantined';
    const { status, body } = await this.call('operation:acknowledge', 'post', '/cleanup-operations/acknowledge', {
      operation_id: operationId,
      lease_generation: this.options.leaseGeneration,
      product_result: productResult,
      teardown_result: teardownResult,
      scope_state: scopeState,
      resource_refs: this.refs,
      quarantine_reason: quarantineReason ?? null,
    });
    if (status !== 200) throw new Error('Cleanup acknowledgement refused with ' + status);
    closeAttemptBusinessCleanup(this.options.testInfo, {
      teardownResult,
      ...(quarantineReason ? { reason: quarantineReason } : {}),
    });
    return body as OperationState;
  }

  /**
   * Idempotent terminal step for one attempt: delete captured refs in schema
   * order, read every one of them back, then acknowledge the independent triple
   * the evidence decides.
   *
   * This is the only terminal entry point, so the acknowledgement is written
   * after the proof and never before it. `authorization` is optional only so an
   * attempt that holds no bearer token still closes its own declaration: nothing
   * can be deleted or read, so every captured reference is `unverified` and the
   * scope is quarantined. An attempt that captured nothing acknowledges `passed`
   * with no read-back request at all.
   *
   * The acknowledgement still carries the refs in capture order, because it
   * reports what the attempt created rather than how teardown released it.
   */
  async finalize(productResult: ProductResult, authorization?: string): Promise<DirectTeardownResult> {
    if (this.finalized) return this.finalized;
    const operationId = this.requireOperation();
    const captured = schemaDeleteOrder(this.refs);

    let evidence: ReferenceEvidence[] = [];
    let teardownResult: TeardownResult = 'passed';
    let quarantineReason: string | undefined;
    if (captured.length > 0) {
      if (!authorization) {
        // No bearer token: no delete and no read is possible, so no reference can
        // be proven absent. Every one stays unverified and the scope is
        // quarantined, but the declaration still closes instead of silently
        // passing as it used to.
        evidence = captured.map((ref): ReferenceEvidence => ({
          ref,
          readback: 'error',
          disposition: 'unverified',
          reason: 'no_authorization',
        }));
        teardownResult = 'failed';
        quarantineReason = 'no_authorization';
      } else {
        const deletes = await this.runDeletes(authorization);
        evidence = await this.readBack(deletes, authorization);
        teardownResult = teardownResultFor(evidence);
        if (teardownResult !== 'passed') quarantineReason = buildQuarantineReason(teardownResult, evidence);
      }
    }

    const scopeState: ScopeState = teardownResult === 'passed' ? 'released' : 'quarantined';
    await this.acknowledge(productResult, teardownResult, quarantineReason);
    this.finalized = {
      operation_id: operationId,
      product_result: productResult,
      teardown_result: teardownResult,
      scope_state: scopeState,
      ...(quarantineReason ? { quarantine_reason: quarantineReason } : {}),
      evidence,
    };
    return this.finalized;
  }
}

/** A teardown that is not `passed` quarantines its scope, so the next attempt allocates a fresh one. */
export function quarantinesScope(teardownResult: TeardownResult): boolean {
  return teardownResult !== 'passed';
}

