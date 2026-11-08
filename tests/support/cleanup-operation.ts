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
}

export interface DeleteOutcome {
  ref: ResourceRef;
  status: number | undefined;
  deleted: boolean;
  reason?: string;
}

export interface DirectTeardownResult {
  operation_id: string;
  product_result: ProductResult;
  teardown_result: TeardownResult;
  scope_state: ScopeState;
  quarantine_reason?: string;
  deletions: DeleteOutcome[];
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
 * One Service-owned cleanup operation for a single test attempt.
 *
 * Call order is enforced by construction: `register()` before provisioning,
 * `bindOwner()` after Cognito confirmation, `capture()` during the test body, and
 * `finalize()` in `finally`. `finalize()` is idempotent per attempt.
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
   * Delete every captured reference through its user-facing DELETE route; 404 is
   * success.
   *
   * The captured set is traversed in schema order, not capture order: the order
   * is the contract described on `SCHEMA_DELETE_ORDER`, because a parent deleted
   * before the rows that reference it is refused by the database and turns a
   * complete cleanup into a partial one.
   */
  async runDeletes(authorization: string): Promise<{ outcomes: DeleteOutcome[]; teardownResult: TeardownResult }> {
    const outcomes: DeleteOutcome[] = [];
    for (const ref of schemaDeleteOrder(this.refs)) {
      const route = deleteRouteFor(ref);
      if (!route) {
        outcomes.push({ ref, status: undefined, deleted: false, reason: 'no ordinary user-facing delete route' });
        continue;
      }
      try {
        if (this.options.deleteIo) {
          const status = await this.options.deleteIo(this.options.serviceUrl + route, authorization);
          outcomes.push({ ref, status, deleted: status === 200 || status === 204 || status === 404 });
          continue;
        }
        const response = await this.options.request.delete(this.options.serviceUrl + route, {
          // The Service's client-version gate covers the ordinary user-facing DELETE
          // routes, so a teardown delete carries the committed floor like every other
          // direct Service request. The `/cleanup-operations*` machine surface this class
          // also calls is exempt and stays headerless.
          headers: { ...CLIENT_VERSION_HEADERS, Authorization: authorization },
        });
        const status = response.status();
        outcomes.push({ ref, status, deleted: status === 200 || status === 204 || status === 404 });
      } catch (error) {
        outcomes.push({ ref, status: undefined, deleted: false, reason: error instanceof Error ? error.message : 'unknown error' });
      }
    }
    const failed = outcomes.filter((outcome) => !outcome.deleted).length;
    const teardownResult: TeardownResult = failed === 0 ? 'passed' : failed === outcomes.length ? 'failed' : 'partial';
    return { outcomes, teardownResult };
  }

  /**
   * The product result is never rewritten by teardown; teardown alone picks the
   * scope state. This is also the attempt's single business-cleanup declaration
   * point: the declared outcome is recorded only once the Service has accepted
   * it, so a refused acknowledgement leaves the attempt's declaration open and
   * its lease fails closed.
   */
  async acknowledge(productResult: ProductResult, teardownResult: TeardownResult, quarantineReason?: string): Promise<OperationState> {
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
   * order, acknowledge the independent triple, and report the scope disposition.
   * The acknowledgement still carries the refs in capture order, because it
   * reports what the attempt created rather than how teardown released it.
   */
  async finalize(productResult: ProductResult, authorization: string): Promise<DirectTeardownResult> {
    if (this.finalized) return this.finalized;
    const { outcomes, teardownResult } = await this.runDeletes(authorization);
    const scopeState: ScopeState = teardownResult === 'passed' ? 'released' : 'quarantined';
    const undeleted = outcomes.filter((outcome) => !outcome.deleted).map((outcome) => outcome.ref.kind + ':' + outcome.ref.id);
    const quarantineReason = teardownResult === 'passed' ? undefined : 'teardown ' + teardownResult + '; undeleted ' + (undeleted.join(', ') || 'none');
    await this.acknowledge(productResult, teardownResult, quarantineReason);
    this.finalized = {
      operation_id: this.requireOperation(),
      product_result: productResult,
      teardown_result: teardownResult,
      scope_state: scopeState,
      ...(quarantineReason ? { quarantine_reason: quarantineReason } : {}),
      deletions: outcomes,
    };
    return this.finalized;
  }
}

/** A teardown that is not `passed` quarantines its scope, so the next attempt allocates a fresh one. */
export function quarantinesScope(teardownResult: TeardownResult): boolean {
  return teardownResult !== 'passed';
}

