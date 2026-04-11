/**
 * Cloudflare Worker — MiniMakers Checkout + Webhook Handler
 *
 * ROUTES:
 *   POST /              → Create Recurrente checkout (from landing page)
 *   POST /webhook       → Receive Recurrente payment notifications
 *
 * SETUP:
 * 1. Variables (Settings → Variables → Add as Secret):
 *    - REC_PUBLIC_KEY   → Recurrente public key (pk_live_...)
 *    - REC_SECRET_KEY   → Recurrente secret key (sk_live_...)
 *    - CRM_URL          → MiniMakers Ops CRM URL (https://web-production-a642.up.railway.app)
 *    - CRM_SECRET       → Shared WEBHOOK_SECRET for authentication
 *    - META_ACCESS_TOKEN → Meta Conversions API token (from Events Manager)
 */

const META_PIXEL_ID = '424336247007631';
const META_API_VERSION = 'v21.0';

const ALLOWED_ORIGINS = [
  'https://mini-panqueques-25.minimakersgt.com',
  'https://enriquezberg.github.io'
];
const LANDING_URL = 'https://mini-panqueques-25.minimakersgt.com/';
const WHATSAPP_NUM = '50231695584';

const PRODUCT = {
  name: 'Maquina Industrial 25 Mini Panqueques',
  sku: 'MI25MP',
  price_cents: 120000,
  price_display: 'Q1,200',
  currency: 'GTQ'
};

// Volume pricing — MUST match index.html pricing() logic
// Returns unit price in cents for a given quantity
function unitPriceCents(qty) {
  qty = parseInt(qty, 10) || 1;
  if (qty >= 6) return 90000;   // Q900
  if (qty >= 4) return 102000;  // Q1,020
  if (qty >= 2) return 110000;  // Q1,100
  return 120000;                // Q1,200
}

function discountPct(qty) {
  qty = parseInt(qty, 10) || 1;
  if (qty >= 6) return 25;
  if (qty >= 4) return 15;
  if (qty >= 2) return 8;
  return 0;
}

function clampQty(qty) {
  qty = parseInt(qty, 10) || 1;
  if (qty < 1) return 1;
  if (qty > 20) return 20;
  return qty;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request) });
    }

    // Route: Webhook from Recurrente
    if (url.pathname === '/webhook' && request.method === 'POST') {
      return handleWebhook(request, env);
    }

    // Route: Cash order from landing page
    if (url.pathname === '/cash' && request.method === 'POST') {
      return handleCashOrder(request, env);
    }

    // Route: Create checkout from landing page
    if (request.method === 'POST') {
      return handleCheckout(request, env);
    }

    return jsonResponse({ error: 'Method not allowed' }, 405, request);
  }
};

