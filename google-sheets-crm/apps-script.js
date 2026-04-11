/**
 * Google Apps Script — MiniMakers Order CRM
 *
 * Receives POST requests from the Cloudflare Worker
 * and logs each order to the active Google Sheet.
 *
 * Deploy as Web App:
 *   Execute as: Me
 *   Who has access: Anyone
 */

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

    // Check if order already exists (update status if so)
    var orderCol = 2; // Column B = Pedido
    var statusCol = 10; // Column J = Estado
    var recIdCol = 11; // Column K = Recurrente ID
    var lastRow = sheet.getLastRow();

    for (var i = 2; i <= lastRow; i++) {
      if (sheet.getRange(i, orderCol).getValue() === data.order_id) {
        // Update existing order
        sheet.getRange(i, statusCol).setValue(data.status || 'updated');
        if (data.recurrente_id) {
          sheet.getRange(i, recIdCol).setValue(data.recurrente_id);
        }
        return ContentService.createTextOutput(JSON.stringify({ result: 'updated' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }

    // New order — append row
    var date = data.date ? new Date(data.date) : new Date();
    var formattedDate = Utilities.formatDate(date, 'America/Guatemala', 'yyyy-MM-dd HH:mm');

    // Total amount: prefer total_amount (new), fall back to amount (legacy)
    var totalAmount = data.total_amount || data.amount || '';
    var qty = data.quantity || 1;
    var unitPrice = data.unit_price || '';
    var discountPct = data.discount_pct || 0;

    sheet.appendRow([
      formattedDate,                // A — Fecha
      data.order_id || '',          // B — Pedido
      data.name || '',              // C — Nombre
      data.email || '',             // D — Email
      data.phone || '',             // E — Teléfono
      data.address || '',           // F — Dirección
      data.nit || 'C/F',            // G — NIT
      data.method || '',            // H — Método
      totalAmount,                  // I — Monto total
      data.status || 'pending',     // J — Estado
      data.recurrente_id || '',     // K — Recurrente ID
      qty,                          // L — Cantidad
      unitPrice,                    // M — Precio unitario
      discountPct                   // N — Descuento %
    ]);

    // Send email notification to owner
    try {
      var qtyLabel = qty > 1 ? (qty + ' unidades × Q' + unitPrice + ' (−' + discountPct + '%)') : '1 unidad';
      var subject = 'Nuevo pedido MiniMakers: ' + (data.order_id || 'Sin ID') + ' — Q' + totalAmount;
      var body = 'Nuevo pedido recibido:\n\n';
      body += 'Pedido: ' + (data.order_id || '') + '\n';
      body += 'Nombre: ' + (data.name || '') + '\n';
      body += 'Email: ' + (data.email || '') + '\n';
      body += 'Teléfono: ' + (data.phone || '') + '\n';
      body += 'Dirección: ' + (data.address || '') + '\n';
      body += 'Método: ' + (data.method || '') + '\n';
      body += 'Cantidad: ' + qtyLabel + '\n';
      body += 'Total: Q' + totalAmount + '\n';
      body += 'Estado: ' + (data.status || 'pending') + '\n';

      MailApp.sendEmail(Session.getActiveUser().getEmail(), subject, body);
    } catch (emailErr) {
      // Email sending is optional, don't fail the request
    }

    return ContentService.createTextOutput(JSON.stringify({ result: 'created' }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ status: 'MiniMakers CRM active' }))
    .setMimeType(ContentService.MimeType.JSON);
}
