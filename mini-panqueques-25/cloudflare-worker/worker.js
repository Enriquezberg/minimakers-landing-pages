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
 *    - NOTIFY_EMAIL     → Your email for order notifications (optional)
 *    - GOOGLE_SHEETS_URL → Google Apps Script URL for CRM (optional)
 */

const ALLOWED_ORIGIN = 'https://enriquezberg.github.io';
const LANDING_URL = 'https://enriquezberg.github.io/minimakers-landing-pages/mini-panqueques-25/';
const WHATSAPP_NUM = '50231695584';

const PRODUCT = {
  name: 'Maquina Industrial 25 Mini Panqueques',
  price_cents: 120000,
  price_display: 'Q1,200',
  currency: 'GTQ'
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // Route: Webhook from Recurrente
    if (url.pathname === '/webhook' && request.method === 'POST') {
      return handleWebhook(request, env);
    }

    // Route: Create checkout from landing page
    if (request.method === 'POST') {
      return handleCheckout(request, env);
    }

    return jsonResponse({ error: 'Method not allowed' }, 405);
  }
};

// ── Create Recurrente Checkout ──────────────────
async function handleCheckout(request, env) {
  try {
    const data = await request.json();

    const required = ['first_name', 'last_name', 'email', 'phone', 'address', 'city', 'state'];
    for (const field of required) {
      if (!data[field] || !data[field].trim()) {
        return jsonResponse({ error: 'Campo requerido: ' + field }, 400);
      }
    }

    const orderNum = 'MM-' + Date.now().toString(36).toUpperCase();

    const checkoutPayload = {
      items: [{
        name: PRODUCT.name,
        amount_in_cents: PRODUCT.price_cents,
        currency: PRODUCT.currency,
        quantity: 1
      }],
      success_url: LANDING_URL + 'gracias.html?payment=success&order=' + orderNum,
      cancel_url: LANDING_URL + '?payment=cancelled',
      metadata: {
        order_id: orderNum,
        customer_name: data.first_name.trim() + ' ' + data.last_name.trim(),
        email: data.email.trim(),
        phone: data.phone.trim(),
        address: data.address.trim() + ', ' + data.city.trim() + ', ' + data.state,
        zip: data.zip || '01010',
        nit: data.nit || 'C/F',
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
      // Also save order data to Google Sheets if configured
      if (env.GOOGLE_SHEETS_URL) {
        saveToSheets(env.GOOGLE_SHEETS_URL, {
          order_id: orderNum,
          date: new Date().toISOString(),
          name: data.first_name.trim() + ' ' + data.last_name.trim(),
          email: data.email.trim(),
          phone: data.phone.trim(),
          address: data.address.trim() + ', ' + data.city.trim() + ', ' + data.state + ' ' + (data.zip || '01010'),
          nit: data.nit || 'C/F',
          method: 'card',
          amount: PRODUCT.price_display,
          status: 'pending'
        }).catch(function() {});
      }

      return jsonResponse({ redirect_url: recData.checkout_url, order_id: orderNum });
    } else {
      return jsonResponse({
        error: 'Error Recurrente: ' + JSON.stringify(recData),
        debug: true
      }, 502);
    }

  } catch (err) {
    console.error('Worker error:', err.message);
    return jsonResponse({ error: 'Error interno. Por favor intenta de nuevo.' }, 500);
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

      // Update Google Sheets order status
      if (env.GOOGLE_SHEETS_URL && metadata.order_id) {
        saveToSheets(env.GOOGLE_SHEETS_URL, {
          order_id: metadata.order_id,
          date: payload.created_at || new Date().toISOString(),
          name: metadata.customer_name || customer.full_name || '',
          email: metadata.email || customer.email || '',
          phone: metadata.phone || '',
          address: metadata.address || '',
          nit: metadata.nit || 'C/F',
          method: 'card',
          amount: 'Q' + amount.toFixed(2),
          status: 'paid',
          recurrente_id: payload.id || ''
        }).catch(function() {});
      }

      // Send WhatsApp notification to owner
      console.log('Payment succeeded:', metadata.order_id, customer.email, 'Q' + amount);
    }

    // Always return 200 to acknowledge receipt
    return new Response('OK', { status: 200 });

  } catch (err) {
    console.error('Webhook error:', err.message);
    return new Response('Error', { status: 500 });
  }
}

// ── Save to Google Sheets via Apps Script ───────
async function saveToSheets(url, data) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

// ── CORS ────────────────────────────────────────
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

// Version 3.0 — 2026-04-09
// - Recurrente checkout with redirect to gracias.html
// - Webhook handler at /webhook for payment_intent.succeeded
// - Google Sheets CRM integration (optional)
// - Order tracking with status updates
