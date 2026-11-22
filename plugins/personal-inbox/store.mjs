// Note inbox storage (SQLite in the agent workspace): capture, lookup and link to a task card.
import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const inboxName = '.inbox';
const databaseName = 'items.sqlite';

function requireText(value, label, maxLength) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength || value.includes('\0')) {
    throw new Error(`${label} must be a nonempty string of at most ${maxLength} characters`);
  }
  return value;
}

function optionalText(value, label, maxLength) {
  return value === undefined ? null : requireText(value, label, maxLength);
}

function safeExistingFile(path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Inbox storage has an unsafe file or link');
}

function storagePath(workspaceDir, create) {
  if (typeof workspaceDir !== 'string' || !isAbsolute(workspaceDir)) {
    throw new Error('An absolute active agent workspace is required');
  }
  const root = realpathSync(workspaceDir);
  if (!lstatSync(root).isDirectory()) throw new Error('Agent workspace is not a directory');
  const dir = join(root, inboxName);
  if (!existsSync(dir)) {
    if (!create) return null;
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || realpathSync(dir) !== dir) {
    throw new Error('Inbox directory must be inside the active agent workspace');
  }
  if (stat.mode & 0o077) throw new Error('Inbox directory must be private (0700)');
  const dbPath = join(dir, databaseName);
  safeExistingFile(dbPath);
  safeExistingFile(`${dbPath}-journal`);
  safeExistingFile(`${dbPath}-wal`);
  safeExistingFile(`${dbPath}-shm`);
  if (!existsSync(dbPath)) {
    if (!create) return null;
    try {
      closeSync(openSync(dbPath, 'wx', 0o600));
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    safeExistingFile(dbPath);
  }
  if (lstatSync(dbPath).mode & 0o077) throw new Error('Inbox database must be private (0600)');
  return dbPath;
}

function withDatabase(workspaceDir, create, operation) {
  const path = storagePath(workspaceDir, create);
  if (path === null) return operation(null);
  const db = new DatabaseSync(path, { timeout: 5000, readOnly: !create });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    if (create) {
      db.exec(`CREATE TABLE IF NOT EXISTS items (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK(kind IN ('note', 'action')),
        original_text TEXT NOT NULL,
        source_ref TEXT,
        created_at TEXT NOT NULL,
        card_id TEXT,
        card_linked_at TEXT
      )`);
    }
    return operation(db);
  } finally {
    db.close();
  }
}

function publicItem(row) {
  if (!row) return null;
  return {
    id: `I-${String(row.seq).padStart(4, '0')}`,
    kind: row.kind,
    originalText: row.original_text,
    sourceRef: row.source_ref,
    createdAt: row.created_at,
    workboardCardId: row.card_id,
    cardLinkedAt: row.card_linked_at,
    progressVerification: row.kind === 'action' ? 'unverified' : null,
  };
}

function seqFromId(id) {
  requireText(id, 'id', 32);
  const match = /^I-(0*[1-9][0-9]*)$/i.exec(id);
  if (!match) throw new Error('Inbox id must have the form I-0001');
  const seq = Number(match[1]);
  if (!Number.isSafeInteger(seq)) throw new Error('Inbox id is out of range');
  return seq;
}

export function captureInbox({ workspaceDir, kind, originalText, idempotencyKey, sourceRef }) {
  if (kind !== 'note' && kind !== 'action') throw new Error('kind must be note or action');
  requireText(originalText, 'originalText', 12000);
  requireText(idempotencyKey, 'idempotencyKey', 200);
  const source = optionalText(sourceRef, 'sourceRef', 300);
  return withDatabase(workspaceDir, true, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare('SELECT * FROM items WHERE idempotency_key = ?').get(idempotencyKey);
      if (existing) {
        if (existing.kind !== kind || existing.original_text !== originalText || existing.source_ref !== source) {
          throw new Error('Idempotency key already belongs to a different inbox item');
        }
        db.exec('COMMIT');
        return { item: publicItem(existing), created: false, persisted: true };
      }
      const createdAt = new Date().toISOString();
      const result = db.prepare('INSERT INTO items (idempotency_key, kind, original_text, source_ref, created_at) VALUES (?, ?, ?, ?, ?)').run(idempotencyKey, kind, originalText, source, createdAt);
      db.exec('COMMIT');
      const saved = db.prepare('SELECT * FROM items WHERE seq = ?').get(result.lastInsertRowid);
      if (!saved) throw new Error('Inbox write could not be read back');
      return { item: publicItem(saved), created: true, persisted: true };
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  });
}

export function lookupInbox({ workspaceDir, id, query, limit = 10 }) {
  if ((id === undefined) === (query === undefined)) throw new Error('Provide exactly one of id or query');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit must be 1–50');
  const seq = id === undefined ? null : seqFromId(id);
  const terms = query === undefined ? null : requireText(query, 'query', 200).trim().toLocaleLowerCase().split(/\s+/u);
  if (terms?.some((term) => !term)) throw new Error('query must contain a search term');
  return withDatabase(workspaceDir, false, (db) => {
    if (!db) return { items: [], persisted: true };
    if (seq !== null) {
      const row = db.prepare('SELECT * FROM items WHERE seq = ?').get(seq);
      return { items: row ? [publicItem(row)] : [], persisted: true };
    }
    const rows = db.prepare('SELECT * FROM items ORDER BY seq DESC').all();
    const matched = rows.filter((row) => {
      const searchable = `${row.original_text} ${row.source_ref ?? ''} ${row.card_id ?? ''}`.toLocaleLowerCase();
      return terms.every((term) => searchable.includes(term));
    });
    return { items: matched.slice(0, limit).map(publicItem), persisted: true };
  });
}

export function linkInboxCard({ workspaceDir, id, workboardCardId }) {
  const seq = seqFromId(id);
  requireText(workboardCardId, 'workboardCardId', 128);
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(workboardCardId)) {
    throw new Error('workboardCardId has an invalid format');
  }
  return withDatabase(workspaceDir, true, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare('SELECT * FROM items WHERE seq = ?').get(seq);
      if (!existing) throw new Error('Inbox item not found');
      if (existing.kind !== 'action') throw new Error('Only action items can link Workboard cards');
      if (existing.card_id && existing.card_id !== workboardCardId) {
        throw new Error('Inbox action is already linked to a different Workboard card');
      }
      const linked = !existing.card_id;
      if (linked) {
        db.prepare('UPDATE items SET card_id = ?, card_linked_at = ? WHERE seq = ?').run(workboardCardId, new Date().toISOString(), seq);
      }
      db.exec('COMMIT');
      const saved = db.prepare('SELECT * FROM items WHERE seq = ?').get(seq);
      if (!saved || saved.card_id !== workboardCardId) throw new Error('Card link could not be read back');
      return { item: publicItem(saved), linked, persisted: true, cardExistenceVerification: 'unverified' };
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  });
}
