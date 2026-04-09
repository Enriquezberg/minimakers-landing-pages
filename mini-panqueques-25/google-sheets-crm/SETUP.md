# Google Sheets CRM — Setup Guide

This turns a Google Sheet into a simple CRM that automatically logs every order.

## Step 1: Create the Google Sheet

1. Go to https://sheets.google.com → Create new spreadsheet
2. Name it: "MiniMakers - Pedidos"
3. In the first row (headers), add these columns:
   - A1: `Fecha`
   - B1: `Pedido`
   - C1: `Nombre`
   - D1: `Email`
   - E1: `Teléfono`
   - F1: `Dirección`
   - G1: `NIT`
   - H1: `Método`
   - I1: `Monto`
   - J1: `Estado`
   - K1: `Recurrente ID`

## Step 2: Add the Apps Script

1. In your Google Sheet, go to **Extensions → Apps Script**
2. Delete any existing code
3. Paste the code from `apps-script.js` in this folder
4. Click **Deploy → New deployment**
5. Type: **Web app**
6. Execute as: **Me**
7. Who has access: **Anyone**
8. Click **Deploy**
9. Copy the URL it gives you (looks like `https://script.google.com/macros/s/.../exec`)

## Step 3: Add URL to Cloudflare Worker

1. Go to Cloudflare → Workers → qpaypro-checkout → Settings → Variables
2. Add new variable:
   - Name: `GOOGLE_SHEETS_URL`
   - Value: (paste the URL from step 2)
   - Type: Secret
3. Deploy the Worker

## Done!

Every order (card and cash) will now automatically appear in your Google Sheet.
