export function readCleanupPair(environment: NodeJS.ProcessEnv): { serviceCommit: string; imageDigest: string };

export class CleanupSourceRefusal extends Error {
  constructor(reason: string, options?: { value?: unknown; operation?: string; detail?: string; cause?: Error });
  readonly code: 'E2E_CLEANUP_SOURCE_REFUSED';
  readonly reason: string;
}

export class CleanupImageRefusal extends Error {
  constructor(reason: string, options?: { value?: unknown; operation?: string; detail?: string; cause?: Error });
  readonly code: 'E2E_CLEANUP_IMAGE_REFUSED';
  readonly reason: string;
}
