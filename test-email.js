require('dotenv').config();
const nodemailer = require('nodemailer');

async function testEmail() {
  console.log('Testing SMTP connection...');
  console.log('Host:', process.env.SMTP_HOST);
  console.log('Port:', process.env.SMTP_PORT);
  console.log('User:', process.env.SMTP_USER);
  console.log('Secure:', process.env.SMTP_SECURE);

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: 465,
    secure: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  try {
    await transporter.verify();
    console.log('✅ SMTP Connection verified successfully!');
    
    console.log('Sending test email to:', process.env.SMTP_USER);
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: process.env.SMTP_USER,
      subject: 'Test Email from VIREM',
      text: 'This is a test email to verify SMTP configuration.'
    });
    console.log('✅ Test email sent successfully!');
  } catch (error) {
    console.error('❌ SMTP Error:', error);
  }
}

testEmail();
