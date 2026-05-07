/**
 * Service to generate invoice/receipt data and HTML templates.
 */
class InvoiceService {
    /**
     * Generate HTML for a consultation invoice
     * @param {Object} data - Invoice data
     * @param {string} data.citaId - Appointment ID
     * @param {string} data.pacienteNombre - Patient name
     * @param {string} data.medicoNombre - Doctor name
     * @param {string} data.especialidad - Medical specialty
     * @param {string} data.fecha - Consultation date
     * @param {number} data.montoTotal - Total amount paid
     * @param {string} data.referencia - Payment reference
     * @param {string} data.modalidad - Modality (Virtual/Presencial)
     */
    generateInvoiceHTML(data) {
        const {
            citaId,
            pacienteNombre,
            medicoNombre,
            especialidad,
            fecha,
            montoTotal,
            referencia,
            modalidad
        } = data;

        const formattedAmount = new Intl.NumberFormat('es-DO', {
            style: 'currency',
            currency: 'DOP'
        }).format(montoTotal);

        const invoiceNumber = `FACT-${citaId.slice(0, 8).toUpperCase()}`;

        return `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #333; line-height: 1.6; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 20px auto; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
        .header { background-color: #1a3d63; color: white; padding: 30px; text-align: center; }
        .header h1 { margin: 0; font-size: 24px; letter-spacing: 1px; }
        .header p { margin: 5px 0 0; opacity: 0.8; font-size: 14px; }
        .content { padding: 30px; background-color: white; }
        .invoice-details { display: flex; justify-content: space-between; margin-bottom: 30px; border-bottom: 2px solid #f1f5f9; padding-bottom: 20px; }
        .bill-to, .invoice-info { flex: 1; }
        .invoice-info { text-align: right; }
        .label { font-weight: bold; color: #64748b; font-size: 12px; text-transform: uppercase; margin-bottom: 5px; }
        .value { font-weight: 600; color: #1e293b; font-size: 15px; }
        .table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
        .table th { text-align: left; background-color: #f8fafc; padding: 12px; color: #64748b; font-size: 13px; border-bottom: 1px solid #e2e8f0; }
        .table td { padding: 15px 12px; border-bottom: 1px solid #f1f5f9; font-size: 14px; }
        .total-row { background-color: #f8fafc; font-weight: bold; }
        .total-label { text-align: right; }
        .total-value { color: #137fec; font-size: 18px; }
        .footer { background-color: #f8fafc; padding: 20px; text-align: center; color: #94a3b8; font-size: 12px; }
        .status-badge { display: inline-block; padding: 4px 12px; background-color: #dcfce7; color: #166534; border-radius: 99px; font-size: 11px; font-weight: 700; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>VIREM</h1>
            <p>Comprobante de Pago Electrónico</p>
        </div>
        <div class="content">
            <div class="invoice-details">
                <div class="bill-to">
                    <div class="label">Facturado a:</div>
                    <div class="value">${pacienteNombre}</div>
                </div>
                <div class="invoice-info">
                    <div class="label">No. Factura:</div>
                    <div class="value">${invoiceNumber}</div>
                    <div class="label" style="margin-top: 10px;">Fecha:</div>
                    <div class="value">${new Date().toLocaleDateString('es-DO')}</div>
                </div>
            </div>

            <table class="table">
                <thead>
                    <tr>
                        <th>Descripción del Servicio</th>
                        <th style="text-align: right;">Monto</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td>
                            <div style="font-weight: 600; margin-bottom: 4px;">Consulta Médica - ${especialidad}</div>
                            <div style="font-size: 12px; color: #64748b;">
                                Médico: ${medicoNombre}<br>
                                Fecha de cita: ${new Date(fecha).toLocaleString('es-DO')}<br>
                                Modalidad: ${modalidad.charAt(0).toUpperCase() + modalidad.slice(1)}
                            </div>
                        </td>
                        <td style="text-align: right; vertical-align: top;">${formattedAmount}</td>
                    </tr>
                    <tr class="total-row">
                        <td class="total-label">Total Pagado</td>
                        <td style="text-align: right;" class="total-value">${formattedAmount}</td>
                    </tr>
                </tbody>
            </table>

            <div style="text-align: center;">
                <div class="label">Referencia de Pago:</div>
                <div class="value" style="font-family: monospace;">${referencia}</div>
                <div class="status-badge">PAGADO</div>
            </div>
            
            <div style="margin-top: 30px; padding: 15px; background-color: #eff6ff; border-radius: 8px; font-size: 13px; color: #1e40af;">
                <strong>Nota:</strong> Este es un comprobante automático generado por la plataforma VIREM. Para cualquier duda o aclaración, favor contactar a soporte@virem.com.
            </div>
        </div>
        <div class="footer">
            &copy; ${new Date().getFullYear()} VIREM - Plataforma de Telemedicina Avanzada<br>
            Santo Domingo, República Dominicana
        </div>
    </div>
</body>
</html>
        `;
    }
}

module.exports = new InvoiceService();
