/**
 * Cloudflare Worker — QPay Pro Checkout Proxy
 *
 * This worker receives customer data from the landing page,
 * calls the QPay Pro API to generate a payment token,
 * and returns the redirect URL to the hosted payment page.
 *
 * SETUP:
 * 1. Go to https://dash.cloudflare.com → Workers & Pages → Create
 * 2. Name it: qpaypro-checkout
 * 3. Paste this code
 * 4. Go to Settings → Variables → Add:
 *    - QPAY_LOGIN    → your QPay Pro x_login (provided by QPay Pro)
 *    - QPAY_API_KEY  → your QPay Pro x_api_key (provided by QPay Pro)
 * 5. Update ALLOWED_ORIGIN below with your GitHub Pages URL
 * 6. Update WORKER_URL in your landing page index.html
 *
 * TEST (sandbox):
 *   Set QPAY_LOGIN = "visanetgt_qpay" and QPAY_API_KEY = "88888888888"
 *   Set USE_SANDBOX = true below
 */

const USE_SANDBOX = false; // Set to true for testing

const QPAY_API_URL = USE_SANDBOX
  ? 'https://sandboxpayments.qpaypro.com/checkout/register_transaction_store'
  : 'https://payments.qpaypro.com/checkout/register_transaction_store';

const QPAY_CHECKOUT_URL = USE_SANDBOX
  ? 'https://sandboxpayments.qpaypro.com/checkout/store'
  : 'https://payments.qpaypro.com/checkout/store';

const ALLOWED_ORIGIN = 'https://enriquezberg.github.io';

// Landing page URL for cancel redirect
const LANDING_URL = 'https://enriquezberg.github.io/minimakers-landing-pages/mini-panqueques-25/';

// Product details
const PRODUCT = {
  name: 'Máquina Industrial 25 Mini Panqueques',
  sku: 'MM-25-PANQUEQUES',
  price: '1200.00',
  currency: 'GTQ',
  taxes: '0.00',
  freight: '0.00'
};

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders()
      });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    try {
      const data = await request.json();

      // Validate required fields
      const required = ['first_name', 'last_name', 'email', 'phone', 'address', 'city', 'state'];
      for (const field of required) {
        if (!data[field] || !data[field].trim()) {
          return jsonResponse({ error: `Campo requerido: ${field}` }, 400);
        }
      }

      // Generate unique order number
      const orderNum = 'MM-' + Date.now().toString(36).toUpperCase();

      // Build QPay Pro payload
      const qpayPayload = {
        x_login: env.QPAY_LOGIN,
        x_api_key: env.QPAY_API_KEY,
        x_amount: PRODUCT.price,
        x_currency_code: PRODUCT.currency,
        x_first_name: data.first_name.trim(),
        x_last_name: data.last_name.trim(),
        x_phone: data.phone.trim(),
        x_ship_to_address: data.address.trim(),
        x_ship_to_city: data.city.trim(),
        x_ship_to_country: 'Guatemala',
        x_ship_to_state: data.state || '0',
        x_ship_to_zip: data.zip || '01010',
        x_ship_to_phone: data.phone.trim(),
        x_description: `Pedido ${orderNum} - ${PRODUCT.name}`,
        x_reference: orderNum,
        x_url_cancel: LANDING_URL,
        x_company: data.nit || 'C/F',
        x_address: data.address.trim(),
        x_city: data.city.trim(),
        x_country: 'Guatemala',
        x_state: data.state || '0',
        x_zip: data.zip || '01010',
        products: JSON.stringify([[PRODUCT.name, PRODUCT.sku, '', '1', PRODUCT.price, PRODUCT.price]]),
        x_freight: PRODUCT.freight,
        taxes: PRODUCT.taxes,
        x_email: data.email.trim(),
        x_type: 'AUTH_ONLY',
        x_method: 'CC',
        x_invoice_num: orderNum,
        custom_fields: JSON.stringify({
          source: 'landing-page',
          order_id: orderNum
        }),
        x_visacuotas: 'si',
        x_relay_url: LANDING_URL + '?payment=success',
        http_origin: 'enriquezberg.github.io',
        origen: 'PLUGIN',
        store_type: 'hostedpage',
        x_discount: '0'
      };

      // Call QPay Pro API
      const qpayResponse = await fetch(QPAY_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(qpayPayload)
      });

      const qpayData = await qpayResponse.json();

      if (qpayData.estado === 'success' && qpayData.data && qpayData.data.token) {
        const redirectUrl = `${QPAY_CHECKOUT_URL}?token=${qpayData.data.token}`;
        return jsonResponse({ redirect_url: redirectUrl, order_id: orderNum });
      } else {
        console.error('QPay Pro error:', JSON.stringify(qpayData));
        return jsonResponse({
          error: 'Error al generar el enlace de pago. Por favor intenta de nuevo o contáctanos por WhatsApp.'
        }, 502);
      }

    } catch (err) {
      console.error('Worker error:', err.message);
      return jsonResponse({
        error: 'Error interno. Por favor intenta de nuevo.'
      }, 500);
    }
  }
};

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
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders()
    }
  });
}
