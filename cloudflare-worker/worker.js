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
  price_cents: 107500,
  price_display: 'Q1,075',
  currency: 'GTQ'
};

// Volume pricing — per-unit schedule, MUST match index.html pricing() logic
// 1=Q1075, 2=Q1025, 3=Q975, 4=Q925, 5=Q875, 6+=Q800 (escalones de Q50, 6+ salto a Q800)
function unitPriceCents(qty) {
  qty = parseInt(qty, 10) || 1;
  if (qty >= 6)  return 80000;   // Q800
  if (qty === 5) return 87500;   // Q875
  if (qty === 4) return 92500;   // Q925
  if (qty === 3) return 97500;   // Q975
  if (qty === 2) return 102500;  // Q1,025
  return 107500;                 // Q1,075
}

function discountPct(qty) {
  qty = parseInt(qty, 10) || 1;
  if (qty >= 6)  return 26;
  if (qty === 5) return 19;
  if (qty === 4) return 14;
  if (qty === 3) return 9;
  if (qty === 2) return 5;
  return 0;
}

function clampQty(qty) {
  qty = parseInt(qty, 10) || 1;
  if (qty < 1) return 1;
  if (qty > 20) return 20;
  return qty;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request) });
    }

    // Route: Webhook from Recurrente
    if (url.pathname === '/webhook' && request.method === 'POST') {
      return handleWebhook(request, env, ctx);
    }

    // Route: Cash order from landing page
    if (url.pathname === '/cash' && request.method === 'POST') {
      return handleCashOrder(request, env, ctx);
    }

    // Route: Public stock + mode config (proxy to CRM Railway, edge cached)
    if (url.pathname === '/config' && request.method === 'GET') {
      return handleConfig(request, env, ctx);
    }

    // Route: Generic CAPI passthrough for browser-side events (PageView, ViewContent)
    if (url.pathname === '/capi/track' && request.method === 'POST') {
      return handleCapiTrack(request, env, ctx);
    }

    // Route: Create checkout from landing page
    if (request.method === 'POST') {
      return handleCheckout(request, env, ctx);
    }

    return jsonResponse({ error: 'Method not allowed' }, 405, request);
  }
};

// ── Stock + payment mode config (proxied from CRM Railway) ────────────────
async function handleConfig(request, env, ctx) {
  const url = new URL(request.url);
  const sku = url.searchParams.get('sku') || 'MI25MP';
  const cacheKey = `config:${sku}`;

  // Check in-memory cache via Cache API (edge-level, ~60s TTL)
  const cache = caches.default;
  const cacheUrl = new Request(`https://config-cache.local/${cacheKey}`, request);
  const cached = await cache.match(cacheUrl);
  if (cached) {
    // Return a fresh Response with CORS headers
    const cachedBody = await cached.text();
    return new Response(cachedBody, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
        'X-Config-Source': 'edge-cache',
        ...corsHeaders(request)
      }
    });
  }

  // Fallback default if CRM is unreachable
  const fallback = {
    sku: sku,
    stock: -1,
    mode: 'all',
    show_stock_badge: false,
    card_enabled: true,
    cash_enabled: true,
    updated_at: new Date().toISOString(),
    source: 'fallback'
  };

  if (!env.CRM_URL) {
    return jsonResponse(fallback, 200, request);
  }

  try {
    const crmResp = await fetch(
      env.CRM_URL + '/api/landing/config?sku=' + encodeURIComponent(sku),
      { method: 'GET', cf: { cacheTtl: 30, cacheEverything: false } }
    );
    if (!crmResp.ok) {
      return jsonResponse(fallback, 200, request);
    }
    const data = await crmResp.json();
    const body = JSON.stringify(data);

    const response = new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
        'X-Config-Source': 'crm',
        ...corsHeaders(request)
      }
    });

    // Store in edge cache for next ~60s
    if (ctx && ctx.waitUntil) {
      const cacheResp = new Response(body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' }
      });
      ctx.waitUntil(cache.put(cacheUrl, cacheResp));
    }

    return response;
  } catch (err) {
    console.error('[config] error fetching from CRM:', err.message);
    return jsonResponse(fallback, 200, request);
  }
}

