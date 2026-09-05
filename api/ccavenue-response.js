'use strict';

/* CCAvenue -> PFA callback.
 *
 * CCAvenue POSTs an encrypted result here after the donor finishes (or
 * abandons) payment. This decrypts it with the same working key and shows the
 * donor a result page.
 *
 * Set this URL as BOTH the Return URL and the Cancel URL in the CCAvenue
 * merchant dashboard:
 *   https://www.peopleforanimalsindia.org/api/ccavenue-response
 */

const crypto = require('crypto');
const { recordDonation } = require('./_record-donation.js');

const IV = Buffer.from([
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
  0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f
]);

function decrypt(encryptedHex, workingKey) {
  const value = String(encryptedHex || '').trim();
  if (!value || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) {
    throw new Error('CCAvenue returned an unreadable response.');
  }
  const key = crypto.createHash('md5').update(String(workingKey), 'utf8').digest();
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, IV);
  decipher.setAutoPadding(true);
  return Buffer.concat([
    decipher.update(Buffer.from(value, 'hex')),
    decipher.final()
  ]).toString('utf8');
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
      if (size > 256 * 1024) throw new Error('Response body is too large.');
      chunks.push(buf);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  return Object.fromEntries(new URLSearchParams(String(raw)).entries());
}

function page(response, status, kind, heading, message, rows) {
  const colours = { success: '#16794b', failure: '#b42318', pending: '#8a6200' };
  const marks = { success: '&#10003;', failure: '!', pending: '&hellip;' };
  const colour = colours[kind] || colours.pending;

  const table = (rows || [])
    .filter((r) => r && r[1])
    .map(([label, value]) => `<div class="row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`)
    .join('');

  response.statusCode = status;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(heading)} | PFA</title>
<style>body{margin:0;font-family:system-ui,-apple-system,Arial,sans-serif;background:#fff;color:#111}
.wrap{min-height:100vh;display:grid;place-items:center;padding:24px}
.card{width:min(620px,100%);border:1px solid #ddd;padding:36px;border-radius:8px}
.mark{width:50px;height:50px;display:grid;place-items:center;border:2px solid ${colour};color:${colour};border-radius:50%;font-size:24px;font-weight:800;margin-bottom:20px}
h1{font-size:30px;line-height:1.1;margin:0 0 12px}p{font-size:16px;line-height:1.55;color:#555;margin:0}
.details{margin:26px 0;border-top:1px solid #e5e5e5}
.row{display:flex;justify-content:space-between;gap:20px;padding:13px 0;border-bottom:1px solid #e5e5e5}
.row span{color:#666}.row strong{text-align:right;overflow-wrap:anywhere}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}
a{text-decoration:none;padding:13px 19px;border-radius:6px;font-weight:600;border:1px solid #7b6bd6}
.dark{background:#7b6bd6;color:#fff}.light{background:#fff;color:#7b6bd6}
@media(max-width:560px){.card{padding:24px}.row{display:block}.row strong{display:block;text-align:left;margin-top:5px}h1{font-size:25px}}
</style></head><body><main class="wrap"><section class="card">
<div class="mark">${marks[kind] || marks.pending}</div>
<h1>${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p>
${table ? `<div class="details">${table}</div>` : ''}
<div class="actions"><a class="dark" href="/index.html">PFA home</a><a class="light" href="/donate.html">Donate again</a></div>
</section></main></body></html>`);
}

module.exports = async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return page(response, 405, 'failure', 'Page not available',
      'This address only receives payment results from CCAvenue.', []);
  }

  const workingKey = String(process.env.CCAVENUE_WORKING_KEY || '').trim();
  if (!workingKey) {
    console.error('CCAVENUE_WORKING_KEY is not set; cannot decrypt callback.');
    return page(response, 500, 'pending', 'We could not confirm your payment',
      'Your bank may still have processed it. Please email PFA with your transaction details before trying again.', []);
  }

  try {
    const body = await readBody(request);
    const encrypted = clean(body.encResp || body.enc_resp, 200000);
    const data = Object.fromEntries(new URLSearchParams(decrypt(encrypted, workingKey)).entries());

    const status = clean(data.order_status, 40);
    const orderId = clean(data.order_id, 80);
    const amount = clean(data.amount, 20);
    const trackingId = clean(data.tracking_id, 60);
    const bankRef = clean(data.bank_ref_no, 60);
    const pan = clean(data.merchant_param1, 12);
    const failureMessage = clean(data.failure_message || data.status_message, 200);

    /* CCAvenue collects the donor's details on its own checkout page and
       returns them here. This is where PFA gets the name, email and address
       needed to issue an 80G receipt and to file Form 10BD. */
    const donorName = clean(data.billing_name, 100);
    const donorEmail = clean(data.billing_email, 100);
    const donorTel = clean(data.billing_tel, 20);
    const donorAddress = [data.billing_address, data.billing_city, data.billing_state, data.billing_zip]
      .map((v) => clean(v, 60)).filter(Boolean).join(', ');

    console.info('PFA donation result', {
      orderId, status, amount, trackingId, bankRef,
      pan: pan || 'none',
      donorName, donorEmail, donorTel, donorAddress
    });

    /* Save it. The donor has already paid by this point, so a database problem
       must never change what they see -- recordDonation swallows its own
       errors and we only log the outcome. Reconcile anything logged as failed
       against the CCAvenue dashboard. */
    try {
      const saved = await recordDonation(data);
      if (saved.ok) {
        console.info('PFA donation saved to Firestore', { orderId, as: saved.recorded });
      } else {
        console.error('PFA donation NOT saved to Firestore', { orderId, status, amount, error: saved.error });
      }
    } catch (saveError) {
      console.error('PFA donation save threw unexpectedly', {
        orderId, error: String((saveError && saveError.message) || saveError)
      });
    }

    const rows = [
      ['Reference number', orderId],
      ['Amount', amount ? `INR ${amount}` : ''],
      ['Donor', donorName],
      ['Email', donorEmail],
      ['CCAvenue tracking ID', trackingId],
      ['Bank reference', bankRef],
      ['PAN', pan],
      ['Status', status]
    ];

    if (status === 'Success') {
      return page(response, 200, 'success', 'Thank you for your donation',
        'Your payment went through. People for Animals will email your 80G receipt to the address you gave. Please keep the reference number below.',
        rows);
    }

    if (status === 'Aborted') {
      return page(response, 200, 'pending', 'Payment cancelled',
        'You cancelled before the payment completed, so nothing has been charged.', rows);
    }

    return page(response, 200, 'failure', 'Payment was not completed',
      failureMessage || 'Your bank did not complete this payment. Nothing has been charged. Please try again or use a different method.',
      rows);
  } catch (error) {
    const message = clean(error && error.message ? error.message : 'Unknown error', 300);
    console.error('PFA CCAvenue callback failed:', message);
    return page(response, 400, 'pending', 'We could not confirm your payment',
      'Your bank may still have processed it. Please check with your bank and email PFA before donating again.', []);
  }
};
