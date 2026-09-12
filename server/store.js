// Online persistence. PostgreSQL is required in production; the in-memory
// implementation keeps local development and automated tests frictionless.

import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';

const scrypt = promisify(scryptCallback);
const { Pool } = pg;

export async function hashPassword(password) {
  const salt = randomUUID();
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${Buffer.from(derived).toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [kind, salt, hex] = String(stored).split('$');
  if (kind !== 'scrypt' || !salt || !hex) return false;
  const derived = Buffer.from(await scrypt(password, salt, 64));
  const expected = Buffer.from(hex, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function normaliseDisplayName(value) {
  return String(value ?? '').trim();
}

function assertDisplayName(displayName) {
  if (!/^[a-zA-Z0-9 _-]{3,20}$/.test(displayName)) {
    throw new Error('Name must be 3–20 letters, numbers, spaces, _ or -.');
  }
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function code(prefix, groups) {
  const bytes = randomBytes(groups * 4);
  const bits = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${prefix}-${bits.match(/.{1,4}/g).join('-')}`;
}
const accountView = (account) => ({ id: account.id, displayName: account.displayName, friendCode: account.friendCode });

export class MemoryStore {
  constructor() { this.accounts = new Map(); this.byFriendCode = new Map(); this.saves = new Map(); }
  async init() {}
  async createAccount({ displayName }) {
    const name = normaliseDisplayName(displayName); assertDisplayName(name);
    let friendCode; do { friendCode = code('ASH', 2); } while (this.byFriendCode.has(friendCode));
    const vaultKey = code('VAULT', 3);
    const account = { id: randomUUID(), displayName: name, friendCode, vaultKeyHash: await hashPassword(vaultKey), createdAt: new Date().toISOString() };
    this.accounts.set(account.id, account); this.byFriendCode.set(friendCode, account.id);
    return { account: accountView(account), vaultKey };
  }
  async restore({ vaultKey }) {
    for (const account of this.accounts.values()) {
      if (await verifyPassword(vaultKey, account.vaultKeyHash)) return accountView(account);
    }
    throw new Error('That Vault Key was not found. Check every group and dash.');
  }
  async getAccount(id) { const a = this.accounts.get(id); return a ? accountView(a) : null; }
  async loadSave(accountId) { return this.saves.get(accountId) ?? null; }
  async save(accountId, state) { this.saves.set(accountId, state); }
}

export class PostgresStore {
  constructor(url) { this.pool = new Pool({ connectionString: url, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } }); }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS accounts (
      id uuid PRIMARY KEY, username text UNIQUE NOT NULL, password_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS display_name text;
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS friend_code text UNIQUE;
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS vault_key_hash text;
    CREATE TABLE IF NOT EXISTS game_saves (
      account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
    );`);
  }
  async createAccount({ displayName }) {
    const name = normaliseDisplayName(displayName); assertDisplayName(name);
    const id = randomUUID(); const vaultKey = code('VAULT', 3); const vaultKeyHash = await hashPassword(vaultKey);
    for (let tries = 0; tries < 5; tries++) {
      const friendCode = code('ASH', 2);
      try {
        // Legacy columns stay populated during the passwordless migration.
        await this.pool.query('INSERT INTO accounts (id, username, password_hash, display_name, friend_code, vault_key_hash) VALUES ($1, $2, $3, $4, $5, $6)', [id, `player_${id}`, 'passwordless', name, friendCode, vaultKeyHash]);
        return { account: { id, displayName: name, friendCode }, vaultKey };
      } catch (error) { if (error.code !== '23505') throw error; }
    }
    throw new Error('Could not mint a unique friend code. Try again.');
  }
  async restore({ vaultKey }) {
    const { rows } = await this.pool.query('SELECT id, display_name, friend_code, vault_key_hash FROM accounts WHERE vault_key_hash IS NOT NULL');
    for (const account of rows) {
      if (await verifyPassword(vaultKey, account.vault_key_hash)) {
        await this.pool.query('UPDATE accounts SET last_seen_at = now() WHERE id = $1', [account.id]);
        return { id: account.id, displayName: account.display_name, friendCode: account.friend_code };
      }
    }
    throw new Error('That Vault Key was not found. Check every group and dash.');
  }
  async getAccount(id) {
    const { rows } = await this.pool.query('SELECT id, COALESCE(display_name, username) AS "displayName", friend_code AS "friendCode" FROM accounts WHERE id = $1', [id]);
    return rows[0] ?? null;
  }
  async loadSave(accountId) { const { rows } = await this.pool.query('SELECT state FROM game_saves WHERE account_id = $1', [accountId]); return rows[0]?.state ?? null; }
  async save(accountId, state) { await this.pool.query(`INSERT INTO game_saves (account_id, state) VALUES ($1, $2::jsonb)
    ON CONFLICT (account_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`, [accountId, JSON.stringify(state)]); }
  async close() { await this.pool.end(); }
}

export function createStore() { return process.env.DATABASE_URL ? new PostgresStore(process.env.DATABASE_URL) : new MemoryStore(); }
