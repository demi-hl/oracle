// Durable JSON store for strategy shadow runners. Fail-closed, no network, no secrets.

import fs from "node:fs";
import path from "node:path";

const STORE_VERSION = 1;

const SECRET_KEYS = [
  "privatekey",
  "secretkey",
  "seed",
  "mnemonic",
  "passphrase",
  "password",
  "keystore",
  "keymaterial",
  "apikey",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "credential",
  "bearer",
  "signature",
  "authorization",
  "xprv",
  "xpriv",
  "wif",
];

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function assertNoSecrets(value, at = "record") {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoSecrets(item, `${at}[${i}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const norm = normalizeKey(key);
    if (SECRET_KEYS.some((token) => norm.includes(token))) {
      throw new Error(`shadow-store: forbidden secret-like field at ${at}.${key}`);
    }
    assertNoSecrets(child, `${at}.${key}`);
  }
}

function assertAbsolutePath(p) {
  if (typeof p !== "string" || !p || !path.isAbsolute(p)) {
    throw new Error("shadow-store: path must be an absolute path");
  }
}

function assertSafeExistingFile(filePath) {
  let st;
  try {
    st = fs.lstatSync(filePath);
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new Error("shadow-store: store path must not be a symlink");
  }
  if (!st.isFile()) {
    throw new Error("shadow-store: store path must be a regular file");
  }
  const mode = st.mode & 0o777;
  if (mode & 0o022) {
    throw new Error("shadow-store: store file must not be group or world writable");
  }
}

function emptyDoc() {
  return { version: STORE_VERSION, runners: [] };
}

function parseDoc(raw, filePath) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("shadow-store: malformed JSON");
  }
  if (!isPlainObject(parsed)) {
    throw new Error("shadow-store: malformed JSON root");
  }
  if (parsed.version !== STORE_VERSION) {
    throw new Error(`shadow-store: unsupported version ${parsed.version}`);
  }
  if (!Array.isArray(parsed.runners)) {
    throw new Error("shadow-store: runners must be an array");
  }
  assertNoSecrets(parsed, path.basename(filePath));
  return { version: STORE_VERSION, runners: parsed.runners.map((r) => deepClone(r)) };
}

function writeAtomic(filePath, doc) {
  assertNoSecrets(doc, "store");
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.shadow-store.${process.pid}.${Date.now()}.tmp`);
  const body = `${JSON.stringify(doc)}\n`;
  try {
    fs.writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* best effort */
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

// One API instance per absolute path so concurrent openers share the mutex.
const instances = new Map();

/**
 * Open a durable shadow runner store at an absolute path.
 * @param {{path: string}} opts
 */
export function openShadowStore(opts = {}) {
  const storePath = opts.path;
  assertAbsolutePath(storePath);
  assertSafeExistingFile(storePath);

  if (!fs.existsSync(storePath)) {
    writeAtomic(storePath, emptyDoc());
  } else {
    parseDoc(fs.readFileSync(storePath, "utf8"), storePath);
  }

  if (instances.has(storePath)) {
    return instances.get(storePath);
  }

  let busy = false;
  /** @type {Array<{fn: Function, resolve: Function, reject: Function}>} */
  const queue = [];

  function pump() {
    if (busy) return;
    const next = queue.shift();
    if (!next) return;
    busy = true;
    try {
      const result = next.fn();
      busy = false;
      next.resolve(result);
      pump();
    } catch (e) {
      busy = false;
      next.reject(e);
      pump();
    }
  }

  /**
   * Process-local serialized mutations. Sync when idle; Promise when contended
   * so concurrent awaiters do not lose updates.
   */
  function exclusive(fn) {
    if (!busy && queue.length === 0) {
      busy = true;
      try {
        return fn();
      } finally {
        busy = false;
        queueMicrotask(pump);
      }
    }
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      queueMicrotask(pump);
    });
  }

  function readDoc() {
    assertSafeExistingFile(storePath);
    return parseDoc(fs.readFileSync(storePath, "utf8"), storePath);
  }

  function persist(doc) {
    writeAtomic(storePath, doc);
  }

  function createImpl(record) {
    if (!isPlainObject(record) || typeof record.id !== "string" || !record.id) {
      throw new Error("shadow-store: create requires record with string id");
    }
    assertNoSecrets(record, "record");
    const doc = readDoc();
    if (doc.runners.some((r) => r.id === record.id)) {
      throw new Error(`shadow-store: runner id already exists: ${record.id}`);
    }
    const stored = deepClone(record);
    doc.runners.push(stored);
    persist(doc);
    return deepClone(stored);
  }

  function getImpl(id) {
    const found = readDoc().runners.find((r) => r.id === id);
    return found ? deepClone(found) : null;
  }

  function listImpl() {
    return readDoc().runners.map((r) => deepClone(r));
  }

  function updateImpl(id, updater) {
    if (typeof updater !== "function") {
      throw new Error("shadow-store: updater must be a function");
    }
    const doc = readDoc();
    const idx = doc.runners.findIndex((r) => r.id === id);
    if (idx < 0) throw new Error(`shadow-store: runner not found: ${id}`);
    const current = deepClone(doc.runners[idx]);
    const next = updater(current);
    if (!isPlainObject(next) || next.id !== id) {
      throw new Error("shadow-store: updater must return record with same id");
    }
    assertNoSecrets(next, "record");
    doc.runners[idx] = deepClone(next);
    persist(doc);
    return deepClone(doc.runners[idx]);
  }

  function stopImpl(id) {
    const doc = readDoc();
    const idx = doc.runners.findIndex((r) => r.id === id);
    if (idx < 0) throw new Error(`shadow-store: runner not found: ${id}`);
    const rec = deepClone(doc.runners[idx]);
    if (rec.status !== "stopped") {
      rec.status = "stopped";
      doc.runners[idx] = rec;
      persist(doc);
    }
    return deepClone(doc.runners[idx]);
  }

  const api = {
    create(record) {
      return exclusive(() => createImpl(record));
    },
    get(id) {
      return getImpl(id);
    },
    list() {
      return listImpl();
    },
    update(id, updater) {
      return exclusive(() => updateImpl(id, updater));
    },
    stop(id) {
      return exclusive(() => stopImpl(id));
    },
  };

  instances.set(storePath, api);
  return api;
}
