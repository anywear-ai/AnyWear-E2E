import assert from 'node:assert/strict';
import test from 'node:test';
import { owner, repositories, repositoryIds, requireOwnedRepository } from './evidence-contract.mjs';

// #266: the declared owner is the organization the repositories transfer to. The repository
// numeric ids do not change in the transfer, so the repository half of every identity below
// is the same value the pre-transfer contract used.
const protectedE2E = {
  full_name: 'anywear-ai/AnyWear-E2E',
  id: 1317091305,
  fork: false,
  owner: { login: 'anywear-ai', id: 352675702 },
};

test('the declared owner is anywear-ai and every repository name carries it', () => {
  assert.deepEqual(owner, { login: 'anywear-ai', id: 352675702 });
  assert.deepEqual(repositories, {
    client: 'anywear-ai/AnyWear-Client',
    service: 'anywear-ai/AnyWear-Service',
    infra: 'anywear-ai/AnyWear-Infra',
    e2e: 'anywear-ai/AnyWear-E2E',
  });
  // The name map and the id map stay keyed by the same four full names; only the owner half
  // moved, so each numeric id is exactly the pre-transfer value.
  assert.deepEqual(repositoryIds, {
    'anywear-ai/AnyWear-Client': 1176104200,
    'anywear-ai/AnyWear-Service': 1158460323,
    'anywear-ai/AnyWear-Infra': 1409047265,
    'anywear-ai/AnyWear-E2E': 1317091305,
  });
});

test('accepts a repository owned by anywear-ai with its unchanged numeric id', () => {
  assert.equal(requireOwnedRepository(protectedE2E, repositories.e2e, 'E2E repository'), protectedE2E);
});

test('refuses the old owner, a changed id, a fork or a mismatched full name', () => {
  for (const [label, value] of [
    // The old owner identity: both the login and the owner id moved in the transfer.
    ['old owner', { ...protectedE2E, owner: { login: 'git-malu', id: 11473072 } }],
    // A changed repository id is a different repository, even under the new owner name.
    ['changed repository id', { ...protectedE2E, id: 1409047265 }],
    // A fork keeps the owner and often the name but is not the protected repository.
    ['fork', { ...protectedE2E, fork: true }],
    // The id and owner are right, but the value names another repository.
    ['mismatched full name', { ...protectedE2E, full_name: 'anywear-ai/AnyWear-Client' }],
    // The old owner in both fields is refused by the full-name and owner clauses.
    ['old full name', { ...protectedE2E, full_name: 'git-malu/AnyWear-E2E' }],
  ]) {
    assert.throws(() => requireOwnedRepository(value, repositories.e2e, 'E2E repository'),
      /E2E repository is not the protected anywear-ai repository/, label);
  }
  // An unknown repository name and a missing value fail closed rather than defaulting.
  assert.throws(() => requireOwnedRepository(protectedE2E, 'anywear-ai/AnyWear-Other', 'Other repository'),
    /Other repository is not a known AnyWear repository/);
  assert.throws(() => requireOwnedRepository(undefined, repositories.e2e, 'E2E repository'),
    /E2E repository is missing/);
  assert.throws(() => requireOwnedRepository({ ...protectedE2E, owner: undefined }, repositories.e2e, 'E2E repository'),
    /E2E repository owner is required/);
});
