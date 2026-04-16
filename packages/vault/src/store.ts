/**
 * Encrypted credential store, JSON-file backed.
 *
 * Why JSON + file lock, not SQLite:
 * - ~15 support agents × ~3 providers = ~45 records. Data size doesn't justify
 *   a database. JSON inspects trivially (ciphertext is opaque but the record
 *   index is legible).
 * - Zero native deps means the Docker image stays small and the base stage
 *   doesn't need a C toolchain. We can swap to SQLite behind this same
 *   interface if scale ever demands.
 *
 * Concurrency:
 * - All access goes through a single in-process mutex. Vault is a single
 *   container (one replica), so there are no multi-writer races to worry
 *   about. Async callers serialize.
 * - Writes are atomic via `write temp → rename`. A crash mid-write leaves
 *   the old file intact. readFile only ever sees a fully-written snapshot.
 *
 * Persistence shape:
 *   {
 *     "version": 1,
 *     "creds": {
 *       "U0AAFTTNBQB:salesforce": {
 *         "iv":"...", "ciphertext":"...", "tag":"...",
 *         "created_at": "2026-04-15T...",
 *         "updated_at": "2026-04-15T..."
 *       }
 *     }
 *   }
 *
 * The record key `{slack_uid}:{provider}` is the identity + capability scope.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { decrypt, encrypt, parseMasterKey, type EncryptedRecord } from "./crypto.js";

const FORMAT_VERSION = 1;

interface StoredRecord extends EncryptedRecord {
  created_at: string;
  updated_at: string;
}

interface StoreFileShape {
  version: number;
  creds: Record<string, StoredRecord>;
}

export interface StoreEntryMeta {
  slack_uid: string;
  provider: string;
  created_at: string;
  updated_at: string;
}

/** Simple in-process mutex. Serializes critical sections. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function recordKey(slack_uid: string, provider: string): string {
  return `${slack_uid}:${provider}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface VaultStoreOptions {
  /** Absolute path to the JSON file. */
  filePath: string;
  /** Base64 master key. */
  masterKey: string;
}

export class VaultStore {
  private readonly filePath: string;
  private readonly key: Buffer;
  private readonly mutex = new Mutex();

  constructor(opts: VaultStoreOptions) {
    this.filePath = opts.filePath;
    this.key = parseMasterKey(opts.masterKey);
    // Eagerly ensure parent dir + an empty file exist. First-run safety.
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!existsSync(this.filePath)) {
      const empty: StoreFileShape = { version: FORMAT_VERSION, creds: {} };
      writeFileSync(this.filePath, JSON.stringify(empty, null, 2), { mode: 0o600 });
    }
  }

  /** Load and parse the on-disk file, throwing on version mismatch. */
  private loadUnlocked(): StoreFileShape {
    const raw = readFileSync(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as StoreFileShape;
    if (parsed.version !== FORMAT_VERSION) {
      throw new Error(
        `Vault format version mismatch: file=${parsed.version}, expected=${FORMAT_VERSION}. ` +
          "Manual migration required.",
      );
    }
    return parsed;
  }

  /** Atomically persist a new state to disk. */
  private saveUnlocked(state: StoreFileShape): void {
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.filePath);
  }

  /** Store a credential record. Overwrites if it already exists. */
  async put(slack_uid: string, provider: string, secretJson: string): Promise<void> {
    const enc = encrypt(secretJson, this.key);
    await this.mutex.run(async () => {
      const state = this.loadUnlocked();
      const key = recordKey(slack_uid, provider);
      const existing = state.creds[key];
      state.creds[key] = {
        ...enc,
        created_at: existing?.created_at ?? nowIso(),
        updated_at: nowIso(),
      };
      this.saveUnlocked(state);
    });
  }

  /** Retrieve a credential record. Returns undefined if missing. */
  async get(slack_uid: string, provider: string): Promise<string | undefined> {
    return this.mutex.run(async () => {
      const state = this.loadUnlocked();
      const record = state.creds[recordKey(slack_uid, provider)];
      if (!record) return undefined;
      return decrypt(record, this.key);
    });
  }

  /** Delete a credential record. Returns true if it existed. */
  async delete(slack_uid: string, provider: string): Promise<boolean> {
    return this.mutex.run(async () => {
      const state = this.loadUnlocked();
      const key = recordKey(slack_uid, provider);
      if (!state.creds[key]) return false;
      delete state.creds[key];
      this.saveUnlocked(state);
      return true;
    });
  }

  /** List all records for a user (metadata only, no ciphertext). */
  async listByUser(slack_uid: string): Promise<StoreEntryMeta[]> {
    return this.mutex.run(async () => {
      const state = this.loadUnlocked();
      const out: StoreEntryMeta[] = [];
      for (const [k, rec] of Object.entries(state.creds)) {
        const [uid, provider] = k.split(":");
        if (uid === slack_uid) {
          out.push({
            slack_uid: uid,
            provider,
            created_at: rec.created_at,
            updated_at: rec.updated_at,
          });
        }
      }
      return out.sort((a, b) => a.provider.localeCompare(b.provider));
    });
  }

  /** List all records across all users (metadata only). For audit/admin use. */
  async listAll(): Promise<StoreEntryMeta[]> {
    return this.mutex.run(async () => {
      const state = this.loadUnlocked();
      const out: StoreEntryMeta[] = [];
      for (const [k, rec] of Object.entries(state.creds)) {
        const [uid, provider] = k.split(":");
        out.push({
          slack_uid: uid,
          provider,
          created_at: rec.created_at,
          updated_at: rec.updated_at,
        });
      }
      return out.sort((a, b) => {
        if (a.slack_uid !== b.slack_uid) return a.slack_uid.localeCompare(b.slack_uid);
        return a.provider.localeCompare(b.provider);
      });
    });
  }
}
