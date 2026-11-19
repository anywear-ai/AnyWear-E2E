// The ONLY committed platform knowledge (#228): the reviewed entry-point identifiers.
//
// The platform observation is a black-box consumer: it discovers the deployed surface
// through AWS public list/describe APIs and hashes it with public standards, so no
// producer source and no committed name list enters this repository. This module carries
// exactly the entry points that discovery is bounded by and nothing else:
//
// - the stage path `/anywear/beta/` the stage base publishes under;
// - the `AnyWear` stack-name prefix;
// - the one stack whose publication the qualification reads for the cleanup capability
//   version ARN (`AnyWearRuntimeStack-beta`, #287);
// - the `beta-anywear-` queue-name prefix, which is also the prefix of the Service-built
//   Lambda function names;
// - the account identity, carried by the qualification credential: read from the
//   execution environment's `AWS_ACCOUNT_ID` and verified by the observation's STS guard;
// - the observation region set: the credential region `ap-east-1` plus the committed
//   Billing region `us-east-1`;
// - the terminal stack statuses a recorded stack row may carry;
// - the pagination page bound every discovery list read must stay within.
//
// `scripts/platform-entrypoints.test.mjs` is the census that asserts this module
// contains exactly these identifiers and nothing else.
export const STAGE_PATH = '/anywear/beta/';
export const STACK_NAME_PREFIX = 'AnyWear';
// #287: the one stack the infrastructure repository publishes the cleanup capability version
// ARN from. The qualification reads only this stack's outputs, so the version is the
// deployment's own statement rather than a copy held in either repository. The stack name
// describes a deployment, not a revision: no version number or version ARN is committed here.
export const RUNTIME_STACK_NAME = 'AnyWearRuntimeStack-beta';
export const QUEUE_NAME_PREFIX = 'beta-anywear-';
export const CREDENTIAL_REGION = 'ap-east-1';
export const BILLING_REGION = 'us-east-1';
export const OBSERVATION_REGIONS = Object.freeze([CREDENTIAL_REGION, BILLING_REGION]);
export const TERMINAL_STACK_STATUSES = Object.freeze(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE']);
export const PAGINATION_PAGE_BOUND = 50;

// The reviewed account is carried by the qualification credential, never committed here:
// the workflow constant `AWS_ACCOUNT_ID` names it and the observation's STS guard
// verifies the caller against it before any discovery read.
export function account(environment = process.env) {
  const value = environment?.AWS_ACCOUNT_ID;
  if (typeof value !== 'string' || !/^[0-9]{12}$/.test(value)) {
    throw new Error('AWS_ACCOUNT_ID is required as the reviewed Beta account id');
  }
  return value;
}
