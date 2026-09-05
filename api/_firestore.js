'use strict';

/* Minimal Firestore writer for the PFA serverless functions.
 *
 * Deliberately has no npm dependencies. firebase-admin is ~50 MB and adds a
 * cold start to every payment callback, which is the worst place to spend
 * latency. This talks to the Firestore REST API directly using Node's built-in
 * crypto and fetch, which is a few hundred milliseconds instead.
 *
 * Required Vercel environment variable:
 *   FIREBASE_SERVICE_ACCOUNT   the service account JSON, or that JSON base64-encoded
 *
 * Nothing here ever throws to the caller. A donation must not fail because a
 * database write failed — the donor has already paid.
 */

const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/datastore';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

let cachedToken = null;      // { token, expiresAt, projectId }

function serviceAccount() {
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
  const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const sa = JSON.parse(json);
  if (!sa.client_email || !sa.private_key || !sa.project_id) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is missing client_email, private_key or project_id');
  }
  return sa;
}

const b64url = buf => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken;

  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL,
    iat: now, exp: now + 3600
  }));
  const signature = b64url(
    crypto.createSign('RSA-SHA256')
      .update(`${header}.${claims}`)
      .sign(sa.private_key.replace(/\\n/g, '\n'))
  );

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`
    })
  });
  if (!res.ok) throw new Error(`Google token request failed: ${res.status} ${await res.text()}`);

  const data = await res.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    projectId: sa.project_id
  };
  return cachedToken;
}

/* ---- JavaScript values to Firestore's typed REST representation ---- */
function encode(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  switch (typeof value) {
    case 'boolean': return { booleanValue: value };
    case 'string': return { stringValue: value };
    case 'number':
      if (!Number.isFinite(value)) return { nullValue: null };
      return Number.isInteger(value)
        ? { integerValue: String(value) }
        : { doubleValue: value };
    default: break;
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encode) } };
  }
  const fields = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) fields[k] = encode(v);
  }
  return { mapValue: { fields } };
}

function encodeFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) fields[k] = encode(v);
  }
  return fields;
}

/* A field path segment needs backticks unless it is a plain identifier.
   Category names like "Feeder care" and "Donation (cheque/DD)" need them. */
function fieldPath(...segments) {
  return segments
    .map(s => /^[A-Za-z_][A-Za-z_0-9]*$/.test(s) ? s : '`' + String(s).replace(/[`\\]/g, '\\$&') + '`')
    .join('.');
}

/* ---- the two operations the callback needs ---- */

/** Merge fields into a document, creating it if absent. */
function setDoc(collection, id, data) {
  return { kind: 'set', collection, id, data };
}

/** Add to numeric fields, creating them at zero first if absent. */
function incrementDoc(collection, id, increments) {
  return { kind: 'increment', collection, id, increments };
}

/**
 * Send a batch of operations. Resolves to { ok: true } or { ok: false, error }.
 * Never throws — callers are in the middle of a donor-facing response.
 */
async function commit(operations, timeoutMs = 8000) {
  try {
    const { token, projectId } = await accessToken();
    const base = `projects/${projectId}/databases/(default)/documents`;

    const writes = operations.map(op => {
      const name = `${base}/${op.collection}/${op.id}`;
      if (op.kind === 'increment') {
        return {
          transform: {
            document: name,
            fieldTransforms: Object.entries(op.increments).map(([path, by]) => ({
              fieldPath: path,
              increment: Number.isInteger(by)
                ? { integerValue: String(by) }
                : { doubleValue: by }
            }))
          }
        };
      }
      return {
        update: { name, fields: encodeFields(op.data) },
        updateMask: { fieldPaths: Object.keys(op.data).map(k => fieldPath(k)) }
      };
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(
        `https://firestore.googleapis.com/v1/${base}:commit`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ writes })
        }
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      return { ok: false, error: `Firestore commit ${res.status}: ${(await res.text()).slice(0, 400)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 400) };
  }
}

/* ---- reading, needed by the rate limiter ---- */

function decode(v) {
  if (!v || typeof v !== 'object') return null;
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
  if ('mapValue' in v) {
    const out = {};
    for (const [k, x] of Object.entries(v.mapValue.fields || {})) out[k] = decode(x);
    return out;
  }
  return null;
}

/**
 * Fetch one document. Resolves to the data, or null when it does not exist.
 * Never throws — returns null on any failure, so a Firestore outage cannot
 * take the donate page down with it.
 */
async function readDoc(collection, id, timeoutMs = 5000) {
  try {
    const { token, projectId } = await accessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(
        `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)` +
        `/documents/${collection}/${encodeURIComponent(id)}`,
        { signal: controller.signal, headers: { Authorization: `Bearer ${token}` } }
      );
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const body = await res.json();
    const out = {};
    for (const [k, v] of Object.entries(body.fields || {})) out[k] = decode(v);
    return out;
  } catch {
    return null;
  }
}

module.exports = { commit, setDoc, incrementDoc, readDoc, fieldPath, encode, encodeFields, decode };
