import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../server/store.js';

test('a passwordless account gets a shareable friend code and a private Vault Key', async () => {
  const store = new MemoryStore();
  const created = await store.createAccount({ displayName: 'Dai and Son' });

  assert.match(created.account.friendCode, /^ASH-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.match(created.vaultKey, /^VAULT-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.notEqual(created.account.friendCode, created.vaultKey);

  const restored = await store.restore({ vaultKey: created.vaultKey });
  assert.deepEqual(restored, created.account);
  await assert.rejects(store.restore({ vaultKey: 'VAULT-NOT-A-REAL-KEY' }), /not found/);
});
