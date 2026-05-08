const express = require("express");
const { randomUUID } = require("crypto");
const pool = require("../config/db");
const { requireAuth } = require("./middleware/auth");
const {
  MEDICO_ROLE_ID,
  PACIENTE_ROLE_ID,
  ACTIVE_CITA_CODES,
  normalizeText,
  normalizeComparableText,
  parsePositiveInt,
  clampInt,
  isValidIsoDate,
  normalizeModalidad,
  normalizeEstadoCode,
  parseDateInput,
  formatDateLabel,
  isClosedStatusCode,
  ensurePlatformSchema,
  ensureEstadoCatalog,
  resolveUserContext,
  resolveTipoConsultaId,
  resolveZonaHorariaId,
  resolveEspecialidad,
  validateModalidadForEspecialidad,
  hasCitaConflict,
  resolveMedicoUserIds,
  createNotification,
  appendCitaHistorial,
  ensureConversation,
  appendSystemMessage,
  ensureVideoSala,
  fetchCitaByIdForContext,
  buildCitaResponse,
  parseDateRangeFromQuery,
  parseBlockDates,
  buildSlots,
  canJoinVideoRoom,
} = require("../services/platform-core");
const { emitCitaEvent, emitConversationEvent } = require("../realtime/socket");
const {
  listMyCitas,
  getMyCitaDetail,
  createMyCita,
  cancelMyCita,
  rescheduleMyCita,
  updateMyCitaEstado,
} = require("../services/agenda-service");

const { generateLiveKitToken } = require("../services/livekit.service");

const router = express.Router();

const ROLE_BY_ID = {
  [PACIENTE_ROLE_ID]: "paciente",
  [MEDICO_ROLE_ID]: "medico",
};

function normalizeMessageType(value) {
  const type = normalizeComparableText(value);
  if (type === "texto" || type === "imagen" || type === "archivo" || type === "sistema") {
    return type;
  }
  return "texto";
}

async function fetchConversationForContext(client, { conversacionId, context, lock = false }) {
  const params = [String(conversacionId)];
  const where = ["conv.conversacionid::text = $1::text"];

  if (context.roleId === PACIENTE_ROLE_ID) {
    params.push(Number(context.paciente.pacienteid));
    where.push(`conv.pacienteid = $${params.length}`);
  } else if (context.roleId === MEDICO_ROLE_ID) {
    params.push(String(context.medico.medicoid));
    where.push(`conv.medicoid::text = $${params.length}::text`);
  } else {
    return null;
  }

  const result = await client.query(
    `SELECT
       conv.conversacionid::text AS conversacionid,
       conv.citaid_origen::text AS citaid_origen,
       conv.pacienteid::text AS pacienteid,
       conv.medicoid::text AS medicoid,
       conv.estado,
       conv.updated_at,
       p.usuarioid AS paciente_usuarioid,
       m.usuarioid AS medico_usuarioid,
       latest_cita.citaid::text AS latest_citaid,
       latest_cita.estado_codigo AS latest_estado_codigo
     FROM conversaciones conv
     LEFT JOIN paciente p ON p.pacienteid = conv.pacienteid
     LEFT JOIN medico m ON m.medicoid = conv.medicoid
     LEFT JOIN LATERAL (
       SELECT citaid, estado_codigo, fechahorainicio
       FROM cita
       WHERE pacienteid = conv.pacienteid
         AND medicoid::text = conv.medicoid::text
       ORDER BY fechahorainicio DESC NULLS LAST
       LIMIT 1
     ) latest_cita ON TRUE
     WHERE ${where.join(" AND ")}
     LIMIT 1
     ${lock ? "FOR UPDATE OF conv" : ""}`,
    params
  );

  return result.rows[0] || null;
}

async function pacienteHasCitaWithMedico(client, { pacienteId, medicoId }) {
  const result = await client.query(
    `SELECT 1
       FROM cita
      WHERE pacienteid = $1
        AND medicoid::text = $2::text
      LIMIT 1`,
    [Number(pacienteId), String(medicoId)]
  );
  return result.rows.length > 0;
}

// Schema is now initialized at startup in index.js

