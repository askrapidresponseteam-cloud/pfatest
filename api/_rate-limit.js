'use strict';

/* Rate limiting for the PFA donation form.
 *
 * Between January 2024 and April 2025 this form took 37,306 submissions of
 * exactly ₹1 — 18,044 of them in April 2024 alone. That is card testing:
 * criminals with lists of stolen card numbers push trivial charges through an
 * open donation form to find out which cards are still live, then spend the
 * working ones elsewhere. A charity donate page is an attractive target because
 * the amounts are small, the form is public, and nobody is watching.
 *
 * Two things stop it, and both are cheap:
 *   a minimum amount, which makes each test cost real money
 *   a per-IP and per-email limit, which makes volume impossible
 *
 * Counters live in Firestore so they hold across serverless instances. A small
 * in-process cache short-circuits repeat offenders without a network call,
 * which matters when someone is sending thousands of requests.
 */

const crypto = require('crypto');
const { commit, setDoc, incrementDoc, readDoc, fieldPath } = require('./_firestore.js');

/* Windows are deliberately generous for real donors. A person giving to three
   different appeals in an afternoon is unaffected; a script sending hundreds an
   hour is stopped almost immediately. */
const LIMITS = {
  ipShort:  { window: 15 * 60 * 1000, max: 5,  label: 'ip15m' },
  ipDay:    { window: 24 * 60 * 60 * 1000, max: 25, label: 'ip24h' },
  emailDay: { window: 24 * 60 * 60 * 1000, max: 10, label: 'email24h' },
};

/* Blocked keys remembered in memory, so a flood costs one Firestore read
   rather than one per request. Bounded so it cannot grow without limit. */
const recentlyBlocked = new Map();
const MEMORY_LIMIT = 5000;

function remember(key, until) {
  if (recentlyBlocked.size >= MEMORY_LIMIT) {
    const oldest = recentlyBlocked.keys().next().value;
    recentlyBlocked.delete(oldest);
  }
  recentlyBlocked.set(key, until);
}

function blockedInMemory(key) {
  const until = recentlyBlocked.get(key);
  if (!until) return false;
  if (Date.now() > until) { recentlyBlocked.delete(key); return false; }
  return true;
}

/* IP addresses are personal data under the DPDP Act, so store a hash rather
   than the address itself. It still works as a counter key, and a leak of the
   rate-limit collection reveals nothing about who visited. */
function hashKey(value) {
  const salt = String(process.env.CCAVENUE_WORKING_KEY || 'pfa-fallback-salt');
  return crypto.createHash('sha256').update(salt + '|' + value).digest('hex').slice(0, 32);
}

function clientIp(request) {
  const fwd = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || String(request.headers['x-real-ip'] || '').trim() || 'unknown';
}

/* Minimum accepted donation, per currency. A single rupee figure would be
   wrong for USD: ₹10 is sensible, $10 is not. */
const DEFAULT_MIN = { INR: 10, USD: 1 };

function minimumAmount(currency) {
  const cur = String(currency || 'INR').toUpperCase();
  const configured = parseInt(process.env[`MIN_DONATION_${cur}`] || '', 10);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return DEFAULT_MIN[cur] || 1;
}

/**
 * Check one counter. Returns true when the caller is over the limit.
 * Fails open: if Firestore is unreachable, a real donor still gets through.
 */
async function overLimit(id, rule) {
  const now = Date.now();
  const doc = await readDoc('rateLimits', id);

  if (doc && typeof doc.windowStart === 'number' && now - doc.windowStart < rule.window) {
    if ((doc.count || 0) >= rule.max) {
      remember(id, doc.windowStart + rule.window);
      return true;
    }
    await commit([incrementDoc('rateLimits', id, { [fieldPath('count')]: 1 })]);
    return false;
  }

  await commit([setDoc('rateLimits', id, {
    windowStart: now, count: 1, rule: rule.label, updatedAt: new Date(),
  })]);
  return false;
}

/**
 * @returns {Promise<{allowed: boolean, reason?: string, retryAfterMinutes?: number}>}
 */
async function check(request, { email, amount, currency } = {}) {
  const cur = String(currency || 'INR').toUpperCase();
  const min = minimumAmount(cur);
  const value = Number(amount);
  const symbol = cur === 'INR' ? '₹' : cur + ' ';

  if (Number.isFinite(value) && value < min) {
    return {
      allowed: false,
      reason: `The smallest donation we can accept online is ${symbol}${min}. ` +
              `For a smaller amount, please contact People for Animals directly.`,
    };
  }

  const ipKey = 'ip_' + hashKey(clientIp(request));
  const emailKey = email ? 'em_' + hashKey(String(email).toLowerCase()) : null;

  const TOO_MANY = 'Too many donation attempts in a short time. Please wait a little and try again, ' +
    'or contact People for Animals if you need help completing your gift.';

  for (const key of [ipKey + '_15m', ipKey + '_24h', emailKey && emailKey + '_24h']) {
    if (key && blockedInMemory(key)) {
      return { allowed: false, reason: TOO_MANY, retryAfterMinutes: 15 };
    }
  }

  const checks = [
    [ipKey + '_15m', LIMITS.ipShort],
    [ipKey + '_24h', LIMITS.ipDay],
  ];
  if (emailKey) checks.push([emailKey + '_24h', LIMITS.emailDay]);

  for (const [key, rule] of checks) {
    if (await overLimit(key, rule)) {
      console.warn('PFA donation rate limit hit', { rule: rule.label });
      return {
        allowed: false,
        reason: TOO_MANY,
        retryAfterMinutes: rule.window === LIMITS.ipShort.window ? 15 : 60,
      };
    }
  }

  return { allowed: true };
}

module.exports = { check, minimumAmount, hashKey, clientIp, LIMITS };
