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

    sheet.appendRow([
      formattedDate,
      data.order_id || '',
      data.name || '',
      data.email || '',
      data.phone || '',
      data.address || '',
      data.nit || 'C/F',
      data.method || '',
      data.amount || '',
      data.status || 'pending',
      data.recurrente_id || ''
    ]);

    // Send email notification to owner
    try {
      var subject = 'Nuevo pedido MiniMakers: ' + (data.order_id || 'Sin ID');
      var body = 'Nuevo pedido recibido:\n\n';
      body += 'Pedido: ' + (data.order_id || '') + '\n';
      body += 'Nombre: ' + (data.name || '') + '\n';
      body += 'Email: ' + (data.email || '') + '\n';
      body += 'Teléfono: ' + (data.phone || '') + '\n';
      body += 'Dirección: ' + (data.address || '') + '\n';
      body += 'Método: ' + (data.method || '') + '\n';
      body += 'Monto: ' + (data.amount || '') + '\n';
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