// ── Create Recurrente Checkout ──────────────────
async function handleCheckout(request, env) {
  try {
    const data = await request.json();

    const required = ['first_name', 'last_name', 'email', 'phone', 'address', 'city', 'state'];
    for (const field of required) {
      if (!data[field] || !data[field].trim()) {
        return jsonResponse({ error: 'Campo requerido: ' + field }, 400, request);
      }
    }

    const orderNum = 'MM-' + Date.now().toString(36).toUpperCase();

    // Quantity + volume pricing — server-side authoritative (never trust client)
    const qty = clampQty(data.quantity);
    const unitCents = unitPriceCents(qty);
    const totalCents = unitCents * qty;
    const dcPct = discountPct(qty);

    const checkoutPayload = {
      items: [{
        name: PRODUCT.name + (qty > 1 ? ' (' + qty + ' unidades — −' + dcPct + '%)' : ''),
        amount_in_cents: unitCents,
        currency: PRODUCT.currency,
        quantity: qty
      }],
      success_url: LANDING_URL + 'gracias.html?payment=success&order=' + orderNum + '&qty=' + qty + '&total=' + (totalCents / 100),
      cancel_url: LANDING_URL + '?payment=cancelled',
      metadata: {
        order_id: orderNum,
        customer_name: data.first_name.trim() + ' ' + data.last_name.trim(),
        email: data.email.trim(),
        phone: data.phone.trim(),
        address: data.address.trim() + ', ' + data.city.trim() + ', ' + data.state,
        zip: data.zip || '01010',
        nit: data.nit || 'C/F',
        quantity: String(qty),
        unit_price: String(unitCents / 100),
        total_amount: String(totalCents / 100),
        discount_pct: String(dcPct),
        source: 'landing-page'
      }
    };

    const recResponse = await fetch('https://app.recurrente.com/api/checkouts', {
      method: 'POST',
      headers: {
        'X-PUBLIC-KEY': env.REC_PUBLIC_KEY,
        'X-SECRET-KEY': env.REC_SECRET_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(checkoutPayload)
    });

    const recData = await recResponse.json();

    if (recData.checkout_url) {
      // Save order to MiniMakers CRM
      if (env.CRM_URL && env.CRM_SECRET) {
        saveToCRM(env.CRM_URL, env.CRM_SECRET, {
          order_id: orderNum,
          action: 'create',
          date: new Date().toISOString(),
          name: data.first_name.trim() + ' ' + data.last_name.trim(),
          email: data.email.trim(),
          phone: data.phone.trim(),
          address: data.address.trim() + ', ' + data.city.trim() + ', ' + data.state + ' ' + (data.zip || '01010'),
          department: data.state || '',
          nit: data.nit || 'C/F',
          method: 'card',
          product_name: PRODUCT.name,
          product_sku: PRODUCT.sku,
          quantity: qty,
          unit_price: unitCents / 100,
          total_amount: totalCents / 100,
          discount_pct: dcPct
        }).catch(function() {});
      }

      // Meta Conversions API: InitiateCheckout (card)
      sendMetaEvent(env, 'InitiateCheckout', {
        email: data.email.trim(),
        phone: data.phone.trim(),
        firstName: data.first_name.trim(),
        lastName: data.last_name.trim(),
        city: data.city.trim(),
        state: data.state,
        zip: data.zip || '01010'
      }, {
        content_name: PRODUCT.name,
        content_ids: [PRODUCT.sku],
        content_type: 'product',
        value: totalCents / 100,
        currency: PRODUCT.currency,
        num_items: qty,
        order_id: orderNum
      }).catch(function() {});

      return jsonResponse({ redirect_url: recData.checkout_url, order_id: orderNum }, 200, request);
    } else {
      console.error('Recurrente error:', JSON.stringify(recData));
      return jsonResponse({
        error: 'Error al procesar el pago. Por favor intenta de nuevo o elige pago contra entrega.'
      }, 502, request);
    }

  } catch (err) {
    console.error('Worker error:', err.message);
    return jsonResponse({ error: 'Error interno. Por favor intenta de nuevo.' }, 500, request);
  }
}

// ── Handle Cash Order ─────────────────────────────
async function handleCashOrder(request, env) {
  try {
    const data = await request.json();
    const refNum = data.order_id || 'MM-' + Date.now().toString(36).toUpperCase();
    var displayOrder = refNum;

    // Quantity + volume pricing — server-side authoritative
    const qty = clampQty(data.quantity);
    const unitCents = unitPriceCents(qty);
    const totalCents = unitCents * qty;
    const dcPct = discountPct(qty);

    if (env.CRM_URL && env.CRM_SECRET) {
      try {
        var crmResp = await saveToCRM(env.CRM_URL, env.CRM_SECRET, {
          order_id: refNum,
          action: 'create',
          date: new Date().toISOString(),
          name: (data.first_name || '').trim() + ' ' + (data.last_name || '').trim(),
          email: (data.email || '').trim(),
          phone: (data.phone || '').trim(),
          address: (data.address || '').trim() + ', ' + (data.city || '').trim() + ', ' + (data.state || '') + ' ' + (data.zip || '01010'),
          department: data.state || '',
          nit: data.nit || 'C/F',
          method: 'cash',
          product_name: PRODUCT.name,
          product_sku: PRODUCT.sku,
          quantity: qty,
          unit_price: unitCents / 100,
          total_amount: totalCents / 100,
          discount_pct: dcPct
        });
        var crmData = await crmResp.json();
        if (crmData.order_id) displayOrder = crmData.order_id;
      } catch(e) { console.error('CRM save error:', e.message); }
    }

    // Meta Conversions API: Purchase (cash)
    sendMetaEvent(env, 'Purchase', {
      email: (data.email || '').trim(),
      phone: (data.phone || '').trim(),
      firstName: (data.first_name || '').trim(),
      lastName: (data.last_name || '').trim(),
      city: (data.city || '').trim(),
      state: data.state || '',
      zip: data.zip || '01010'
    }, {
      content_name: PRODUCT.name,
      content_ids: [PRODUCT.sku],
      content_type: 'product',
      value: totalCents / 100,
      currency: PRODUCT.currency,
      num_items: qty,
      order_id: displayOrder
    }, LANDING_URL + 'gracias.html?method=cash&order=' + displayOrder + '&qty=' + qty + '&total=' + (totalCents / 100)).catch(function() {});

    return jsonResponse({ result: 'ok', order_id: displayOrder }, 200, request);
  } catch (err) {
    console.error('Cash order error:', err.message);
    return jsonResponse({ error: 'Error interno' }, 500, request);
  }
}

// ── Handle Recurrente Webhook ───────────────────
async function handleWebhook(request, env) {
  try {
    const payload = await request.json();
    const eventType = payload.event_type || '';

    // Only process successful payments
    if (eventType === 'payment_intent.succeeded') {
      const customer = payload.customer || {};
      const checkout = payload.checkout || {};
      const metadata = checkout.metadata || {};
      const amount = (payload.amount_in_cents || 0) / 100;

      // Update order status in MiniMakers CRM
      if (env.CRM_URL && env.CRM_SECRET && metadata.order_id) {
        saveToCRM(env.CRM_URL, env.CRM_SECRET, {
          order_id: metadata.order_id,
          action: 'update',
          status: 'Pagado Pendiente Envio',
          payment_status: 'pagado',
          recurrente_id: payload.id || ''
        }).catch(function() {});
      }

      // Meta Conversions API: Purchase (card — confirmed by Recurrente)
      sendMetaEvent(env, 'Purchase', {
        email: metadata.email || customer.email || '',
        phone: metadata.phone || '',
        firstName: (metadata.customer_name || '').split(' ')[0] || '',
        lastName: (metadata.customer_name || '').split(' ').slice(1).join(' ') || ''
      }, {
        content_name: PRODUCT.name,
        content_ids: [PRODUCT.sku],
        content_type: 'product',
        value: amount,
        currency: PRODUCT.currency,
        order_id: metadata.order_id
      }, LANDING_URL + 'gracias.html?payment=success&order=' + metadata.order_id).catch(function() {});

      console.log('Payment succeeded:', metadata.order_id, customer.email, 'Q' + amount);
    }

    // Always return 200 to acknowledge receipt
    return new Response('OK', { status: 200 });

  } catch (err) {
    console.error('Webhook error:', err.message);
    return new Response('Error', { status: 500 });
  }
}

// ── Save to MiniMakers CRM ────────────────────────
async function saveToCRM(crmUrl, secret, data) {
  return fetch(crmUrl + '/webhooks/landing', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + secret
    },
    body: JSON.stringify(data)
  });
}