router.get("/catalogos/especialidades", requireAuth, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         e.especialidadid,
         e.nombre,
         e.permite_presencial,
         e.permite_virtual,
         COUNT(m.medicoid) FILTER (WHERE m.medicoid IS NOT NULL)::int AS total_medicos
       FROM especialidad e
       LEFT JOIN medico m ON m.especialidadid = e.especialidadid
       GROUP BY e.especialidadid, e.nombre, e.permite_presencial, e.permite_virtual
       ORDER BY lower(e.nombre) ASC`
    );
    return res.json({
      success: true,
      especialidades: result.rows.map((row) => ({
        especialidadid: Number(row.especialidadid),
        nombre: normalizeText(row.nombre),
        permitePresencial: Boolean(row.permite_presencial),
        permiteVirtual: Boolean(row.permite_virtual),
        totalMedicos: Number(row.total_medicos || 0),
      })),
    });
  } catch (err) {
    console.error("Error GET /agenda/catalogos/especialidades:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo listar el catalogo de especialidades.",
    });
  }
});

router.get("/disponibilidades", requireAuth, async (req, res) => {
  const medicoId = normalizeText(req.query?.medicoId);
  const especialidadId = parsePositiveInt(req.query?.especialidadId, null);
  const especialidad = normalizeText(req.query?.especialidad);
  const modalidad = normalizeModalidad(req.query?.modalidad, "");
  const fecha = normalizeText(req.query?.fecha);

  let client;
  try {
    client = await pool.connect();
    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }

    const especialidadRow = await resolveEspecialidad(client, {
      especialidadId,
      especialidad,
      medicoId,
    });
    
    if (especialidad && !especialidadRow) {
      console.log(`[GET disponibilidades] Specialty not found: "${especialidad}"`);
    }

    const modalidadValidation = validateModalidadForEspecialidad(
      especialidadRow,
      modalidad || "presencial"
    );
    if (modalidad && !modalidadValidation.ok) {
      return res.json({ success: true, slots: [], resumenPorMedico: [] });
    }

    const params = [];
    const where = ["h.activo = TRUE", "h.bloqueado = FALSE", "h.fechafin > NOW()"];

    if (medicoId) {
      params.push(medicoId);
      where.push(`h.medicoid::text = $${params.length}::text`);
    }

    if (especialidadRow?.especialidadid) {
      params.push(Number(especialidadRow.especialidadid));
      where.push(`COALESCE(h.especialidadid, m.especialidadid) = $${params.length}`);
    }

    if (fecha && isValidIsoDate(fecha)) {
      // NOTE: Using -04:00 to match the doctor's local time (Santo Domingo)
      params.push(`${fecha}T00:00:00.000-04:00`);
      params.push(`${fecha}T23:59:59.999-04:00`);
      where.push(`h.fechainicio <= $${params.length}::timestamptz`);
      where.push(`h.fechafin >= $${params.length - 1}::timestamptz`);
    }

    const availabilityResult = await client.query(
      `SELECT
         h.horariodisponibleid,
         h.medicoid::text AS medicoid,
         h.especialidadid,
         h.fechainicio,
         h.fechafin,
         h.modalidad,
         h.slot_minutos,
         COALESCE(m.nombrecompleto, 'Medico') AS medico_nombre,
         COALESCE(e.nombre, 'Medicina General') AS especialidad_nombre
       FROM horario_disponible h
       LEFT JOIN medico m ON m.medicoid = h.medicoid
       LEFT JOIN especialidad e ON e.especialidadid = COALESCE(h.especialidadid, m.especialidadid)
       WHERE ${where.join(" AND ")}
       ORDER BY h.fechainicio ASC
       LIMIT 600`,
      params
    );

    if (!availabilityResult.rows.length) {
      return res.json({ success: true, slots: [], resumenPorMedico: [] });
    }

    const rangeStart = availabilityResult.rows[0].fechainicio;
    const rangeEnd =
      availabilityResult.rows[availabilityResult.rows.length - 1].fechafin;

    const bookedParams = [rangeStart, rangeEnd];
    const bookedWhere = [
      "c.fechahorainicio < $2::timestamptz",
      "c.fechahorafin > $1::timestamptz",
      "lower(coalesce(c.estado_codigo, 'pendiente')) = ANY($3)",
    ];
    bookedParams.push(ACTIVE_CITA_CODES);

    if (medicoId) {
      bookedParams.push(medicoId);
      bookedWhere.push(`c.medicoid::text = $${bookedParams.length}::text`);
    }

    const bookedResult = await client.query(
      `SELECT c.medicoid::text AS medicoid, c.fechahorainicio, c.fechahorafin
       FROM cita c
       WHERE ${bookedWhere.join(" AND ")}`,
      bookedParams
    );

    // Si el usuario es un paciente, buscamos sus citas activas para no ofrecerle horarios donde el ya este ocupado
    let patientBookedRows = [];
    if (context.roleId === PACIENTE_ROLE_ID) {
      const pId = Number(context.paciente.pacienteid);
      const patientBusyResult = await client.query(
        `SELECT fechahorainicio, fechahorafin
         FROM cita
         WHERE pacienteid = $1
           AND fechahorainicio < $3::timestamptz
           AND fechahorafin > $2::timestamptz
           AND lower(coalesce(estado_codigo, 'pendiente')) = ANY($4)`,
        [pId, rangeStart, rangeEnd, ACTIVE_CITA_CODES]
      );
      patientBookedRows = patientBusyResult.rows;
    }

    const slots = buildSlots(availabilityResult.rows, bookedResult.rows, {
      modalidadFilter: modalidad,
      fechaFilter: fecha,
      patientBookedRows,
    });

    const resumenMap = new Map();
    for (const slot of slots) {
      const key = `${slot.medicoId}::${slot.especialidadId}`;
      if (!resumenMap.has(key)) {
        resumenMap.set(key, {
          medicoId: slot.medicoId,
          medicoNombre: slot.medicoNombre,
          especialidadId: slot.especialidadId,
          especialidad: slot.especialidad,
          totalSlots: 0,
          primerHorario: slot.horaInicio,
          ultimoHorario: slot.horaFin,
        });
      }
      const row = resumenMap.get(key);
      row.totalSlots += 1;
      if (new Date(slot.horaInicio) < new Date(row.primerHorario)) {
        row.primerHorario = slot.horaInicio;
      }
      if (new Date(slot.horaFin) > new Date(row.ultimoHorario)) {
        row.ultimoHorario = slot.horaFin;
      }
    }

    return res.json({
      success: true,
      filtros: {
        medicoId: medicoId || null,
        especialidadId: especialidadRow?.especialidadid || null,
        modalidad: modalidad || null,
        fecha: fecha || null,
      },
      slots,
      resumenPorMedico: [...resumenMap.values()],
    });
  } catch (err) {
    console.error("Error GET /agenda/disponibilidades:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo cargar la disponibilidad de medicos.",
    });
  } finally {
    if (client) client.release();
  }
});

router.get("/medico/me/disponibilidades", requireAuth, async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }
    if (context.roleId !== MEDICO_ROLE_ID) {
      return res.status(403).json({ success: false, message: "Solo medicos pueden acceder." });
    }

    const range = parseDateRangeFromQuery(req.query);
    const result = await client.query(
      `SELECT
         h.horariodisponibleid::text AS horariodisponibleid,
         h.medicoid::text AS medicoid,
         h.especialidadid,
         COALESCE(e.nombre, 'Medicina General') AS especialidad_nombre,
         h.zonahorariaid,
         h.fechainicio,
         h.fechafin,
         h.modalidad,
         h.slot_minutos,
         h.activo,
         h.bloqueado,
         h.nota,
         h.updated_at
       FROM horario_disponible h
       LEFT JOIN especialidad e ON e.especialidadid = h.especialidadid
       WHERE h.medicoid::text = $1::text
         AND h.fechafin >= $2::timestamptz
         AND h.fechainicio <= $3::timestamptz
       ORDER BY h.fechainicio ASC`,
      [String(context.medico.medicoid), range.fromIso, range.toIso]
    );

    return res.json({
      success: true,
      disponibilidades: result.rows.map((row) => ({
        id: String(row.horariodisponibleid || ""),
        medicoId: String(row.medicoid || ""),
        especialidadId: row.especialidadid ? Number(row.especialidadid) : null,
        especialidad: normalizeText(row.especialidad_nombre),
        zonaHorariaId: row.zonahorariaid ? Number(row.zonahorariaid) : null,
        fechaInicio: row.fechainicio || null,
        fechaFin: row.fechafin || null,
        modalidad: normalizeModalidad(row.modalidad, "ambas"),
        slotMinutos: Number(row.slot_minutos || 30),
        activo: Boolean(row.activo),
        bloqueado: Boolean(row.bloqueado),
        nota: normalizeText(row.nota),
        updatedAt: row.updated_at || null,
      })),
    });
  } catch (err) {
    console.error("Error GET /agenda/medico/me/disponibilidades:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo listar la disponibilidad del medico.",
    });
  } finally {
    if (client) client.release();
  }
});

router.post("/medico/me/disponibilidades", requireAuth, async (req, res) => {
  const modalidad = normalizeModalidad(req.body?.modalidad, "ambas");
  const slotMinutos = clampInt(req.body?.slotMinutos, 15, 60, 30);
  const nota = normalizeText(req.body?.nota).slice(0, 1200);
  const especialidadId = parsePositiveInt(req.body?.especialidadId, null);
  const bloqueado = Boolean(req.body?.bloqueado);
  const activo = req.body?.activo === undefined ? true : Boolean(req.body?.activo);
  const zoneIdRaw = parsePositiveInt(req.body?.zonaHorariaId, null);
  const { start, end } = parseBlockDates(req.body || {});

  if (!start || !end || end.getTime() <= start.getTime()) {
    return res.status(400).json({
      success: false,
      message:
        "Debes enviar un rango valido: fechaInicio/fechaFin o fecha + horaInicio/horaFin.",
    });
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
    if (context.roleId !== MEDICO_ROLE_ID) {
      await client.query("ROLLBACK");
      return res
        .status(403)
        .json({ success: false, message: "Solo medicos pueden crear disponibilidad." });
    }

    const especialidadRow = await resolveEspecialidad(client, {
      especialidadId: especialidadId || context.medico.especialidadid,
      medicoId: context.medico.medicoid,
    });
    if (!especialidadRow) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Especialidad no encontrada." });
    }

    const modeCheck = validateModalidadForEspecialidad(especialidadRow, modalidad);
    if (!modeCheck.ok) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, message: modeCheck.reason });
    }

    const zonaHorariaId = zoneIdRaw || (await resolveZonaHorariaId(client));
    console.log("[POST disponibilidades] INSERT params:", {
      medicoid: String(context.medico.medicoid),
      zonaHorariaId,
      start: start.toISOString(),
      end: end.toISOString(),
      activo,
      nota: nota || null,
      especialidadid: Number(especialidadRow.especialidadid),
      modalidad: modeCheck.modalidad,
      slotMinutos,
      bloqueado,
    });
    const insert = await client.query(
      `INSERT INTO horario_disponible (
         medicoid,
         zonahorariaid,
         fechainicio,
         fechafin,
         activo,
         nota,
         especialidadid,
         modalidad,
         slot_minutos,
         bloqueado,
         updated_at
       )
       VALUES ($1::uuid, $2, $3::timestamptz, $4::timestamptz, $5, $6, $7, $8, $9, $10, NOW())
       RETURNING
         horariodisponibleid::text AS horariodisponibleid,
         medicoid::text AS medicoid,
         zonahorariaid,
         fechainicio,
         fechafin,
         activo,
         nota,
         especialidadid,
         modalidad,
         slot_minutos,
         bloqueado,
         updated_at`,
      [
        String(context.medico.medicoid),
        zonaHorariaId,
        start.toISOString(),
        end.toISOString(),
        activo,
        nota || null,
        Number(especialidadRow.especialidadid),
        modeCheck.modalidad,
        slotMinutos,
        bloqueado,
      ]
    );

    await client.query("COMMIT");
    return res.status(201).json({ success: true, disponibilidad: insert.rows[0] });
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }
    console.error("Error POST /agenda/medico/me/disponibilidades:", err);
    console.error("[DB Detail]:", err?.detail);
    console.error("[DB Hint]:", err?.hint);
    console.error("[DB Code]:", err?.code);
    return res.status(500).json({
      success: false,
      message: "No se pudo crear la disponibilidad.",
      error: err?.message || String(err),
      detail: err?.detail || null,
      hint: err?.hint || null,
    });
  } finally {
    if (client) client.release();
  }
});

router.put("/medico/me/disponibilidades/:id", requireAuth, async (req, res) => {
  const disponibilidadId = parsePositiveInt(req.params?.id, null);
  if (!disponibilidadId) {
    return res.status(400).json({ success: false, message: "id de disponibilidad invalido." });
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
    if (context.roleId !== MEDICO_ROLE_ID) {
      await client.query("ROLLBACK");
      return res
        .status(403)
        .json({ success: false, message: "Solo medicos pueden editar disponibilidad." });
    }

    const existing = await client.query(
      `SELECT
         horariodisponibleid::text AS horariodisponibleid,
         medicoid::text AS medicoid,
         especialidadid,
         fechainicio,
         fechafin,
         modalidad,
         slot_minutos,
         activo,
         bloqueado,
         nota,
         zonahorariaid
       FROM horario_disponible
       WHERE horariodisponibleid = $1
         AND medicoid::text = $2::text
       LIMIT 1
       FOR UPDATE`,
      [disponibilidadId, String(context.medico.medicoid)]
    );

    if (!existing.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Disponibilidad no encontrada." });
    }

    const current = existing.rows[0];
    const parsedRange = parseBlockDates(req.body || {});
    const nextStart = parsedRange.start || new Date(current.fechainicio);
    const nextEnd = parsedRange.end || new Date(current.fechafin);
    if (
      !nextStart ||
      !nextEnd ||
      Number.isNaN(nextStart.getTime()) ||
      Number.isNaN(nextEnd.getTime()) ||
      nextEnd <= nextStart
    ) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "Rango de fechas invalido." });
    }

    const nextModalidad =
      req.body?.modalidad !== undefined
        ? normalizeModalidad(req.body?.modalidad, "ambas")
        : normalizeModalidad(current.modalidad, "ambas");
    const nextSlot = clampInt(
      req.body?.slotMinutos !== undefined ? req.body.slotMinutos : current.slot_minutos,
      15,
      60,
      30
    );
    const nextNota =
      req.body?.nota !== undefined
        ? normalizeText(req.body?.nota).slice(0, 1200)
        : normalizeText(current.nota);
    const nextActivo =
      req.body?.activo !== undefined ? Boolean(req.body.activo) : Boolean(current.activo);
    const nextBloqueado =
      req.body?.bloqueado !== undefined
        ? Boolean(req.body.bloqueado)
        : Boolean(current.bloqueado);
    const nextEspecialidadId = parsePositiveInt(
      req.body?.especialidadId !== undefined ? req.body.especialidadId : current.especialidadid,
      null
    );
    const nextZonaHorariaId = parsePositiveInt(
      req.body?.zonaHorariaId !== undefined ? req.body.zonaHorariaId : current.zonahorariaid,
      null
    );

    const especialidadRow = await resolveEspecialidad(client, {
      especialidadId: nextEspecialidadId,
      medicoId: context.medico.medicoid,
    });
    if (!especialidadRow) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Especialidad no encontrada." });
    }

    const modeCheck = validateModalidadForEspecialidad(especialidadRow, nextModalidad);
    if (!modeCheck.ok) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, message: modeCheck.reason });
    }

    const updated = await client.query(
      `UPDATE horario_disponible
       SET zonahorariaid = COALESCE($1, zonahorariaid),
           fechainicio = $2::timestamptz,
           fechafin = $3::timestamptz,
           activo = $4,
           nota = $5,
           especialidadid = $6,
           modalidad = $7,
           slot_minutos = $8,
           bloqueado = $9,
           updated_at = NOW()
       WHERE horariodisponibleid = $10
         AND medicoid::text = $11::text
       RETURNING
         horariodisponibleid::text AS horariodisponibleid,
         medicoid::text AS medicoid,
         zonahorariaid,
         fechainicio,
         fechafin,
         activo,
         nota,
         especialidadid,
         modalidad,
         slot_minutos,
         bloqueado,
         updated_at`,
      [
        nextZonaHorariaId,
        nextStart.toISOString(),
        nextEnd.toISOString(),
        nextActivo,
        nextNota || null,
        Number(especialidadRow.especialidadid),
        modeCheck.modalidad,
        nextSlot,
        nextBloqueado,
        disponibilidadId,
        String(context.medico.medicoid),
      ]
    );

    await client.query("COMMIT");
    return res.json({ success: true, disponibilidad: updated.rows[0] || null });
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }
    console.error("Error PUT /agenda/medico/me/disponibilidades/:id:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo actualizar la disponibilidad.",
    });
  } finally {
    if (client) client.release();
  }
});

router.patch("/medico/me/disponibilidades/:id/bloquear", requireAuth, async (req, res) => {
  const disponibilidadId = parsePositiveInt(req.params?.id, null);
  const bloqueado = req.body?.bloqueado === undefined ? true : Boolean(req.body.bloqueado);

  if (!disponibilidadId) {
    return res.status(400).json({ success: false, message: "id de disponibilidad invalido." });
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
    if (context.roleId !== MEDICO_ROLE_ID) {
      return res
        .status(403)
        .json({ success: false, message: "Solo medicos pueden bloquear disponibilidad." });
    }

    const result = await client.query(
      `UPDATE horario_disponible
       SET bloqueado = $1,
           updated_at = NOW()
       WHERE horariodisponibleid = $2
         AND medicoid::text = $3::text
       RETURNING horariodisponibleid::text AS horariodisponibleid, bloqueado, updated_at`,
      [bloqueado, disponibilidadId, String(context.medico.medicoid)]
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "Disponibilidad no encontrada." });
    }
    return res.json({ success: true, disponibilidad: result.rows[0] });
  } catch (err) {
    console.error("Error PATCH /agenda/medico/me/disponibilidades/:id/bloquear:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo actualizar el bloqueo de disponibilidad.",
    });
  } finally {
    if (client) client.release();
  }
});

router.post("/medico/me/disponibilidades/recurrente", requireAuth, async (req, res) => {
  const { pattern, modalidad, slotMinutos, daysCount = 30 } = req.body;
  console.log("[RECURRENTE] Generando con patron:", JSON.stringify(pattern));
  
  if (!Array.isArray(pattern) || pattern.length === 0) {
    return res.status(400).json({ success: false, message: "Debe enviar un patron de horarios valido." });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const context = await resolveUserContext(client, req.user);
    if (context.error || context.roleId !== MEDICO_ROLE_ID) {
      await client.query("ROLLBACK");
      return res.status(403).json({ success: false, message: "No autorizado." });
    }

    const medicoId = String(context.medico.medicoid);

    // CLEANUP: Delete unbooked slots for the next 30 days to prevent duplicates (the "8:00 loop")
    // We only delete slots that don't have a related appointment (cita)
    await client.query(
      `DELETE FROM horario_disponible 
       WHERE medicoid::text = $1::text 
         AND fechainicio >= NOW() 
         AND fechainicio <= NOW() + INTERVAL '31 days'
         AND horariodisponibleid NOT IN (SELECT horariodisponibleid FROM cita WHERE horariodisponibleid IS NOT NULL)`,
      [medicoId]
    );

    // Save the pattern for future use
    await client.query(
      `INSERT INTO medico_horario_recurrente (medicoid, pattern, modalidad, slot_minutos, updated_at)
       VALUES ($1::uuid, $2, $3, $4, NOW())
       ON CONFLICT (medicoid) DO UPDATE 
       SET pattern = $2, modalidad = $3, slot_minutos = $4, updated_at = NOW()`,
      [medicoId, JSON.stringify(pattern), modalidad, parseInt(slotMinutos, 10) || 30]
    );

    const especialidadRow = await resolveEspecialidad(client, {
      medicoId: context.medico.medicoid,
    });
    
    // Safety check: if no specialty found, we use a fallback or return error
    const especialidadId = especialidadRow ? Number(especialidadRow.especialidadid) : null;
    
    const zonaHorariaId = await resolveZonaHorariaId(client);
    
    const slotsCreated = [];
    const now = new Date();
    
    for (let i = 0; i < daysCount; i++) {
      const currentDay = new Date();
      currentDay.setDate(now.getDate() + i);
      const dayOfWeek = currentDay.getDay(); 
      
      const dayConfig = pattern.find(p => p.dayOfWeek === dayOfWeek);
      if (dayConfig) {
        // Generar fecha local YYYY-MM-DD para evitar desfases de toISOString()
        const year = currentDay.getFullYear();
        const month = String(currentDay.getMonth() + 1).padStart(2, '0');
        const day = String(currentDay.getDate()).padStart(2, '0');
        const dateStr = `${year}-${month}-${day}`;
        
        const start = new Date(`${dateStr}T${dayConfig.start}:00`);
        const end = new Date(`${dateStr}T${dayConfig.end}:00`);
        
        if (start < end && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
          const insert = await client.query(
            `INSERT INTO horario_disponible (
               medicoid, zonahorariaid, fechainicio, fechafin, activo, 
               especialidadid, modalidad, slot_minutos, bloqueado, updated_at
             )
             VALUES ($1::uuid, $2, $3::timestamptz, $4::timestamptz, TRUE, $5, $6, $7, FALSE, NOW())
             RETURNING horariodisponibleid`,
            [
              medicoId,
              zonaHorariaId,
              start.toISOString(),
              end.toISOString(),
              especialidadId, // Can be null if not found
              normalizeModalidad(modalidad || dayConfig.modalidad, "ambas"),
              clampInt(slotMinutos || dayConfig.slotMinutos, 15, 60, 30)
            ]
          );
          slotsCreated.push(insert.rows[0].horariodisponibleid);
        }
      }
    }

    await client.query("COMMIT");
    return res.status(201).json({ success: true, createdCount: slotsCreated.length });
  } catch (err) {
    if (client) await client.query("ROLLBACK");
    console.error("Error POST /agenda/medico/me/disponibilidades/recurrente:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Error generando disponibilidad recurrente.",
      error: err.message 
    });
  } finally {
    if (client) client.release();
  }
});

router.get("/medico/me/recurrente-config", requireAuth, async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    const context = await resolveUserContext(client, req.user);
    if (context.error || context.roleId !== MEDICO_ROLE_ID) {
      return res.status(403).json({ success: false, message: "No autorizado." });
    }

    const result = await client.query(
      `SELECT pattern, modalidad, slot_minutos AS "slotMinutos"
       FROM medico_horario_recurrente
       WHERE medicoid::text = $1::text`,
      [String(context.medico.medicoid)]
    );

    if (result.rows.length === 0) {
      return res.json({ success: true, config: null });
    }

    return res.json({ success: true, config: result.rows[0] });
  } catch (err) {
    console.error("Error GET /agenda/medico/me/recurrente-config:", err);
    return res.status(500).json({ success: false, message: "Error obteniendo configuración recurrente." });
  } finally {
    if (client) client.release();
  }
});

router.post("/medico/me/recurrente-config", requireAuth, async (req, res) => {
  const { pattern, modalidad, slotMinutos } = req.body;
  let client;
  try {
    client = await pool.connect();
    const context = await resolveUserContext(client, req.user);
    if (context.error || context.roleId !== MEDICO_ROLE_ID) {
      return res.status(403).json({ success: false, message: "No autorizado." });
    }

    await client.query(
      `INSERT INTO medico_horario_recurrente (medicoid, pattern, modalidad, slot_minutos, updated_at)
       VALUES ($1::uuid, $2, $3, $4, NOW())
       ON CONFLICT (medicoid) DO UPDATE 
       SET pattern = $2, modalidad = $3, slot_minutos = $4, updated_at = NOW()`,
      [String(context.medico.medicoid), JSON.stringify(pattern), modalidad, parseInt(slotMinutos, 10) || 30]
    );

    return res.json({ success: true, message: "Configuración guardada correctamente." });
  } catch (err) {
    console.error("Error POST /agenda/medico/me/recurrente-config:", err);
    return res.status(500).json({ success: false, message: "Error guardando configuración recurrente." });
  } finally {
    if (client) client.release();
  }
});

router.get("/me/citas", requireAuth, async (req, res) => {
  const result = await listMyCitas({
    reqUser: req.user,
    query: req.query,
    defaultLimit: 60,
    maxLimit: 200,
    allowedRoleIds: [PACIENTE_ROLE_ID, MEDICO_ROLE_ID],
    forbiddenRoleMessage: "Solo pacientes o medicos pueden listar citas.",
  });
  return res.status(result.status).json(result.body);
});

router.get("/me/citas/:citaId", requireAuth, async (req, res) => {
  const result = await getMyCitaDetail({
    reqUser: req.user,
    citaId: req.params?.citaId,
    allowedRoleIds: [PACIENTE_ROLE_ID, MEDICO_ROLE_ID],
    forbiddenRoleMessage: "Solo pacientes o medicos pueden consultar citas.",
  });
  return res.status(result.status).json(result.body);
});

router.post("/me/citas", requireAuth, async (req, res) => {
  const result = await createMyCita({
    reqUser: req.user,
    body: req.body,
    allowedRoleIds: [PACIENTE_ROLE_ID],
    forbiddenRoleMessage: "Solo pacientes pueden crear citas en este endpoint.",
  });
  return res.status(result.status).json(result.body);
});

router.patch("/me/citas/:citaId/cancelar", requireAuth, async (req, res) => {
  const result = await cancelMyCita({
    reqUser: req.user,
    citaId: req.params?.citaId,
    body: req.body,
    allowedRoleIds: [PACIENTE_ROLE_ID, MEDICO_ROLE_ID],
    forbiddenRoleMessage: "Solo pacientes o medicos pueden cancelar citas.",
  });
  return res.status(result.status).json(result.body);
});

router.patch("/me/citas/:citaId/reprogramar", requireAuth, async (req, res) => {
  const result = await rescheduleMyCita({
    reqUser: req.user,
    citaId: req.params?.citaId,
    body: req.body,
    allowedRoleIds: [PACIENTE_ROLE_ID, MEDICO_ROLE_ID],
    forbiddenRoleMessage: "Solo pacientes o medicos pueden reprogramar citas.",
  });
  return res.status(result.status).json(result.body);
});

router.patch("/me/citas/:citaId/estado", requireAuth, async (req, res) => {
  const result = await updateMyCitaEstado({
    reqUser: req.user,
    citaId: req.params?.citaId,
    body: req.body,
    allowedRoleIds: [MEDICO_ROLE_ID],
    forbiddenRoleMessage: "Solo medicos pueden actualizar estado de cita.",
  });
  return res.status(result.status).json(result.body);
});

router.post("/me/conversaciones", requireAuth, async (req, res) => {
  const targetMedicoId = normalizeText(req.body?.medicoId);
  const targetPacienteId = normalizeText(req.body?.pacienteId);

  let client;
  try {
    client = await pool.connect();
    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }

    let pacienteId = "";
    let medicoId = "";

    if (context.roleId === PACIENTE_ROLE_ID) {
      if (!targetMedicoId) {
        return res.status(400).json({ success: false, message: "medicoId es obligatorio." });
      }
      pacienteId = String(context.paciente.pacienteid);
      medicoId = targetMedicoId;

      const hasCita = await pacienteHasCitaWithMedico(client, { pacienteId, medicoId });
      if (!hasCita) {
        return res.status(403).json({
          success: false,
          message:
            "No puedes iniciar un chat con este medico hasta tener una consulta registrada.",
        });
      }
    } else if (context.roleId === MEDICO_ROLE_ID) {
      if (!targetPacienteId) {
        return res
          .status(400)
          .json({ success: false, message: "pacienteId es obligatorio." });
      }
      pacienteId = targetPacienteId;
      medicoId = String(context.medico.medicoid);

      const pacienteRow = await client.query(
        "SELECT pacienteid FROM paciente WHERE pacienteid = $1 LIMIT 1",
        [Number(pacienteId)]
      );
      if (!pacienteRow.rows.length) {
        return res
          .status(404)
          .json({ success: false, message: "Paciente no encontrado." });
      }
    } else {
      return res.status(403).json({
        success: false,
        message: "Solo pacientes o medicos pueden iniciar conversaciones.",
      });
    }

    const conversacionId = await ensureConversation(client, {
      citaId: null,
      pacienteId,
      medicoId,
    });

    return res.status(200).json({
      success: true,
      conversacion: {
        conversacionId,
        pacienteId: String(pacienteId),
        medicoId: String(medicoId),
      },
    });
  } catch (err) {
    console.error("Error POST /agenda/me/conversaciones:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo iniciar la conversacion.",
    });
  } finally {
    if (client) client.release();
  }
});

router.get("/me/conversaciones", requireAuth, async (req, res) => {
  const limit = clampInt(req.query?.limit, 1, 100, 40);

  let client;
  try {
    client = await pool.connect();
    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }

    const roleType = ROLE_BY_ID[context.roleId];
    if (!roleType) {
      return res.status(403).json({
        success: false,
        message: "Solo pacientes o medicos pueden listar conversaciones.",
      });
    }

    const params = [roleType];
    let where = "";
    if (context.roleId === PACIENTE_ROLE_ID) {
      params.push(Number(context.paciente.pacienteid));
      where = `conv.pacienteid = $${params.length}`;
    } else {
      params.push(String(context.medico.medicoid));
      where = `conv.medicoid::text = $${params.length}::text`;
    }
    params.push(limit);

    const result = await client.query(
      `SELECT
         conv.conversacionid::text AS conversacionid,
         conv.citaid_origen::text AS citaid_origen,
         conv.pacienteid::text AS pacienteid,
         conv.medicoid::text AS medicoid,
         conv.estado,
         conv.updated_at,
         latest_cita.citaid::text AS latest_citaid,
         latest_cita.fechahorainicio AS latest_fechahorainicio,
         latest_cita.modalidad AS latest_modalidad,
         latest_cita.estado_codigo AS latest_estado_codigo,
         COALESCE(m.nombrecompleto, 'Medico') AS medico_nombre,
         COALESCE(e.nombre, 'Medicina General') AS especialidad_nombre,
         COALESCE(
           NULLIF(TRIM(COALESCE(p.nombres, '') || ' ' || COALESCE(p.apellidos, '')), ''),
           'Paciente'
         ) AS paciente_nombre,
         latest_msg.mensajeid,
         latest_msg.contenido AS ultimo_contenido,
         latest_msg.tipo AS ultimo_tipo,
         latest_msg.created_at AS ultimo_created_at,
         latest_msg.emisor_tipo AS ultimo_emisor_tipo,
         unread.unread_count
       FROM conversaciones conv
       LEFT JOIN medico m ON m.medicoid = conv.medicoid
       LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
       LEFT JOIN paciente p ON p.pacienteid = conv.pacienteid
       LEFT JOIN LATERAL (
         SELECT citaid, fechahorainicio, modalidad, estado_codigo
         FROM cita
         WHERE pacienteid = conv.pacienteid
           AND medicoid::text = conv.medicoid::text
         ORDER BY fechahorainicio DESC NULLS LAST
         LIMIT 1
       ) latest_cita ON TRUE
       LEFT JOIN LATERAL (
         SELECT
           msg.mensajeid::text AS mensajeid,
           msg.contenido,
           msg.tipo,
           msg.created_at,
           msg.emisor_tipo
         FROM mensajes msg
         WHERE msg.conversacionid = conv.conversacionid
         ORDER BY msg.created_at DESC
         LIMIT 1
       ) latest_msg ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS unread_count
         FROM mensajes msg
         WHERE msg.conversacionid = conv.conversacionid
           AND msg.leido = FALSE
           AND lower(msg.emisor_tipo) <> $1
       ) unread ON TRUE
       WHERE ${where}
       ORDER BY conv.updated_at DESC
       LIMIT $${params.length}`,
      params
    );

    return res.json({
      success: true,
      conversaciones: result.rows.map((row) => ({
        conversacionId: normalizeText(row.conversacionid),
        citaId: normalizeText(row.latest_citaid),
        citaIdOrigen: normalizeText(row.citaid_origen),
        estado: normalizeText(row.estado) || "activa",
        updatedAt: row.updated_at || null,
        unreadCount: Number(row.unread_count || 0),
        cita: row.latest_citaid
          ? {
              citaId: normalizeText(row.latest_citaid),
              fechaHoraInicio: row.latest_fechahorainicio || null,
              modalidad: normalizeModalidad(row.latest_modalidad, "presencial"),
              estadoCodigo: normalizeEstadoCode(row.latest_estado_codigo, "pendiente"),
            }
          : null,
        paciente: {
          pacienteid: normalizeText(row.pacienteid),
          nombreCompleto: normalizeText(row.paciente_nombre) || "Paciente",
        },
        medico: {
          medicoid: normalizeText(row.medicoid),
          nombreCompleto: normalizeText(row.medico_nombre) || "Medico",
          especialidad: normalizeText(row.especialidad_nombre) || "Medicina General",
        },
        ultimoMensaje: row.mensajeid
          ? {
              mensajeId: normalizeText(row.mensajeid),
              contenido: normalizeText(row.ultimo_contenido),
              tipo: normalizeMessageType(row.ultimo_tipo),
              emisorTipo: normalizeText(row.ultimo_emisor_tipo),
              createdAt: row.ultimo_created_at || null,
            }
          : null,
      })),
    });
  } catch (err) {
    console.error("Error GET /agenda/me/conversaciones:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudieron listar las conversaciones.",
    });
  } finally {
    if (client) client.release();
  }
});

router.get("/me/conversaciones/:conversacionId/mensajes", requireAuth, async (req, res) => {
  const conversacionId = normalizeText(req.params?.conversacionId);
  const before = parseDateInput(req.query?.before);
  const limit = clampInt(req.query?.limit, 1, 200, 80);

  if (!conversacionId) {
    return res.status(400).json({ success: false, message: "conversacionId es obligatorio." });
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

    const conversation = await fetchConversationForContext(client, {
      conversacionId,
      context,
    });
    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversacion no encontrada." });
    }

    const params = [conversacionId, before ? before.toISOString() : null, limit];
    const result = await client.query(
      `SELECT
         m.mensajeid::text AS mensajeid,
         m.emisor_tipo,
         m.emisor_id,
         m.contenido,
         m.tipo,
         m.leido,
         m.leido_at,
         m.meta_json,
         m.created_at
       FROM mensajes m
       WHERE m.conversacionid::text = $1::text
         AND ($2::timestamptz IS NULL OR m.created_at < $2::timestamptz)
       ORDER BY m.created_at DESC
       LIMIT $3`,
      params
    );

    const messages = result.rows
      .map((row) => ({
        mensajeId: normalizeText(row.mensajeid),
        emisorTipo: normalizeText(row.emisor_tipo),
        emisorId: normalizeText(row.emisor_id),
        contenido: normalizeText(row.contenido),
        tipo: normalizeMessageType(row.tipo),
        leido: Boolean(row.leido),
        leidoAt: row.leido_at || null,
        meta: row.meta_json || {},
        createdAt: row.created_at || null,
      }))
      .reverse();

    return res.json({
      success: true,
      conversacion: {
        conversacionId: normalizeText(conversation.conversacionid),
        citaId: normalizeText(conversation.latest_citaid),
        citaIdOrigen: normalizeText(conversation.citaid_origen),
        pacienteId: normalizeText(conversation.pacienteid),
        medicoId: normalizeText(conversation.medicoid),
      },
      mensajes: messages,
    });
  } catch (err) {
    console.error("Error GET /agenda/me/conversaciones/:id/mensajes:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudieron cargar los mensajes.",
    });
  } finally {
    if (client) client.release();
  }
});

router.post("/me/conversaciones/:conversacionId/mensajes", requireAuth, async (req, res) => {
  const conversacionId = normalizeText(req.params?.conversacionId);
  const contenido = normalizeText(req.body?.contenido).slice(0, 4000);
  const tipo = normalizeMessageType(req.body?.tipo);
  const meta = req.body?.meta && typeof req.body.meta === "object" ? req.body.meta : {};

  if (!conversacionId) {
    return res.status(400).json({ success: false, message: "conversacionId es obligatorio." });
  }
  if (!contenido) {
    return res.status(400).json({ success: false, message: "contenido es obligatorio." });
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

    const senderType = ROLE_BY_ID[context.roleId];
    if (!senderType) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "Solo pacientes o medicos pueden enviar mensajes.",
      });
    }

    const conversation = await fetchConversationForContext(client, {
      conversacionId,
      context,
      lock: true,
    });
    if (!conversation) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Conversacion no encontrada." });
    }

    if (normalizeComparableText(conversation.estado) === "cerrada") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "La conversacion esta cerrada.",
      });
    }

    if (senderType === "paciente") {
      const hasCita = await pacienteHasCitaWithMedico(client, {
        pacienteId: conversation.pacienteid,
        medicoId: conversation.medicoid,
      });
      if (!hasCita) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          success: false,
          message:
            "No puedes enviar mensajes a este medico hasta tener una consulta registrada.",
        });
      }
    }

    const insert = await client.query(
      `INSERT INTO mensajes (
         mensajeid,
         conversacionid,
         emisor_tipo,
         emisor_id,
         contenido,
         tipo,
         leido,
         meta_json,
         created_at
       )
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, FALSE, $7::jsonb, NOW())
       RETURNING
         mensajeid::text AS mensajeid,
         conversacionid::text AS conversacionid,
         emisor_tipo,
         emisor_id,
         contenido,
         tipo,
         leido,
         leido_at,
         meta_json,
         created_at`,
      [
        randomUUID(),
        conversacionId,
        senderType,
        normalizeText(context.user.usuarioid),
        contenido,
        tipo,
        JSON.stringify(meta || {}),
      ]
    );

    await client.query(
      `UPDATE conversaciones
       SET updated_at = NOW()
       WHERE conversacionid::text = $1::text`,
      [conversacionId]
    );

    const row = insert.rows[0] || {};
    const messagePayload = {
      mensajeId: normalizeText(row.mensajeid),
      conversacionId: normalizeText(row.conversacionid),
      emisorTipo: normalizeText(row.emisor_tipo),
      emisorId: normalizeText(row.emisor_id),
      contenido: normalizeText(row.contenido),
      tipo: normalizeMessageType(row.tipo),
      leido: Boolean(row.leido),
      leidoAt: row.leido_at || null,
      meta: row.meta_json || {},
      createdAt: row.created_at || null,
    };

    if (senderType === "paciente") {
      const doctorUserIds = await resolveMedicoUserIds(client, conversation.medicoid);
      for (const doctorUserId of doctorUserIds) {
        await createNotification(client, {
          usuarioid: doctorUserId,
          tipo: "mensaje_nuevo",
          titulo: "Nuevo mensaje del paciente",
          contenido,
          data: {
            conversacionId,
            citaId: conversation.latest_citaid || null,
            pacienteId: conversation.pacienteid,
            medicoId: conversation.medicoid,
          },
        });
      }
    } else {
      await createNotification(client, {
        usuarioid: Number(conversation.paciente_usuarioid),
        tipo: "mensaje_nuevo",
        titulo: "Nuevo mensaje del medico",
        contenido,
        data: {
          conversacionId,
          citaId: conversation.latest_citaid || null,
          pacienteId: conversation.pacienteid,
          medicoId: conversation.medicoid,
        },
      });
    }

    await client.query("COMMIT");

    emitConversationEvent({
      eventName: "mensaje_nuevo",
      conversacionId,
      citaId: conversation.latest_citaid || null,
      pacienteId: conversation.pacienteid,
      medicoId: conversation.medicoid,
      extraPayload: { mensaje: messagePayload },
    });

    return res.status(201).json({
      success: true,
      mensaje: messagePayload,
    });
  } catch (err) {
    console.error("Error POST /me/conversaciones/:conversacionId/mensajes:", err);
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }
    return res.status(500).json({
      success: false,
      message: "No se pudo enviar el mensaje.",
    });
  } finally {
    if (client) client.release();
  }
});

router.patch("/me/conversaciones/:conversacionId/leido", requireAuth, async (req, res) => {
  const conversacionId = normalizeText(req.params?.conversacionId);
  if (!conversacionId) {
    return res.status(400).json({ success: false, message: "conversacionId es obligatorio." });
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

    const roleType = ROLE_BY_ID[context.roleId];
    if (!roleType) {
      return res.status(403).json({
        success: false,
        message: "Solo pacientes o medicos pueden marcar mensajes.",
      });
    }

    const conversation = await fetchConversationForContext(client, {
      conversacionId,
      context,
    });
    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversacion no encontrada." });
    }

    const update = await client.query(
      `UPDATE mensajes
       SET leido = TRUE,
           leido_at = NOW()
       WHERE conversacionid::text = $1::text
         AND leido = FALSE
         AND lower(emisor_tipo) <> $2
       RETURNING mensajeid::text AS mensajeid`,
      [conversacionId, roleType]
    );

    return res.json({
      success: true,
      marcados: Number(update.rowCount || 0),
    });
  } catch (err) {
    console.error("Error PATCH /agenda/me/conversaciones/:id/leido:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo marcar como leido.",
    });
  } finally {
    if (client) client.release();
  }
});

router.get("/me/citas/:citaId/video-sala", requireAuth, async (req, res) => {
  const citaId = normalizeText(req.params?.citaId);
  if (!citaId) {
    return res.status(400).json({ success: false, message: "citaId es obligatorio." });
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

    const cita = await fetchCitaByIdForContext(client, { citaId, context });
    if (!cita) {
      return res.status(404).json({ success: false, message: "Cita no encontrada." });
    }
    if (normalizeModalidad(cita.modalidad, "presencial") !== "virtual") {
      return res.status(409).json({
        success: false,
        message: "Esta cita no es virtual.",
      });
    }

    const sala = await ensureVideoSala(client, { citaId, provider: "jitsi" });
    const canJoin = canJoinVideoRoom({
      citaStart: cita.fechahorainicio,
      roomEstado: sala?.estado,
      roleId: context.roleId,
    });

    const roomId = `appt-${String(citaId).replace(/[^a-zA-Z0-9-]/g, "")}`;
    const displayName = context.roleId === MEDICO_ROLE_ID 
      ? context.medico.nombrecompleto 
      : `${context.paciente.nombres} ${context.paciente.apellidos}`;

    return res.json({
      success: true,
      videoSala: sala
        ? {
            videoSalaId: normalizeText(sala.videosalaid),
            proveedor: "jitsi",
            roomName: roomId,
            joinUrl: roomId, 
            token: null,
            estado: normalizeText(sala.estado) || "pendiente",
            openedAt: sala.opened_at || null,
            closedAt: sala.closed_at || null,
            canJoin,
            jitsiConfig: {
              domain: process.env.JITSI_DOMAIN || "meet.jit.si",
              roomName: roomId,
              displayName,
            }
          }
        : null,
    });
  } catch (err) {
    console.error("Error GET /agenda/me/citas/:id/video-sala:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo obtener la sala de video.",
    });
  } finally {
    if (client) client.release();
  }
});

router.post("/me/citas/:citaId/video-sala/abrir", requireAuth, async (req, res) => {
  const citaId = normalizeText(req.params?.citaId);
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
    if (context.roleId !== MEDICO_ROLE_ID) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "Solo medicos pueden abrir la sala.",
      });
    }

    const cita = await fetchCitaByIdForContext(client, { citaId, context, lock: true });
    if (!cita) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Cita no encontrada." });
    }
    if (normalizeModalidad(cita.modalidad, "presencial") !== "virtual") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Esta cita no es virtual.",
      });
    }

    const salaResult = await ensureVideoSala(client, { citaId, provider: "livekit" });
    const updateSala = await client.query(
      `UPDATE video_salas
       SET estado = 'abierta',
           opened_at = COALESCE(opened_at, NOW())
       WHERE citaid::text = $1::text
       RETURNING
         videosalaid::text AS videosalaid,
         proveedor,
         room_name,
         token_o_url,
         estado,
         opened_at,
         closed_at`,
      [citaId]
    );

    const sala = updateSala.rows[0] || null;
    const roomId = `appt-${String(citaId).replace(/[^a-zA-Z0-9-]/g, "")}`;
    
    const doctorCanJoin = canJoinVideoRoom({
      citaStart: cita.fechahorainicio,
      roomEstado: sala?.estado,
      roleId: context.roleId,
    });
    const patientCanJoin = canJoinVideoRoom({
      citaStart: cita.fechahorainicio,
      roomEstado: sala?.estado,
      roleId: PACIENTE_ROLE_ID,
    });

    const conversacionId = await ensureConversation(client, {
      citaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
    });
    const systemText = "El medico inició la videollamada.";
    await appendSystemMessage(client, { conversacionId, text: systemText });

    await createNotification(client, {
      usuarioid: Number(cita.pacienteid),
      tipo: "videollamada_disponible",
      titulo: "Videollamada disponible",
      contenido: "Tu medico ya inició la sala de consulta virtual.",
      data: { citaId, pacienteId: cita.pacienteid, medicoId: cita.medicoid },
    });

    await client.query("COMMIT");

    emitCitaEvent({
      eventName: "cita_actualizada",
      citaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
      extraPayload: {
        videoSala: sala
          ? {
              videoSalaId: normalizeText(sala.videosalaid),
              estado: normalizeText(sala.estado),
              roomName: roomId,
              canJoin: patientCanJoin,
              jitsiConfig: {
                domain: process.env.JITSI_DOMAIN || "meet.jit.si",
                roomName: roomId,
                displayName: cita.paciente_nombre,
              }
            }
          : null,
      },
    });

    emitConversationEvent({
      eventName: "mensaje_nuevo",
      conversacionId,
      citaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
      extraPayload: {
        system: true,
        contenido: systemText,
      },
    });

    return res.json({
      success: true,
      videoSala: sala
        ? {
            videoSalaId: normalizeText(sala.videosalaid),
            proveedor: "jitsi",
            roomName: roomId,
            estado: normalizeText(sala.estado),
            openedAt: sala.opened_at || null,
            closedAt: sala.closed_at || null,
            canJoin: doctorCanJoin,
            jitsiConfig: {
              domain: process.env.JITSI_DOMAIN || "meet.jit.si",
              roomName: roomId,
              displayName: context.medico.nombrecompleto,
            }
          }
        : null,
    });
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }
    console.error("Error POST /agenda/me/citas/:id/video-sala/abrir:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo abrir la videollamada.",
    });
  } finally {
    if (client) client.release();
  }
});

router.post("/me/citas/:citaId/video-sala/finalizar", requireAuth, async (req, res) => {
  const citaId = normalizeText(req.params?.citaId);
  const completarCita = Boolean(req.body?.completarCita);

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
    if (context.roleId !== MEDICO_ROLE_ID) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "Solo medicos pueden finalizar la sala.",
      });
    }

    const cita = await fetchCitaByIdForContext(client, { citaId, context, lock: true });
    if (!cita) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Cita no encontrada." });
    }

    await ensureVideoSala(client, { citaId, provider: "jitsi" });
    const updateSala = await client.query(
      `UPDATE video_salas
       SET estado = 'finalizada',
           closed_at = NOW()
       WHERE citaid::text = $1::text
       RETURNING
         videosalaid::text AS videosalaid,
         proveedor,
         room_name,
         token_o_url,
         estado,
         opened_at,
         closed_at`,
      [citaId]
    );
    const sala = updateSala.rows[0] || null;

    if (completarCita) {
      const estadoMap = await ensureEstadoCatalog(client);
      if (estadoMap.completada) {
        await client.query(
          `UPDATE cita
           SET estadocitaid = $1,
               estado_codigo = 'completada',
               updated_at = NOW()
           WHERE citaid::text = $2::text`,
          [estadoMap.completada, citaId]
        );

        await appendCitaHistorial(client, {
          citaId,
          accion: "completada",
          usuarioTipo: "medico",
          usuarioId: context.user.usuarioid,
          motivo: "Consulta virtual finalizada.",
          datos: { salaFinalizada: true },
        });
      }
    }

    const conversacionId = await ensureConversation(client, {
      citaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
    });
    const systemText = "La videollamada fue finalizada.";
    await appendSystemMessage(client, { conversacionId, text: systemText });

    await createNotification(client, {
      usuarioid: Number(cita.pacienteid),
      tipo: "cita_actualizada",
      titulo: "Videollamada finalizada",
      contenido: completarCita
        ? "La consulta virtual terminó y la cita fue marcada como completada."
        : "La videollamada finalizó.",
      data: {
        citaId,
        pacienteId: cita.pacienteid,
        medicoId: cita.medicoid,
        completarCita,
      },
    });

    const updatedCita = await fetchCitaByIdForContext(client, { citaId, context });
    const citaPayload = buildCitaResponse(updatedCita);

    await client.query("COMMIT");

    emitCitaEvent({
      eventName: "cita_actualizada",
      citaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
      extraPayload: {
        cita: citaPayload,
        videoSala: sala
          ? {
              videoSalaId: normalizeText(sala.videosalaid),
              estado: normalizeText(sala.estado),
              joinUrl: normalizeText(sala.token_o_url),
              canJoin: false,
            }
          : null,
      },
    });
    emitConversationEvent({
      eventName: "mensaje_nuevo",
      conversacionId,
      citaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
      extraPayload: {
        system: true,
        contenido: systemText,
      },
    });

    return res.json({
      success: true,
      cita: citaPayload,
      videoSala: sala
        ? {
            videoSalaId: normalizeText(sala.videosalaid),
            proveedor: normalizeText(sala.proveedor),
            roomName: normalizeText(sala.room_name),
            joinUrl: normalizeText(sala.token_o_url),
            estado: normalizeText(sala.estado),
            openedAt: sala.opened_at || null,
            closedAt: sala.closed_at || null,
            canJoin: false,
          }
        : null,
    });
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }
    console.error("Error POST /agenda/me/citas/:id/video-sala/finalizar:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo finalizar la videollamada.",
    });
  } finally {
    if (client) client.release();
  }
});

router.get("/me/notificaciones", requireAuth, async (req, res) => {
  const limit = clampInt(req.query?.limit, 1, 200, 80);
  const unreadOnly = String(req.query?.soloNoLeidas || req.query?.unreadOnly || "")
    .trim()
    .toLowerCase();
  const onlyUnread = unreadOnly === "1" || unreadOnly === "true";

  let client;
  try {
    client = await pool.connect();
    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }

    const result = await client.query(
      `SELECT
         n.notificacionid::text AS notificacionid,
         n.tipo,
         n.titulo,
         n.contenido,
         n.data_json,
         n.leida,
         n.created_at,
         n.read_at
       FROM notificaciones n
       WHERE n.usuarioid = $1
         AND ($2::boolean = FALSE OR n.leida = FALSE)
         AND n.created_at >= NOW() - INTERVAL '7 days'
       ORDER BY n.created_at DESC
       LIMIT $3`,
      [Number(context.user.usuarioid), onlyUnread, limit]
    );

    return res.json({
      success: true,
      notificaciones: result.rows.map((row) => ({
        id: normalizeText(row.notificacionid),
        tipo: normalizeText(row.tipo) || "general",
        titulo: normalizeText(row.titulo),
        contenido: normalizeText(row.contenido),
        data: row.data_json || {},
        leida: Boolean(row.leida),
        createdAt: row.created_at || null,
        readAt: row.read_at || null,
      })),
    });
  } catch (err) {
    console.error("Error GET /agenda/me/notificaciones:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudieron listar notificaciones.",
    });
  } finally {
    if (client) client.release();
  }
});

router.patch("/me/notificaciones/:id/leida", requireAuth, async (req, res) => {
  const notificationId = parsePositiveInt(req.params?.id, null);
  if (!notificationId) {
    return res.status(400).json({ success: false, message: "id invalido." });
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

    const updated = await client.query(
      `UPDATE notificaciones
       SET leida = TRUE,
           read_at = COALESCE(read_at, NOW())
       WHERE notificacionid = $1
         AND usuarioid = $2
       RETURNING notificacionid::text AS notificacionid, leida, read_at`,
      [notificationId, Number(context.user.usuarioid)]
    );
    if (!updated.rows.length) {
      return res.status(404).json({ success: false, message: "Notificacion no encontrada." });
    }
    return res.json({
      success: true,
      notificacion: {
        id: normalizeText(updated.rows[0].notificacionid),
        leida: Boolean(updated.rows[0].leida),
        readAt: updated.rows[0].read_at || null,
      },
    });
  } catch (err) {
    console.error("Error PATCH /agenda/me/notificaciones/:id/leida:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo actualizar la notificacion.",
    });
  } finally {
    if (client) client.release();
  }
});

router.patch("/me/notificaciones/leer-todas", requireAuth, async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }

    const updated = await client.query(
      `UPDATE notificaciones
       SET leida = TRUE,
           read_at = COALESCE(read_at, NOW())
       WHERE usuarioid = $1
         AND leida = FALSE`,
      [Number(context.user.usuarioid)]
    );

    return res.json({
      success: true,
      marcadas: Number(updated.rowCount || 0),
    });
  } catch (err) {
    console.error("Error PATCH /agenda/me/notificaciones/leer-todas:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudieron marcar las notificaciones.",
    });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
