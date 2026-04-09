# QPay Pro Checkout — Setup Guide

## How it works

```
Landing Page → Checkout Form → Cloudflare Worker → QPay Pro API → Hosted Payment Page
```

1. Customer clicks "Comprar Ahora" → checkout modal opens
2. Customer fills in name, email, phone, address
3. Form sends data to your Cloudflare Worker
4. Worker calls QPay Pro API with your credentials (securely stored)
5. QPay Pro returns a payment token
6. Customer is redirected to QPay Pro's hosted payment page
7. After payment, customer returns to your landing page

## Setup Steps (5 minutes)

### 1. Create Cloudflare Account (free)
- Go to https://dash.cloudflare.com/sign-up
- Create a free account

### 2. Create the Worker
- Go to **Workers & Pages** → **Create** → **Create Worker**
- Name it: `qpaypro-checkout`
- Click **Deploy**
- Click **Edit code** → paste the contents of `worker.js`
- Click **Deploy**

### 3. Add Your QPay Pro Credentials
- In the Worker dashboard, go to **Settings** → **Variables and Secrets**
- Click **Add** and create these two variables:

| Variable Name | Value | Type |
|---------------|-------|------|
| `QPAY_LOGIN` | Your QPay Pro login (provided by QPay Pro) | Secret |
| `QPAY_API_KEY` | Your QPay Pro API key (provided by QPay Pro) | Secret |

### 4. Update the Landing Page
- In `index.html`, find this line:
  ```js
  var WORKER_URL = 'https://qpaypro-checkout.YOUR_SUBDOMAIN.workers.dev';
  ```
- Replace `YOUR_SUBDOMAIN` with your Cloudflare Workers subdomain
  - You can find it in Cloudflare dashboard → Workers → your subdomain is shown at the top
  - Example: `https://qpaypro-checkout.luis-minimakers.workers.dev`

### 5. Test with Sandbox (Optional)
- In `worker.js`, set `USE_SANDBOX = true`
- Use these test credentials:
  - `QPAY_LOGIN`: `visanetgt_qpay`
  - `QPAY_API_KEY`: `88888888888`
- Test a payment flow
- When ready for production, set `USE_SANDBOX = false` and use real credentials

## Getting Your QPay Pro Credentials

Since you already have QPay Pro linked to your website, you should already have:
- `x_login` — your merchant identifier
- `x_api_key` — your private API key

If you don't have these, contact QPay Pro support and request API credentials for the "App Checkout (Hosted Page)" integration.

## Security Notes

- Your QPay Pro credentials are stored as **encrypted secrets** in Cloudflare — they never appear in your landing page code
- The Worker only accepts requests from your GitHub Pages domain (CORS restricted)
- Customer credit card data is handled entirely by QPay Pro — it never touches your system
- The free Cloudflare Workers plan includes 100,000 requests/day

## After Payment

When payment is successful, QPay Pro redirects the customer to:
```
https://enriquezberg.github.io/minimakers-landing-pages/mini-panqueques-25/?payment=success
```

You can add a success message on the landing page that detects this parameter.
QPay Pro also sends the transaction details via GET parameters:
- `x_response_status` — 1 = success
- `x_trans_id` — transaction ID
- `x_amount` — amount charged
- `x_invoice_num` — your order number
