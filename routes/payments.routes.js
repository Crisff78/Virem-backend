const express = require("express");
const { randomUUID } = require("crypto");
const pool = require("../config/db");
const { requireAuth } = require("./middleware/auth");
const {
  PACIENTE_ROLE_ID,
  resolveUserContext,
  normalizeText,
} = require("../services/platform-core");
const {
  ensureRfCoreSchema,
  buildInvoiceNumber,
} = require("../services/rf-core");

const router = express.Router();

function toMoney(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.round(parsed * 100) / 100;
}

router.use(requireAuth);
router.use(async (_req, res, next) => {
  try {
    await ensureRfCoreSchema();
    return next();
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "No se pudo preparar el modulo de pagos.",
    });
  }
});

// ===============================
// POST /api/payments/me/citas/:citaId/procesar
// Pago simulado (sin cobro real)
// ===============================
router.post("/me/citas/:citaId/procesar", async (req, res) => {
  const citaId = normalizeText(req.params?.citaId);
  const metodoPago = normalizeText(req.body?.metodoPago || req.body?.metodo || "tarjeta");
  const moneda = normalizeText(req.body?.moneda || "DOP").toUpperCase().slice(0, 3) || "DOP";

  if (!citaId) {
    return res.status(400).json({ success: false, message: "citaId es obligatorio." });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      await client.query("ROLLBACK");
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }

    if (context.roleId !== PACIENTE_ROLE_ID) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "Solo pacientes pueden procesar pagos desde este endpoint.",
      });
    }

    const citaResult = await client.query(
      `SELECT
         c.citaid::text AS citaid,
         c.pacienteid::text AS pacienteid,
         c.medicoid::text AS medicoid,
         c.precio,
         c.fechahorainicio,
         c.estado_codigo,
         COALESCE(ec.nombre, 'Pendiente') AS estado_nombre,
         COALESCE(m.nombrecompleto, 'Medico') AS medico_nombre,
         COALESCE(e.nombre, 'Medicina General') AS especialidad
       FROM cita c
       LEFT JOIN estado_cita ec ON ec.estadocitaid = c.estadocitaid
       LEFT JOIN medico m ON m.medicoid = c.medicoid
       LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
       WHERE c.citaid::text = $1::text
         AND c.pacienteid = $2
       LIMIT 1
       FOR UPDATE`,
      [citaId, Number(context.paciente.pacienteid)]
    );

    if (!citaResult.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "No se encontro la cita para este paciente.",
      });
    }

    const cita = citaResult.rows[0];

    const existingPayment = await client.query(
      `SELECT
         p.pagoid::text AS pagoid,
         p.estado,
         p.monto,
         p.moneda,
         p.metodo_pago,
         f.facturaid::text AS facturaid,
         f.numero_factura
       FROM pago p
       LEFT JOIN factura f ON f.pagoid = p.pagoid
       WHERE p.citaid::text = $1::text
       LIMIT 1`,
      [citaId]
    );

    if (existingPayment.rows.length) {
      await client.query("COMMIT");
      const row = existingPayment.rows[0];
      return res.json({
        success: true,
        message: "Ya existe un pago registrado para esta cita.",
        pago: {
          pagoid: normalizeText(row.pagoid),
          estado: normalizeText(row.estado),
          monto: toMoney(row.monto, 0),
          moneda: normalizeText(row.moneda) || "DOP",
          metodoPago: normalizeText(row.metodo_pago),
          factura: row.facturaid
            ? {
                facturaid: normalizeText(row.facturaid),
                numero: normalizeText(row.numero_factura),
              }
            : null,
          simulado: true,
        },
      });
    }

    const monto = toMoney(req.body?.monto, toMoney(cita.precio, 0));
    const pagoid = randomUUID();
    const facturaid = randomUUID();
    const numeroFactura = buildInvoiceNumber();

    const paymentDetail = {
      citaId,
      medico: normalizeText(cita.medico_nombre),
      especialidad: normalizeText(cita.especialidad),
      fechaHora: cita.fechahorainicio || null,
      modo: "simulado",
      disclaimer:
        "Pago simulado: esta operacion no realiza cobros reales ni integra una pasarela externa.",
    };

    await client.query(
      `INSERT INTO pago (
         pagoid,
         citaid,
         pacienteid,
         medicoid_text,
         monto,
         moneda,
         metodo_pago,
         estado,
         referencia_externa,
         detalle_json,
         created_at,
         updated_at
       )
       VALUES (
         $1::uuid,
         $2::uuid,
         $3,
         $4,
         $5,
         $6,
         $7,
         'simulado_aprobado',
         $8,
         $9::jsonb,
         NOW(),
         NOW()
       )`,
      [
        pagoid,
        citaId,
        Number(context.paciente.pacienteid),
        String(cita.medicoid || ""),
        monto,
        moneda,
        metodoPago || "tarjeta",
        `SIM-${Date.now()}`,
        JSON.stringify(paymentDetail),
      ]
    );

    await client.query(
      `INSERT INTO factura (
         facturaid,
         pagoid,
         numero_factura,
         pacienteid,
         monto,
         moneda,
         detalle_json,
         created_at
       )
       VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7::jsonb,NOW())`,
      [
        facturaid,
        pagoid,
        numeroFactura,
        Number(context.paciente.pacienteid),
        monto,
        moneda,
        JSON.stringify({
          ...paymentDetail,
          metodoPago,
        }),
      ]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Pago procesado en modo simulado. No se realizo cobro real.",
      pago: {
        pagoid,
        citaId,
        monto,
        moneda,
        metodoPago,
        estado: "simulado_aprobado",
        simulado: true,
        factura: {
          facturaid,
          numero: numeroFactura,
        },
        comprobante: {
          visible: true,
          descargable: true,
        },
      },
    });
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }
    return res.status(500).json({ success: false, message: "No se pudo procesar el pago." });
  } finally {
    if (client) client.release();
  }
});

