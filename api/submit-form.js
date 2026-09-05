'use strict';

/* PFA enquiry and application forms -> Firestore.
 *
 * Adoption applications, CSR enquiries, feeder care requests and legacy
 * enquiries are not payments. They used to POST into the Laravel site's
 * register_forms table; this replaces that.
 *
 * Point any non-payment form at:  <form method="post" action="/api/submit-form">
 * with a hidden field:            <input type="hidden" name="form_type" value="adopt">
 *
 * Required Vercel environment variable:
 *   FIREBASE_SERVICE_ACCOUNT   the service account JSON, or that JSON base64-encoded
 */

const crypto = require('crypto');
const { commit, setDoc, incrementDoc, fieldPath } = require('./_firestore.js');
const rateLimit = require('./_rate-limit.js');

const FORM_TYPES = {
  adopt: 'Adoption',
  csr: 'CSR',
  'feeder-care': 'Feeder care',
  legacy: 'Legacy',
  'ask-maneka': 'Ask Maneka Gandhi',
  foster: 'Foster',
  volunteer: 'Volunteer',
  cheque: 'Donation (cheque/DD)',
  contact: 'Enquiry',
};

/* The old form was hammered by an automated scanner in April 2025 — a hundred
   odd submissions carrying SQL injection payloads. None of them worked, but
   they polluted the data badly enough that they had to be filtered out during
   the migration. Rejecting them at the door is cheaper than cleaning later. */
const ATTACK = /(\bunion\s+select\b|\bselect\s+.*\bfrom\b|<script|onerror\s*=|javascript:|\bsleep\s*\(|waitfor\s+delay|\bor\s+\d+\s*=\s*\d+|<\?php|\$\{)/i;

const MAX_BODY = 64 * 1024;

function clean(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 200);
}

function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function readBody(request) {
  if (request.body && typeof request.body === 'object' && !Buffer.isBuffer(request.body)) {
    return request.body;
  }
  let raw = request.body;
  if (raw == null) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > MAX_BODY) throw new Error('That form submission is too large.');
      chunks.push(buf);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  return Object.fromEntries(new URLSearchParams(String(raw)).entries());
}

