// Document synchronisation obligations: register an exact replacement, apply it only if the target still matches, read it back.
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const requireId = (value, label) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(`${label} must be a stable ID`);
  return value;
};

function locations(stateWorkspace, syncRoot) {
  if (!isAbsolute(stateWorkspace) || !isAbsolute(syncRoot)) throw new Error('Absolute sync paths are required');
  const workspace = realpathSync(stateWorkspace);
  const root = realpathSync(syncRoot);
  if (!lstatSync(workspace).isDirectory() || !lstatSync(root).isDirectory()) throw new Error('Sync roots must be directories');
  const inbox = join(workspace, '.inbox');
  if (!existsSync(inbox)) {
    try { mkdirSync(inbox, { mode: 0o700 }); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
  }
  const inboxStat = lstatSync(inbox);
  if (!inboxStat.isDirectory() || realpathSync(inbox) !== inbox || (inboxStat.mode & 0o077)) {
    throw new Error('Sync storage directory must be private and not a link');
  }
  const database = join(inbox, 'sync.sqlite');
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const path = `${database}${suffix}`;
    if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).nlink !== 1)) throw new Error('Unsafe sync storage file');
  }
  if (!existsSync(database)) {
    try { closeSync(openSync(database, 'wx', 0o600)); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
  }
  if (lstatSync(database).mode & 0o077) throw new Error('Sync database must be private');
  return { database, root };
}

function targetAtRoot(root, targetPath) {
  if (typeof targetPath !== 'string' || !isAbsolute(targetPath) || targetPath.includes('\0')) throw new Error('Absolute targetPath is required');
  const supplied = resolve(targetPath);
  let suppliedStat;
  try { suppliedStat = lstatSync(supplied); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const target = suppliedStat ? realpathSync(supplied) : join(realpathSync(dirname(supplied)), basename(supplied));
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Sync target must be inside the configured project root');
  }
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (!stat.isFile()) throw new Error('Sync target must resolve to a regular file');
  }
  return target;
}

function currentBytes(target) { return existsSync(target) ? readFileSync(target) : null; }
function version(bytes) { return bytes === null ? null : hash(bytes); }

function withStore(stateWorkspace, syncRoot, operation) {
  const { database, root } = locations(stateWorkspace, syncRoot);
  const db = new DatabaseSync(database, { timeout: 5000 });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = FULL');
    db.exec(`CREATE TABLE IF NOT EXISTS sync_obligations (
      card_id TEXT NOT NULL, obligation_id TEXT NOT NULL, target_path TEXT NOT NULL,
      old_text TEXT, new_text TEXT NOT NULL, base_sha256 TEXT, final_sha256 TEXT,
      revision INTEGER NOT NULL, verified_at TEXT,
      PRIMARY KEY (card_id, obligation_id)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS sync_revisions (
      card_id TEXT NOT NULL, obligation_id TEXT NOT NULL, revision INTEGER NOT NULL,
      target_path TEXT NOT NULL, base_sha256 TEXT, base_bytes BLOB, created_at TEXT NOT NULL,
      PRIMARY KEY (card_id, obligation_id, revision)
    )`);
    return operation(db, root);
  } finally { db.close(); }
}

function expectedBytes(base, oldText, newText) {
  if (base === null) {
    if (oldText !== null) throw new Error('New target requires oldText=null');
    return Buffer.from(newText);
  }
  if (oldText === null || oldText.length === 0) throw new Error('Existing target requires nonempty oldText');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(base);
  const first = source.indexOf(oldText);
  if (first < 0 || source.indexOf(oldText, first + oldText.length) >= 0) throw new Error('oldText must occur exactly once');
  return Buffer.from(source.slice(0, first) + newText + source.slice(first + oldText.length));
}

