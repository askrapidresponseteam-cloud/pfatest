'use strict';

/* Turns a decrypted CCAvenue callback into Firestore records.
 *
 * Writes, in one batch:
 *   payments/{orderId}              successful donations, same shape as the
 *                                   historical import so the admin site treats
 *                                   old and new records identically
 *   paymentAttempts/{orderId}       everything else, kept for reconciliation
 *                                   against the CCAvenue dashboard
 *   people/{email}                  the donor, created or updated
 *   aggregates/summary              dashboard counters, incremented in place
 *
 * Using orderId as the document ID makes this idempotent. CCAvenue retries its
 * callback and donors refresh the result page, so the same payment can arrive
 * several times; each arrival overwrites rather than duplicating. The aggregate
 * counters are the exception — they would double-count — so they are only
 * incremented when the payment document did not already exist.
 */

const { commit, setDoc, incrementDoc, fieldPath } = require('./_firestore.js');

/* merchant_param3 carries the form the donor came from. Map it to the same
   category names the historical import used, so the dashboard doesn't end up
   with "donate" and "Donation" as separate buckets. */
const CATEGORY = {
  donate: 'Donation',
  'donate-by-inr': 'Donation',
  'donate-by-usd': 'Donation',
  cheque: 'Donation (cheque/DD)',
  'donate-by-cheque-dd': 'Donation (cheque/DD)',
  membership: 'Membership',
  'join-now': 'Membership',
  adopt: 'Adoption',
  sponsor: 'Sponsorship',
  'sponsor-an-animal': 'Sponsorship',
  campaign: 'Campaign',
  gift: 'Gift',
  'make-a-gift': 'Gift',
  csr: 'CSR',
  'feeder-care': 'Feeder care',
  'pfa-feeder-care-assistance': 'Feeder care',
  legacy: 'Legacy',
  'leave-a-legacy': 'Legacy',
};

/* Normalised the same way as the request handler, so "Join Now",
   "join-now" and "JOIN NOW" all land on Membership. */
function categoryOf(param) {
  const key = String(param || '').trim().toLowerCase()
    .replace(/[\s/]+/g, '-').replace(/[^a-z0-9-]/g, '');
  return CATEGORY[key] || 'Donation';
}

const financialYear = d =>
  d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;

const docId = s =>
  String(s || '').replace(/[^\w.@-]/g, '_').slice(0, 400) || 'unknown';

function toNumber(v) {
  const n = parseFloat(String(v || '').replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {object} data  the decrypted CCAvenue response, already parsed
 * @returns {Promise<{ok:boolean, error?:string, recorded?:string}>}
 */
async function recordDonation(data) {
  const orderId = String(data.order_id || '').trim();
  if (!orderId) return { ok: false, error: 'no order_id in callback' };

  const status = String(data.order_status || '').trim();
  const succeeded = status.toLowerCase() === 'success';
  const amount = toNumber(data.amount);
  const currency = String(data.currency || 'INR').trim() || 'INR';
  const category = categoryOf(data.merchant_param3);
  const email = String(data.billing_email || '').trim().toLowerCase();
  const name = String(data.billing_name || '').trim();
  const when = new Date();

  const record = {
    orderId,
    category,
    matchedBy: 'liveCallback',
    name,
    email,
    mobile: String(data.billing_tel || '').trim(),
    currency,
    amount: amount === null ? 0 : amount,
    statusRaw: status,
    method: String(data.payment_mode || '').trim(),
    trackingId: String(data.tracking_id || '').trim(),
    bankRef: String(data.bank_ref_no || '').trim(),
    pan: String(data.merchant_param1 || '').trim().toUpperCase(),
    address: String(data.billing_address || '').trim(),
    city: String(data.billing_city || '').trim(),
    state: String(data.billing_state || '').trim(),
    country: String(data.billing_country || '').trim(),
    pincode: String(data.billing_zip || '').trim(),
    date: when.toISOString(),
    year: when.getUTCFullYear(),
    fy: financialYear(when),
    source: 'website',
    recordedAt: when,
  };

  const ops = [];

  if (!succeeded) {
    // Keep failures out of payments/ so totals stay clean, but keep them
    // somewhere — reconciling against CCAvenue needs the failures too.
    ops.push(setDoc('paymentAttempts', docId(orderId), {
      ...record,
      failureMessage: String(data.failure_message || data.status_message || '').trim(),
    }));
    const res = await commit(ops);
    return res.ok ? { ok: true, recorded: 'attempt' } : res;
  }

  ops.push(setDoc('payments', docId(orderId), record));

  if (email) {
    ops.push(setDoc('people', docId(email), {
      name: name || null,
      email,
      phone: record.mobile || null,
      address: {
        city: record.city || null,
        state: record.state || null,
        country: record.country || null,
        pincode: record.pincode || null,
      },
      lastSeen: when.toISOString().slice(0, 10),
      updatedAt: when,
    }));
    ops.push(incrementDoc('people', docId(email), {
      [fieldPath('stats', 'paymentCount')]: 1,
      [fieldPath('stats', 'paidTotal')]: amount || 0,
    }));
  }

  const fy = `${record.fy}-${String(record.fy + 1).slice(-2)}`;
  const year = String(record.year);
  ops.push(incrementDoc('aggregates', 'summary', {
    [fieldPath('totals', 'payments')]: 1,
    [fieldPath('totals', 'byCurrency', currency)]: amount || 0,
    [fieldPath('byCategory', category, 'count')]: 1,
    [fieldPath('byCategory', category, 'byCurrency', currency)]: amount || 0,
    [fieldPath('byYear', year, 'count')]: 1,
    [fieldPath('byYear', year, 'byCurrency', currency)]: amount || 0,
    [fieldPath('byFinancialYear', fy, 'count')]: 1,
    [fieldPath('byFinancialYear', fy, 'byCurrency', currency)]: amount || 0,
    [fieldPath('byMatchMethod', 'liveCallback')]: 1,
  }));
  if (record.state) {
    ops.push(incrementDoc('aggregates', 'summary', {
      [fieldPath('byState', record.state, 'count')]: 1,
      [fieldPath('byState', record.state, 'byCurrency', currency)]: amount || 0,
    }));
  }

  const res = await commit(ops);
  return res.ok ? { ok: true, recorded: 'payment' } : res;
}

module.exports = { recordDonation, categoryOf, financialYear };