function page(response, status, heading, message, backHref) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(heading)} | PFA</title>
<style>body{margin:0;font-family:system-ui,-apple-system,Arial,sans-serif;background:#fff;color:#111}
.wrap{min-height:100vh;display:grid;place-items:center;padding:24px}
.card{width:min(560px,100%);border:1px solid #ddd;padding:36px;border-radius:8px}
h1{font-size:28px;line-height:1.15;margin:0 0 12px}
p{font-size:16px;line-height:1.55;color:#555;margin:0}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:26px}
a{text-decoration:none;padding:13px 19px;border-radius:6px;font-weight:600;border:1px solid #7b6bd6}
.dark{background:#7b6bd6;color:#fff}.light{background:#fff;color:#7b6bd6}
</style></head><body><main class="wrap"><section class="card">
<h1>${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p>
<div class="actions"><a class="dark" href="/index.html">PFA home</a>
<a class="light" href="${escapeHtml(backHref || '/index.html')}">Back to the form</a></div>
</section></main></body></html>`);
}

module.exports = async function handler(request, response) {
  response.setHeader('Referrer-Policy', 'no-referrer');

  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return page(response, 405, 'Page not available',
      'This address only receives form submissions from the PFA website.');
  }

  let body;
  try {
    body = await readBody(request);
  } catch (e) {
    return page(response, 413, 'That did not go through',
      clean(e.message, 200) || 'Please shorten your message and try again.');
  }

  const kind = clean(body.form_type, 30).toLowerCase();
  const category = FORM_TYPES[kind];
  const PAGE_FOR = {
    'feeder-care': 'feeder-care-assistance',
    legacy: 'leave-a-legacy',
    'ask-maneka': 'ask-maneka-gandhi',
  };
  const back = FORM_TYPES[kind] ? `/${PAGE_FOR[kind] || kind}.html` : '/index.html';

  if (!category) {
    return page(response, 400, 'That form is not recognised',
      'Please go back and submit the form from the PFA website.');
  }

  /* Honeypot. Real people leave it empty because it is hidden; most bots fill
     every field they find. Answer normally so the bot learns nothing. */
  if (clean(body.website, 100)) {
    console.warn('PFA form: honeypot triggered', { kind });
    return page(response, 200, 'Thank you',
      'Your message has been received. Someone from People for Animals will be in touch.', back);
  }

  const name = clean(body.name || body.billing_name, 100);
  const email = clean(body.email || body.billing_email, 100).toLowerCase();
  const phone = clean(body.phone || body.mobile || body.billing_tel, 20).replace(/[^\d+]/g, '');
  const message = clean(body.remarks || body.message || body.question, 2000);

  if (!name || name.length < 2) {
    return page(response, 400, 'We need your name',
      'Please go back and tell us your name so we can reply.', back);
  }
  if (!email && !phone) {
    return page(response, 400, 'We need a way to reach you',
      'Please go back and give either an email address or a phone number.', back);
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return page(response, 400, 'That email does not look right',
      'Please go back and check the email address.', back);
  }
  if (phone && phone.replace(/\D/g, '').length < 10) {
    return page(response, 400, 'That phone number looks short',
      'Please go back and enter a full phone number including area or country code.', back);
  }

  const gate = await rateLimit.check(request, { email });
  if (!gate.allowed) {
    if (gate.retryAfterMinutes) response.setHeader('Retry-After', String(gate.retryAfterMinutes * 60));
    return page(response, 429, 'Too many attempts',
      'Please wait a few minutes and send your message again.', back);
  }

  const all = [name, email, phone, message,
    body.address, body.city, body.state, body.country, body.designation,
    body.cname, body.crnumber, body.category, body.product_id,
    body.question, body.where_from, body.pin].join(' ');
  if (ATTACK.test(all)) {
    console.warn('PFA form: rejected a submission matching an attack pattern', { kind });
    return page(response, 400, 'That did not go through',
      'Something in the form could not be accepted. Please write your message in plain text and try again.', back);
  }

  const now = new Date();
  const id = `${kind}-${now.toISOString().slice(0, 10)}-${crypto.randomBytes(5).toString('hex')}`;

  const record = {
    formType: kind,
    category,
    name, email, phone, message,
    designation: clean(body.designation, 100) || null,
    companyName: clean(body.cname || body.company_name, 150) || null,
    companyRegNo: clean(body.crnumber, 60) || null,
    productId: clean(body.product_id, 60) || null,
    productCategory: clean(body.category, 80) || null,
    address: clean(body.address || body.billing_address, 200) || null,
    city: clean(body.city || body.billing_city, 80) || null,
    state: clean(body.state || body.billing_state, 80) || null,
    country: clean(body.country || body.billing_country, 80) || null,
    pincode: clean(body.pincode || body.pin || body.billing_zip, 12) || null,
    pan: clean(body.pan_no || body.pan, 12).toUpperCase() || null,
    donateBy: clean(body.donate_by, 40) || null,
    bankName: clean(body.bank_name, 100) || null,
    bankDetails: clean(body.bank_details, 200) || null,
    heardFrom: clean(body.where_from || body.from_where, 100) || null,
    status: 'new',
    source: 'website',
    date: now.toISOString(),
    receivedAt: now,
  };

  const ops = [setDoc('submissions', id, record)];
  if (email) {
    ops.push(setDoc('people', email.replace(/[^\w.@-]/g, '_'), {
      name, email, phone: phone || null,
      address: { city: record.city, state: record.state,
                 country: record.country, pincode: record.pincode },
      lastSeen: now.toISOString().slice(0, 10),
      updatedAt: now,
    }));
  }
  ops.push(incrementDoc('aggregates', 'submissions', {
    [fieldPath('total')]: 1,
    [fieldPath('byType', kind)]: 1,
    [fieldPath('new')]: 1,
  }));

  const saved = await commit(ops);
  if (saved.ok) {
    console.info('PFA form saved', { id, kind });
  } else {
    /* Never lose the enquiry. If the write failed, the log line is the only
       remaining copy — so make it complete enough to re-enter by hand. */
    console.error('PFA form NOT saved, full contents follow so nothing is lost',
      { id, kind, error: saved.error, record });
  }

  return page(response, 200, 'Thank you',
    'Your message has been received. Someone from People for Animals will be in touch soon.',
    back);
};