// ===============================
// GET /api/payments/me
// Paciente: pagos propios
// Admin: todos los pagos
// ===============================
router.get("/me", async (req, res) => {
  const limitRaw = Number.parseInt(String(req.query?.limit || "80"), 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(300, limitRaw)) : 80;

  let client;
  try {
    client = await pool.connect();

    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }
    const isAdmin = Number(context.roleId) === 3;

    let sql = "";
    let params = [];

    if (isAdmin) {
      sql = `SELECT
        p.pagoid::text AS pagoid,
        p.citaid::text AS citaid,
        p.pacienteid,
        p.medicoid_text,
        p.monto,
        p.moneda,
        p.metodo_pago,
        p.estado,
        p.created_at,
        f.facturaid::text AS facturaid,
        f.numero_factura
      FROM pago p
      LEFT JOIN factura f ON f.pagoid = p.pagoid
      ORDER BY p.created_at DESC
      LIMIT $1`;
      params = [limit];
    } else if (Number(context.roleId) === PACIENTE_ROLE_ID) {
      sql = `SELECT
        p.pagoid::text AS pagoid,
        p.citaid::text AS citaid,
        p.pacienteid,
        p.medicoid_text,
        p.monto,
        p.moneda,
        p.metodo_pago,
        p.estado,
        p.created_at,
        f.facturaid::text AS facturaid,
        f.numero_factura
      FROM pago p
      LEFT JOIN factura f ON f.pagoid = p.pagoid
      WHERE p.pacienteid = $1
      ORDER BY p.created_at DESC
      LIMIT $2`;
      params = [Number(context.paciente.pacienteid), limit];
    } else {
      return res.status(403).json({
        success: false,
        message: "Solo pacientes o administradores pueden consultar pagos.",
      });
    }

    const result = await client.query(sql, params);
    return res.json({
      success: true,
      pagos: result.rows.map((row) => ({
        pagoid: normalizeText(row.pagoid),
        citaId: normalizeText(row.citaid),
        pacienteId: Number(row.pacienteid || 0),
        medicoId: normalizeText(row.medicoid_text),
        monto: toMoney(row.monto, 0),
        moneda: normalizeText(row.moneda) || "DOP",
        metodoPago: normalizeText(row.metodo_pago),
        estado: normalizeText(row.estado),
        createdAt: row.created_at || null,
        factura: row.facturaid
          ? {
              facturaid: normalizeText(row.facturaid),
              numero: normalizeText(row.numero_factura),
            }
          : null,
        simulado: true,
      })),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "No se pudieron listar pagos." });
  } finally {
    if (client) client.release();
  }
});

// ===============================
// GET /api/payments/me/:pagoId/comprobante
// ===============================
router.get("/me/:pagoId/comprobante", async (req, res) => {
  const pagoId = normalizeText(req.params?.pagoId);
  if (!pagoId) {
    return res.status(400).json({ success: false, message: "pagoId es obligatorio." });
  }

  let client;
  try {
    client = await pool.connect();

    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }
    const isAdmin = Number(context.roleId) === 3;

    const result = await client.query(
      `SELECT
         p.pagoid::text AS pagoid,
         p.citaid::text AS citaid,
         p.pacienteid,
         p.medicoid_text,
         p.monto,
         p.moneda,
         p.metodo_pago,
         p.estado,
         p.referencia_externa,
         p.detalle_json,
         p.created_at,
         f.facturaid::text AS facturaid,
         f.numero_factura
       FROM pago p
       LEFT JOIN factura f ON f.pagoid = p.pagoid
       WHERE p.pagoid::text = $1::text
       LIMIT 1`,
      [pagoId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "Pago no encontrado." });
    }

    const row = result.rows[0];
    const ownerPacienteId = Number(row.pacienteid || 0);

    if (!isAdmin) {
      if (
        Number(context.roleId) !== PACIENTE_ROLE_ID ||
        Number(context.paciente.pacienteid) !== ownerPacienteId
      ) {
        return res.status(403).json({
          success: false,
          message: "No tienes permisos para ver este comprobante.",
        });
      }
    }

    return res.json({
      success: true,
      comprobante: {
        pagoid: normalizeText(row.pagoid),
        citaId: normalizeText(row.citaid),
        facturaId: normalizeText(row.facturaid),
        numeroFactura: normalizeText(row.numero_factura),
        monto: toMoney(row.monto, 0),
        moneda: normalizeText(row.moneda) || "DOP",
        metodoPago: normalizeText(row.metodo_pago),
        estado: normalizeText(row.estado),
        referencia: normalizeText(row.referencia_externa),
        detalle: row.detalle_json || {},
        createdAt: row.created_at || null,
        nota: "Comprobante de pago simulado. No representa transaccion bancaria real.",
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "No se pudo generar comprobante." });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
