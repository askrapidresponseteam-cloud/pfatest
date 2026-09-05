'use strict';

/* PFA donation -> CCAvenue handoff.
 *
 * The browser POSTs the donate form here. This builds the CCAvenue payload,
 * encrypts it with the working key, and returns a page that auto-submits to
 * CCAvenue. The working key never leaves the server.
 *
 * Required Vercel environment variables:
 *   CCAVENUE_MERCHANT_ID
 *   CCAVENUE_ACCESS_CODE
 *   CCAVENUE_WORKING_KEY
 *   CCAVENUE_MODE=production      (anything else uses test.ccavenue.com)
 *   PUBLIC_SITE_URL=https://www.peopleforanimalsindia.org
 */

const crypto = require('crypto');
const rateLimit = require('./_rate-limit.js');

const IV = Buffer.from([
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
  0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f
]);

const PRODUCTION_URL = 'https://secure.ccavenue.com/transaction/transaction.do?command=initiateTransaction';
const TEST_URL = 'https://test.ccavenue.com/transaction/transaction.do?command=initiateTransaction';

function encrypt(plainText, workingKey) {
  const key = crypto.createHash('md5').update(String(workingKey), 'utf8').digest();
  const cipher = crypto.createCipheriv('aes-128-cbc', key, IV);
  cipher.setAutoPadding(true);
  return Buffer.concat([
    cipher.update(String(plainText), 'utf8'),
    cipher.final()
  ]).toString('hex');
}

function clean(value, maxLength) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength || 200);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
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
      if (size > 64 * 1024) throw new Error('Request body is too large.');
      chunks.push(buf);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  const params = new URLSearchParams(String(raw));
  const out = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    out[key] = all.length > 1 ? all : all[0];
  }
  return out;
}

/* The form has radio buttons named "amount" AND a number input named "amount",
   so the browser submits both. The radios can also carry the literal string
   "typeAmmount" when Other is selected. Take the last real number. */
function parseAmount(value) {
  const candidates = (Array.isArray(value) ? value : [value])
    .map((v) => String(v == null ? '' : v).trim())
    .filter((v) => /^\d{1,8}(?:\.\d{1,2})?$/.test(v))
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 10000000);

  if (!candidates.length) throw new Error('Enter a donation amount between 1 and 1,00,00,000.');
  return candidates[candidates.length - 1].toFixed(2);
}

function makeOrderId() {
  return `PFADON${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function baseUrl(request) {
  const configured = clean(process.env.PUBLIC_SITE_URL || '', 300);
  if (configured) return new URL(configured).origin;
  const proto = String(request.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = String(request.headers['x-forwarded-host'] || request.headers.host || '').split(',')[0];
  if (!host) throw new Error('Could not determine the site URL.');
  return `${proto}://${host}`;
}

