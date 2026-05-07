require('dotenv').config();
const emailService = require('../services/email-service');
const invoiceService = require('../services/invoice-service');

async function testInvoicing() {
    console.log('--- Testing Invoicing Flow ---');
    
    const mockData = {
        citaId: 'test-uuid-12345678',
        pacienteNombre: 'Paciente de Prueba',
        medicoNombre: 'Dr. Especialista',
        especialidad: 'Medicina General',
        fecha: new Date().toISOString(),
        montoTotal: 1500,
        referencia: 'SIM-TEST-REF',
        modalidad: 'virtual'
    };

    console.log('Generating HTML...');
    const html = invoiceService.generateInvoiceHTML(mockData);
    console.log('HTML Generated (length):', html.length);

    console.log('Sending Email to:', process.env.SMTP_USER);
    const result = await emailService.sendEmail({
        to: process.env.SMTP_USER,
        subject: 'Test Invoice from VIREM',
        html
    });

    if (result.success) {
        console.log('✅ Test successful! MessageId:', result.messageId);
    } else {
        console.error('❌ Test failed:', result.error);
    }
}

testInvoicing();