export function registerSyncObligation({ stateWorkspace, syncRoot, cardId, obligationId, targetPath, oldText = null, newText, expectedRevision = 0 }) {
  requireId(cardId, 'cardId');
  requireId(obligationId, 'obligationId');
  if (oldText !== null && (typeof oldText !== 'string' || oldText.length > 12000)) throw new Error('oldText must be null or at most 12000 characters');
  if (typeof newText !== 'string' || !newText.length || newText.length > 12000) throw new Error('newText must be 1–12000 characters');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('expectedRevision must be a nonnegative integer');
  return withStore(stateWorkspace, syncRoot, (db, root) => {
    const target = targetAtRoot(root, targetPath);
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare('SELECT * FROM sync_obligations WHERE card_id=? AND obligation_id=?').get(cardId, obligationId);
      if (existing?.target_path === target && existing.old_text === oldText && existing.new_text === newText) {
        db.exec('COMMIT');
        return { cardId, obligationId, revision: existing.revision, created: false, baseSha256: existing.base_sha256, finalSha256: existing.final_sha256 };
      }
      const revision = existing?.revision ?? 0;
      if (expectedRevision !== revision) throw new Error(`Sync obligation revision conflict: expected ${expectedRevision}, actual ${revision}`);
      const base = currentBytes(target);
      const final = expectedBytes(base, oldText, newText);
      const baseSha256 = version(base);
      const finalSha256 = hash(final);
      db.prepare(`INSERT INTO sync_obligations (card_id,obligation_id,target_path,old_text,new_text,base_sha256,final_sha256,revision,verified_at)
        VALUES (?,?,?,?,?,?,?,?,NULL)
        ON CONFLICT(card_id,obligation_id) DO UPDATE SET target_path=excluded.target_path,old_text=excluded.old_text,new_text=excluded.new_text,
        base_sha256=excluded.base_sha256,final_sha256=excluded.final_sha256,revision=excluded.revision,verified_at=NULL`)
        .run(cardId, obligationId, target, oldText, newText, baseSha256, finalSha256, revision + 1);
      db.prepare(`INSERT INTO sync_revisions (card_id,obligation_id,revision,target_path,base_sha256,base_bytes,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(cardId, obligationId, revision + 1, target, baseSha256, base, new Date().toISOString());
      db.exec('COMMIT');
      return { cardId, obligationId, revision: revision + 1, created: !existing, baseSha256, finalSha256 };
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  });
}

export function applySyncObligation({ stateWorkspace, syncRoot, cardId, obligationId, expectedRevision }) {
  requireId(cardId, 'cardId');
  requireId(obligationId, 'obligationId');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('expectedRevision must be a positive integer');
  return withStore(stateWorkspace, syncRoot, (db, root) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT * FROM sync_obligations WHERE card_id=? AND obligation_id=?').get(cardId, obligationId);
      if (!row) throw new Error('Sync obligation not found');
      if (row.revision !== expectedRevision) throw new Error(`Sync obligation revision conflict: expected ${expectedRevision}, actual ${row.revision}`);
      const recovery = db.prepare('SELECT base_bytes,base_sha256 FROM sync_revisions WHERE card_id=? AND obligation_id=? AND revision=?').get(cardId, obligationId, row.revision);
      if (!recovery || version(recovery.base_bytes) !== row.base_sha256 || recovery.base_sha256 !== row.base_sha256) {
        throw new Error('Recoverable target base version is missing or corrupt');
      }
      const target = targetAtRoot(root, row.target_path);
      const actual = currentBytes(target);
      if (version(actual) === row.final_sha256) {
        db.prepare('UPDATE sync_obligations SET verified_at=? WHERE card_id=? AND obligation_id=?').run(new Date().toISOString(), cardId, obligationId);
        db.exec('COMMIT');
// written：本次是否真的写入（与 applied 同值，命名明确）
        return { cardId, obligationId, revision: row.revision, applied: false, verified: true, finalSha256: row.final_sha256, written: false, target };
      }
      if (version(actual) !== row.base_sha256) throw new Error('Sync target version conflict; read target and revise obligation before retry');
      const expected = expectedBytes(actual, row.old_text, row.new_text);
      if (hash(expected) !== row.final_sha256) throw new Error('Sync expectation no longer matches registered version');
      if (actual === null) {
        try { writeFileSync(target, expected, { flag: 'wx', mode: 0o600 }); }
        catch (error) { if (error?.code === 'EEXIST') throw new Error('Sync target version conflict'); throw error; }
      } else {
        const temporary = join(dirname(target), `.sync-${randomUUID()}.tmp`);
        try {
          writeFileSync(temporary, expected, { flag: 'wx', mode: lstatSync(target).mode & 0o777 });
          if (version(currentBytes(target)) !== row.base_sha256) throw new Error('Sync target changed during update');
          renameSync(temporary, target);
        } finally { if (existsSync(temporary)) unlinkSync(temporary); }
      }
      if (version(currentBytes(target)) !== row.final_sha256) throw new Error('Sync write failed readback');
      db.prepare('UPDATE sync_obligations SET verified_at=? WHERE card_id=? AND obligation_id=?').run(new Date().toISOString(), cardId, obligationId);
      db.exec('COMMIT');
      return { cardId, obligationId, revision: row.revision, applied: true, verified: true, finalSha256: row.final_sha256, written: true, target };
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  });
}

export function verifySyncCard({ stateWorkspace, syncRoot, cardId }) {
  requireId(cardId, 'cardId');
  return withStore(stateWorkspace, syncRoot, (db, root) => {
    const rows = db.prepare('SELECT * FROM sync_obligations WHERE card_id=? ORDER BY obligation_id').all(cardId);
    const obligations = rows.map((row) => {
      const target = targetAtRoot(root, row.target_path);
      const actualSha256 = version(currentBytes(target));
      return { obligationId: row.obligation_id, revision: row.revision, targetPath: target, verified: actualSha256 === row.final_sha256, actualSha256, expectedSha256: row.final_sha256 };
    });
    return { cardId, obligations, verified: obligations.every((entry) => entry.verified) };
  });
}