function errorPage(response, status, message) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Donation could not start | PFA</title>
<style>body{margin:0;font-family:system-ui,-apple-system,Arial,sans-serif;background:#fff;color:#111}
.wrap{min-height:100vh;display:grid;place-items:center;padding:24px}
.card{width:min(520px,100%);border:1px solid #ddd;padding:32px;border-radius:8px}
h1{font-size:26px;margin:0 0 12px}p{color:#555;line-height:1.55;margin:0}
a{display:inline-block;margin-top:20px;background:#7b6bd6;color:#fff;text-decoration:none;padding:13px 20px;border-radius:6px;font-weight:600}
</style></head><body><main class="wrap"><section class="card">
<h1>Your donation could not be started</h1><p>${escapeHtml(message)}</p>
<a href="/donate.html">Back to donate</a></section></main></body></html>`);
}

module.exports = async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');

  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return errorPage(response, 405, 'Start your donation from the PFA donate page.');
  }

  const merchantId = clean(process.env.CCAVENUE_MERCHANT_ID, 30);
  const accessCode = clean(process.env.CCAVENUE_ACCESS_CODE, 200);
  const workingKey = String(process.env.CCAVENUE_WORKING_KEY || '').trim();

  if (!merchantId || !accessCode || !workingKey) {
    console.error('CCAvenue env vars missing:', {
      merchantId: Boolean(merchantId),
      accessCode: Boolean(accessCode),
      workingKey: Boolean(workingKey)
    });
    return errorPage(response, 500, 'Online donations are not configured yet. Please try again shortly.');
  }

  try {
    const body = await readBody(request);
    const amount = parseAmount(body.amount);
    const orderId = makeOrderId();
    const callback = `${baseUrl(request)}/api/ccavenue-response`;

    /* The donate page collects only an amount and an optional PAN, exactly as
       it always has. CCAvenue's own checkout collects the donor's name, email
       and billing address, and returns all of it in the callback -- so these
       are passed through when present and simply omitted when they are not.
       None of them is mandatory to CCAvenue. */
    const name = clean(body.billing_name, 100);
    const email = clean(body.billing_email, 100);
    const tel = clean(body.billing_tel, 20).replace(/[^\d+]/g, '');
    const pan = clean(body.pan, 12).toUpperCase();

    /* The donate form already posts a "type" field, and the other pages can
       post one too. Carrying it through means a membership payment is recorded
       as Membership rather than lumped in with general donations. Validated
       against a fixed list so nothing arbitrary reaches the payment gateway. */
    const PURPOSES = new Set([
      'donate', 'donate-by-inr', 'donate-by-usd', 'cheque', 'donate-by-cheque-dd',
      'membership', 'join-now', 'adopt', 'sponsor', 'sponsor-an-animal',
      'campaign', 'gift', 'make-a-gift', 'csr', 'feeder-care',
      'pfa-feeder-care-assistance', 'legacy', 'leave-a-legacy'
    ]);
    /* Existing pages carry human-readable values like type="Join Now" and
       type="make a Gift", so normalise before matching rather than making
       every page change its markup. */
    const requested = clean(body.purpose || body.type, 40)
      .toLowerCase().replace(/[\s/]+/g, '-').replace(/[^a-z0-9-]/g, '');
    const purpose = PURPOSES.has(requested) ? requested : 'donate';

    /* Currency was previously hardcoded to INR while the USD donate form sent
       currency=USD. A donor choosing $50 would have been charged ₹50. Honour
       what the form asks for, but only from a fixed list — the value goes
       straight to the payment gateway. */
    const CURRENCIES = new Set((process.env.ALLOWED_CURRENCIES || 'INR,USD')
      .split(',').map((c) => c.trim().toUpperCase()).filter(Boolean));
    const askedCurrency = clean(body.currency, 8).toUpperCase();
    if (askedCurrency && !CURRENCIES.has(askedCurrency)) {
      throw new Error('That currency is not accepted. Please donate in INR.');
    }
    const currency = askedCurrency || 'INR';

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Please enter a valid email address.');
    if (pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) throw new Error('That PAN number does not look valid. Leave it blank if unsure.');

    /* Card testing check. This form took 37,306 submissions of exactly one
       rupee across 2024 and 2025 — stolen card numbers being validated against
       an open donation form. A minimum amount and a per-IP limit stop it.
       Both fail open: if Firestore is unreachable a real donor still gets
       through, because blocking genuine gifts is the worse failure. */
    const gate = await rateLimit.check(request, { email, amount: parseFloat(amount), currency });
    if (!gate.allowed) {
      console.warn('PFA donation blocked', { reason: gate.reason.slice(0, 80), amount });
      if (gate.retryAfterMinutes) {
        response.setHeader('Retry-After', String(gate.retryAfterMinutes * 60));
      }
      return errorPage(response, 429, gate.reason);
    }

    /* Server owns merchant_id, order_id, amount and the callback URLs.
       Anything the browser sent for those is ignored on purpose. */
    const payload = {
      merchant_id: merchantId,
      order_id: orderId,
      amount,
      currency,
      redirect_url: callback,
      cancel_url: callback,
      language: 'EN',
      billing_name: name,
      billing_address: clean(body.billing_address, 150),
      billing_city: clean(body.billing_city, 50),
      billing_state: clean(body.billing_state, 50),
      billing_zip: clean(body.billing_zip, 10),
      billing_country: clean(body.billing_country, 50) || 'India',
      billing_tel: tel,
      billing_email: email,
      merchant_param1: pan,
      merchant_param2: 'PFA Donation',
      merchant_param3: purpose,
      merchant_param4: 'PFA Website'
    };

    const params = new URLSearchParams();
    Object.entries(payload).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') params.append(k, String(v));
    });

    const encRequest = encrypt(params.toString(), workingKey);
    const paymentUrl = String(process.env.CCAVENUE_MODE || '').toLowerCase() === 'production'
      ? PRODUCTION_URL
      : TEST_URL;

    /* Log enough to reconcile against CCAvenue's dashboard later. There is no
       database here, so Vercel's function logs are the only record PFA keeps
       of what was sent. Export them if you need an audit trail. */
    console.info('PFA donation started', { orderId, amount, purpose, pan: pan ? 'provided' : 'none' });

    const nonce = crypto.randomBytes(18).toString('base64');
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; ` +
      `form-action https://secure.ccavenue.com https://test.ccavenue.com; base-uri 'none'; frame-ancestors 'none'`
    );
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening secure payment | PFA</title>
<style>body{margin:0;font-family:system-ui,-apple-system,Arial,sans-serif;background:#fff;color:#111}
.wrap{min-height:100vh;display:grid;place-items:center;padding:24px}
.card{width:min(520px,100%);border:1px solid #ddd;padding:34px;border-radius:8px;text-align:center}
h1{font-size:24px;margin:0 0 10px}p{color:#555;line-height:1.55;margin:0}
.spinner{width:30px;height:30px;border:3px solid #eee;border-top-color:#7b6bd6;border-radius:50%;margin:22px auto;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
button{margin-top:18px;background:#7b6bd6;color:#fff;border:0;padding:13px 20px;border-radius:6px;font-weight:600;font-size:15px;cursor:pointer}
</style></head><body><main class="wrap"><section class="card">
<h1>Opening secure payment</h1><div class="spinner"></div>
<p>You are being transferred to CCAvenue. People for Animals does not receive or store your card, bank or UPI details.</p>
<form id="cca" method="post" action="${escapeHtml(paymentUrl)}">
<input type="hidden" name="encRequest" value="${escapeHtml(encRequest)}">
<input type="hidden" name="access_code" value="${escapeHtml(accessCode)}">
<button type="submit">Continue</button></form>
</section></main><script nonce="${nonce}">document.getElementById('cca').submit();</script></body></html>`);
  } catch (error) {
    const message = clean(error && error.message ? error.message : 'Your donation could not be started.', 300);
    console.error('PFA donation start failed:', message);
    return errorPage(response, 400, message);
  }
};
