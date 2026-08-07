// Shared refusal for pre-signed material returned by an upstream marketplace or
// aggregator API. Every prepare path calls this before selecting unsigned bytes
// or binding the upstream response into a stamped envelope.

const MAX_DEPTH = 16;
const MAX_NODES = 2048;

const UNSIGNED_PREFIXES = ["unsigned", "notsigned", "tosign", "signable"];

const STATUS_KEYS = new Set([
  "requiresusersignature",
  "requiressignature",
  "needssignature",
  "signaturerequired",
  "signaturesrequired",
  "signingready",
  "signaturecount",
  "signaturethreshold",
  "requiredsignatures",
  "signatureneeded",
  "hassignature",
  "allowsignatures",
  "requestsignature",
  "multisig",
  "cosig",
  "msig",
]);

const MATERIAL_KEYS = new Set([
  "sig",
  "sigs",
  "scriptsig",
  "witness",
  "psbt",
  "finalizedpsbt",
  "completepsbt",
  "finalpsbt",
  "psbtfinalized",
  "serializedtransaction",
]);

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isUnsignedField(norm) {
  return UNSIGNED_PREFIXES.some((prefix) => norm.startsWith(prefix)) || STATUS_KEYS.has(norm);
}

function isSignedMaterialKey(key) {
  const raw = String(key);
  if (!/^[\x20-\x7e]+$/.test(raw)) return true;
  const norm = normalizeKey(raw);
  if (isUnsignedField(norm)) return false;
  if (MATERIAL_KEYS.has(norm)) return true;
  return norm.includes("signed") || norm.includes("signature") || norm.endsWith("sig") || norm.endsWith("sigs");
}

function isSignatureTuple(value) {
  const v = Number(value?.v);
  const r = String(value?.r || "");
  const s = String(value?.s || "");
  return [0, 1, 27, 28].includes(v) && /^0x[0-9a-f]{2,64}$/i.test(r) && /^0x[0-9a-f]{2,64}$/i.test(s);
}

/** Find signed-material field names anywhere in an upstream response. */
export function findSignedFields(value, depth = 0, seen = new Set(), state = { nodes: 0 }) {
  if (value == null || typeof value !== "object") return [];
  if (depth > MAX_DEPTH) return ["<max-depth>"];
  if (seen.has(value)) return [];
  state.nodes += 1;
  if (state.nodes > MAX_NODES) return ["<max-nodes>"];
  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap((item) => findSignedFields(item, depth + 1, seen, state));
  }

  const hits = [];
  for (const [key, child] of Object.entries(value)) {
    if (isSignedMaterialKey(key)) {
      hits.push(key);
      continue;
    }
    hits.push(...findSignedFields(child, depth + 1, seen, state));
  }

  const keys = Object.keys(value).map(normalizeKey);
  const hasPsbt = keys.some((key) => key.endsWith("psbt") || key.endsWith("psbtbase64"));
  const claimsComplete = Object.entries(value).some(
    ([key, child]) => /complete|finalized|isfinal/.test(normalizeKey(key)) && child === true,
  );
  if (hasPsbt && claimsComplete) hits.push("psbt(complete)");
  if (isSignatureTuple(value)) hits.push("v/r/s");

  return hits;
}

/** Refuse an upstream response that carries pre-signed material. */
export function assertNoSignedMaterial(provider, raw) {
  const hits = findSignedFields(raw);
  if (hits.length) {
    throw new Error(
      `${provider}: refused a pre-signed transaction payload from the API (fields: ${[...new Set(hits)].join(", ")}) — ` +
        `@oracle-agent/oracle is prepare-only and will not bind signed material into a prepared envelope`,
    );
  }
}
