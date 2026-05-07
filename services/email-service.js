const nodemailer = require("nodemailer");

/**
 * Service to handle sending emails using SMTP configuration from .env
 */
class EmailService {
    constructor() {
        const isFallback = process.env.EMAIL_FALLBACK_TO_CONSOLE === "true";
        
        if (!isFallback) {
            this.transporter = nodemailer.createTransport({
                host: process.env.SMTP_HOST,
                port: parseInt(process.env.SMTP_PORT, 10) || 465,
                secure: process.env.SMTP_SECURE === "true",
                auth: {
                    user: process.env.SMTP_USER,
                    pass: process.env.SMTP_PASS,
                },
            });
        } else {
            this.transporter = null;
        }
    }

    /**
     * Send an email
     * @param {Object} options - Email options
     * @param {string} options.to - Recipient email
     * @param {string} options.subject - Email subject
     * @param {string} [options.text] - Plain text content
     * @param {string} [options.html] - HTML content
     * @param {Array} [options.attachments] - Optional attachments
     */
    async sendEmail({ to, subject, text, html, attachments }) {
        const from = process.env.SMTP_FROM || process.env.SMTP_USER;

        if (!this.transporter) {
            console.log("--- [EMAIL FALLBACK] ---");
            console.log(`To: ${to}`);
            console.log(`Subject: ${subject}`);
            console.log(`Body: ${text || "[HTML Content]"}`);
            console.log("------------------------");
            return { success: true, messageId: "console-fallback" };
        }

        try {
            const info = await this.transporter.sendMail({
                from,
                to,
                subject,
                text,
                html,
                attachments,
            });
            console.log(`[EmailService] Email sent to ${to}: ${info.messageId}`);
            return { success: true, messageId: info.messageId };
        } catch (error) {
            console.error(`[EmailService] Error sending email to ${to}:`, error);
            return { success: false, error: error.message };
        }
    }
}

module.exports = new EmailService();