// ── Create Recurrente Checkout ──────────────────
async function handleCheckout(request, env, ctx) {
  try {
    const data = await request.json();
    const testEventCode = (data.test_event_code || '').trim() || null;

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

    // Build fbc/fbp BEFORE the metadata payload — these must reach Recurrente so
    // the webhook-triggered Purchase CAPI event can be attributed to the ad click.
    let cardFbc = (data.fbc || '').trim() || null;
    if (!cardFbc && data.fbclid) {
      cardFbc = 'fb.1.' + Date.now() + '.' + data.fbclid;
    }
    let cardFbp = (data.fbp || '').trim() || null;
    if (!cardFbp) {
      cardFbp = 'fb.1.' + Date.now() + '.' + Math.floor(Math.random() * 1e10);
    }

    const checkoutPayload = {
      items: [{
        name: PRODUCT.name + (qty > 1 ? ' (' + qty + ' unidades — −' + dcPct + '%)' : ''),
        amount_in_cents: unitCents,
        currency: PRODUCT.currency,
        quantity: qty
      }],
      success_url: LANDING_URL + 'gracias.html?payment=success&order=' + orderNum + '&qty=' + qty + '&total=' + (totalCents / 100) + (testEventCode ? '&test_event_code=' + encodeURIComponent(testEventCode) : ''),
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
        source: 'landing-page',
        test_event_code: testEventCode || '',
        fbc: cardFbc || '',
        fbp: cardFbp || '',
        client_ip: request.headers.get('cf-connecting-ip') || '',
        client_ua: request.headers.get('user-agent') || ''
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
        ctx.waitUntil(saveToCRM(env.CRM_URL, env.CRM_SECRET, {
          order_id: orderNum,
          action: 'create',
          date: new Date().toISOString(),
          name: data.first_name.trim() + ' ' + data.last_name.trim(),
          email: data.email.trim(),
          phone: data.phone.trim(),
          address: data.address.trim() + ', ' + data.city.trim() + ', ' + data.state + ' ' + (data.zip || '01010'),
          municipio: data.city.trim(),
          department: data.state || '',
          nit: data.nit || 'C/F',
          method: 'card',
          product_name: PRODUCT.name,
          product_sku: PRODUCT.sku,
          quantity: qty,
          unit_price: unitCents / 100,
          total_amount: totalCents / 100,
          discount_pct: dcPct
        }).catch(function() {}));
      }

      // Nota: el InitiateCheckout server-side se eliminó de aquí.
      // Browser dispara InitiateCheckout al ABRIR el modal (semántica oficial Meta)
      // con eventID + mirror al worker /capi/track. Disparar otro aquí (en el
      // POST card) duplicaba el conteo y rompía dedup.

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
async function handleCashOrder(request, env, ctx) {
  try {
    const data = await request.json();
    const testEventCode = (data.test_event_code || '').trim() || null;
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
          municipio: (data.city || '').trim(),
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

    // Build fbc from fbclid if _fbc cookie wasn't available
    var fbc = (data.fbc || '').trim() || null;
    if (!fbc && data.fbclid) {
      fbc = 'fb.1.' + Date.now() + '.' + data.fbclid;
    }
    // Synthesize fbp if browser cookie was missing — improves CAPI coverage
    var fbp = (data.fbp || '').trim() || null;
    if (!fbp) {
      fbp = 'fb.1.' + Date.now() + '.' + Math.floor(Math.random() * 1e10);
    }

    // Meta Conversions API: Purchase (cash) — waitUntil keeps Worker alive for CAPI
    var reqCtx = getRequestContext(request);
    ctx.waitUntil(sendMetaEvent(env, 'Purchase', {
      email: (data.email || '').trim(),
      phone: (data.phone || '').trim(),
      firstName: (data.first_name || '').trim(),
      lastName: (data.last_name || '').trim(),
      city: (data.city || '').trim(),
      state: data.state || '',
      zip: data.zip || '01010',
      fbc: fbc,
      fbp: fbp,
      external_id: (data.email || '').trim() || null
    }, {
      content_name: PRODUCT.name,
      content_ids: [PRODUCT.sku],
      content_type: 'product',
      value: totalCents / 100,
      currency: PRODUCT.currency,
      num_items: qty,
      order_id: displayOrder
    }, LANDING_URL + 'gracias.html?method=cash&order=' + displayOrder + '&qty=' + qty + '&total=' + (totalCents / 100) + (testEventCode ? '&test_event_code=' + encodeURIComponent(testEventCode) : ''), testEventCode, reqCtx).catch(function() {}));

    return jsonResponse({ result: 'ok', order_id: displayOrder }, 200, request);
  } catch (err) {
    console.error('Cash order error:', err.message);
    return jsonResponse({ error: 'Error interno' }, 500, request);
  }
}

// ── Handle Recurrente Webhook ───────────────────
async function handleWebhook(request, env, ctx) {
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
        ctx.waitUntil(saveToCRM(env.CRM_URL, env.CRM_SECRET, {
          order_id: metadata.order_id,
          action: 'update',
          status: 'Pagado Pendiente Envio',
          payment_status: 'pagado',
          recurrente_id: payload.id || ''
        }).catch(function() {}));
      }

      // Meta Conversions API: Purchase (card — confirmed by Recurrente)
      var webhookTestCode = (metadata.test_event_code || '').trim() || null;
      var webhookReqCtx = {
        ip: (metadata.client_ip || '').trim() || null,
        ua: (metadata.client_ua || '').trim() || null
      };
      var webhookFbp = (metadata.fbp || '').trim() || null;
      if (!webhookFbp) {
        webhookFbp = 'fb.1.' + Date.now() + '.' + Math.floor(Math.random() * 1e10);
      }
      ctx.waitUntil(sendMetaEvent(env, 'Purchase', {
        email: metadata.email || customer.email || '',
        phone: metadata.phone || '',
        firstName: (metadata.customer_name || '').split(' ')[0] || '',
        lastName: (metadata.customer_name || '').split(' ').slice(1).join(' ') || '',
        fbc: (metadata.fbc || '').trim() || null,
        fbp: webhookFbp,
        external_id: (metadata.email || customer.email || '').trim() || null
      }, {
        content_name: PRODUCT.name,
        content_ids: [PRODUCT.sku],
        content_type: 'product',
        value: amount,
        currency: PRODUCT.currency,
        order_id: metadata.order_id
      }, LANDING_URL + 'gracias.html?payment=success&order=' + metadata.order_id, webhookTestCode, webhookReqCtx).catch(function() {}));

      console.log('Payment succeeded:', metadata.order_id, customer.email, 'Q' + amount);
    }

    // Always return 200 to acknowledge receipt
    return new Response('OK', { status: 200 });

  } catch (err) {
    console.error('Webhook error:', err.message);
    return new Response('Error', { status: 500 });
  }
}