// ── Meta Conversions API ─────────────────────────
async function sha256(str) {
  var data = new TextEncoder().encode(str.trim().toLowerCase());
  var hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(function(b) {
    return b.toString(16).padStart(2, '0');
  }).join('');
}

async function sendMetaEvent(env, eventName, userData, customData, eventSourceUrl) {
  if (!env.META_ACCESS_TOKEN) return;

  var hashedUserData = {};
  if (userData.email) hashedUserData.em = [await sha256(userData.email)];
  if (userData.phone) hashedUserData.ph = [await sha256(userData.phone)];
  if (userData.firstName) hashedUserData.fn = [await sha256(userData.firstName)];
  if (userData.lastName) hashedUserData.ln = [await sha256(userData.lastName)];
  if (userData.city) hashedUserData.ct = [await sha256(userData.city)];
  if (userData.state) hashedUserData.st = [await sha256(userData.state)];
  if (userData.zip) hashedUserData.zp = [await sha256(userData.zip)];
  hashedUserData.country = [await sha256('gt')];

  var payload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_source_url: eventSourceUrl || LANDING_URL,
      user_data: hashedUserData,
      custom_data: customData
    }]
  };

  try {
    await fetch(
      'https://graph.facebook.com/' + META_API_VERSION + '/' + META_PIXEL_ID + '/events?access_token=' + env.META_ACCESS_TOKEN,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }
    );
  } catch (e) {
    console.error('Meta CAPI error:', e.message);
  }
}

// ── CORS ────────────────────────────────────────
function corsHeaders(request) {
  var origin = '';
  if (request) {
    var reqOrigin = request.headers.get('Origin') || '';
    if (ALLOWED_ORIGINS.includes(reqOrigin)) origin = reqOrigin;
  }
  return {
    'Access-Control-Allow-Origin': origin || ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function jsonResponse(data, status = 200, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
  });
}

// Version 5.0 — 2026-04-09
// - Recurrente checkout with redirect to gracias.html
// - Webhook handler at /webhook for payment_intent.succeeded
// - MiniMakers Ops CRM integration (Railway)
// - Cash order handler at /cash — now returns AB#### order number from CRM
// - Order tracking with status updates
// - Fixed: Recurrente errors no longer exposed to user