// ── Extract request context for CAPI matching ────────
function getRequestContext(request) {
  return {
    ip: request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || '',
    ua: request.headers.get('user-agent') || ''
  };
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

// ── Generic CAPI passthrough ──────────────────────
// Browser dispara fbq('track','PageView',{},{eventID:eid}) y al mismo tiempo POST aquí
// con el mismo event_id → Meta deduplica y la cobertura CAPI sube a ~100%.
async function handleCapiTrack(request, env, ctx) {
  try {
    const data = await request.json();
    const eventName = String(data.event_name || '').trim();
    const eventId = String(data.event_id || '').trim();
    const allowed = ['PageView', 'ViewContent', 'InitiateCheckout', 'AddPaymentInfo'];
    if (!eventName || !allowed.includes(eventName) || !eventId) {
      return jsonResponse({ error: 'invalid event' }, 400, request);
    }

    var fbc = (data.fbc || '').trim() || null;
    if (!fbc && data.fbclid) {
      fbc = 'fb.1.' + Date.now() + '.' + data.fbclid;
    }
    var fbp = (data.fbp || '').trim() || null;
    if (!fbp) {
      fbp = 'fb.1.' + Date.now() + '.' + Math.floor(Math.random() * 1e10);
    }

    const testEventCode = (data.test_event_code || '').trim() || null;
    const reqCtx = getRequestContext(request);
    const customData = Object.assign({}, data.custom_data || {}, { event_id: eventId });

    ctx.waitUntil(sendMetaEvent(env, eventName, {
      fbc: fbc,
      fbp: fbp,
      external_id: fbp
    }, customData, data.event_source_url || LANDING_URL, testEventCode, reqCtx).catch(function() {}));

    return jsonResponse({ ok: true }, 200, request);
  } catch (err) {
    console.error('capi/track error:', err.message);
    return jsonResponse({ error: 'internal' }, 500, request);
  }
}

async function sendMetaEvent(env, eventName, userData, customData, eventSourceUrl, testEventCode, requestContext) {
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

  // fbc/fbp — critical for ad click attribution
  // fbc = Facebook Click ID (connects the ad click to the conversion)
  // fbp = Facebook Browser ID (identifies the user across sessions)
  if (userData.fbc) hashedUserData.fbc = userData.fbc;       // NOT hashed
  if (userData.fbp) hashedUserData.fbp = userData.fbp;       // NOT hashed
  // external_id — stable customer identifier hashed for privacy
  // Helps Meta link events from the same user across sessions/devices
  if (userData.external_id) hashedUserData.external_id = [await sha256(userData.external_id)];
  // client IP + user agent — fallback matching when fbc/fbp unavailable
  if (requestContext) {
    if (requestContext.ip) hashedUserData.client_ip_address = requestContext.ip;
    if (requestContext.ua) hashedUserData.client_user_agent = requestContext.ua;
  }

  // event_id top-level → Meta deduplica con el Pixel browser-side cuando ambos mandan el mismo ID
  // Prioridad: event_id explícito (PageView/ViewContent) > order_id (Purchase/InitiateCheckout)
  var eventId = null;
  if (customData) {
    if (customData.event_id) {
      eventId = String(customData.event_id);
      delete customData.event_id;
    } else if (customData.order_id) {
      eventId = String(customData.order_id);
    }
  }

  var payload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      action_source: 'website',
      event_source_url: eventSourceUrl || LANDING_URL,
      user_data: hashedUserData,
      custom_data: customData
    }]
  };

  // test_event_code (top-level, no adentro de data[]) → marca el evento como TEST
  // Meta lo rutea a Events Manager → Test Events y NO cuenta como conversión real
  if (testEventCode) {
    payload.test_event_code = testEventCode;
  }

  try {
    var resp = await fetch(
      'https://graph.facebook.com/' + META_API_VERSION + '/' + META_PIXEL_ID + '/events?access_token=' + env.META_ACCESS_TOKEN,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }
    );
    if (!resp.ok) {
      var respText = await resp.text();
      console.error('Meta CAPI ' + eventName + ' failed: ' + resp.status + ' ' + respText.slice(0, 300));
    }
  } catch (e) {
    console.error('Meta CAPI ' + eventName + ' error: ' + e.message);
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

// Version 5.3 — 2026-04-11
// - Recurrente checkout with redirect to gracias.html
// - Webhook handler at /webhook for payment_intent.succeeded
// - MiniMakers Ops CRM integration (Railway)
// - Cash order handler at /cash — returns AB#### order number from CRM
// - Order tracking with status updates
// - Fixed: Recurrente errors no longer exposed to user
// - Fixed: CAPI now sends event_id top-level (dedup with browser Pixel)
// - Added: test_event_code support — Meta routes events to Test Events screen
// - CRITICAL FIX: ctx.waitUntil() wraps all async side-effects (CAPI, CRM save)
//   so Cloudflare keeps the Worker alive until they complete. Before this fix,
//   CAPI events were being silently cut off when the Worker responded to the
//   client, causing ~30-40% loss of server-side conversion tracking.
