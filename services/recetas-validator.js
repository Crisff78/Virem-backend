'use strict';

const { normalizeText, parsePositiveInt } = require('./platform-core');

// Whitelist de texto medico (espanol):
//  - letras Unicode (incluye acentos y enie)
//  - digitos
//  - espacios y saltos de linea
//  - signos basicos: . , - / : ; ( )
const MEDICAL_TEXT_RE = /^[\p{L}\p{N}\s.,\-/:;()]*$/u;
const MEDICAL_TEXT_NO_NEWLINE_RE = /^[\p{L}\p{N} .,\-/:;()]*$/u;

// Identificador (nombre o cedula): letras, digitos, espacios, punto, guion
const IDENTIFIER_RE = /^[\p{L}\p{N}\s.\-]*$/u;

// UUID v4-ish (acepta cualquier UUID con formato canonico)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Valores de signos vitales: digitos, letras, espacios, punto, slash, grado, guion
const SIGNOS_VALUE_RE = /^[\p{L}\p{N}\s.\-/°]*$/u;

// Unidades de dosis aceptadas (whitelist explicita).
// Permite punto final opcional para abreviaturas (ej: "1 caps.").
const DOSIS_RE = /^\d+([.,]\d+)?\s*(mg|mcg|ug|µg|g|kg|ml|cc|l|caps?|capsulas?|cápsulas?|comp|comprimidos?|tab|tabletas?|gotas?|gts|ui|cda|cdas|cdita|cditas|cucharadas?|cucharaditas?|aplicaciones?|unidades?|sobres?|amp|ampollas?|inhalaciones?|puffs?)\.?$/i;

// Frecuencia: whitelist medico simple. No exige formato estricto porque varia mucho
// (c/8h, BID, TID, "cada 12 horas", "1 vez al dia"), pero limita charset y tamanio.
const FRECUENCIA_RE = /^[\p{L}\p{N} .,\-/:;()]{1,100}$/u;

// Duracion: numero + unidad temporal, con punto final opcional.
const DURACION_RE = /^\d{1,3}\s*(d|dia|días|dias|h|hora|horas|sem|semana|semanas|m|mes|meses|indefinido|permanente)\.?$/i;

// Caracteres explicitamente prohibidos (para mensaje de error claro)
const BANNED_CHARS_RE = /[<>{}[\]$%&*=|\\`'"]/g;

// Claves permitidas en signos_vitales_json (formato camelCase, snake_case y abreviado)
const ALLOWED_SIGNOS_KEYS = new Set([
  'presionArterial', 'presion_arterial', 'pa',
  'frecuenciaCardiaca', 'frecuencia_cardiaca', 'fc',
  'frecuenciaRespiratoria', 'frecuencia_respiratoria', 'fr',
  'temperatura', 't', 'temp',
  'saturacion', 'saturacionO2', 'spo2', 'sat',
  'peso', 'talla', 'imc',
  'glicemia', 'glucosa',
  'observaciones', 'notas',
]);

// Claves permitidas en doctor_info_json
const ALLOWED_DOCTOR_KEYS = new Set(['nombre', 'especialidad', 'firma']);

function listBannedChars(value) {
  const matches = String(value).match(BANNED_CHARS_RE);
  if (!matches) return [];
  return [...new Set(matches)];
}

function validateMedicalText(value, options = {}) {
  const {
    maxLen = 5000,
    fieldName = 'campo',
    allowNewlines = true,
    optional = true,
  } = options;

  const cleaned = normalizeText(value);

  if (!cleaned) {
    if (optional) return { ok: true, value: '' };
    return { ok: false, error: `${fieldName} es obligatorio.` };
  }
  if (cleaned.length > maxLen) {
    return { ok: false, error: `${fieldName} excede el largo maximo (${maxLen}).` };
  }

  const re = allowNewlines ? MEDICAL_TEXT_RE : MEDICAL_TEXT_NO_NEWLINE_RE;
  if (!re.test(cleaned)) {
    const banned = listBannedChars(cleaned);
    const detalle = banned.length
      ? ` Caracteres no permitidos detectados: ${banned.join(' ')}`
      : '';
    return {
      ok: false,
      error: `${fieldName} contiene caracteres no permitidos.${detalle}`,
    };
  }

  return { ok: true, value: cleaned };
}

function validateIdentifierText(value, options = {}) {
  const { maxLen = 100, fieldName = 'identificador' } = options;
  const cleaned = normalizeText(value);
  if (!cleaned) return { ok: true, value: '' };
  if (cleaned.length > maxLen) {
    return { ok: false, error: `${fieldName} excede el largo maximo.` };
  }
  if (!IDENTIFIER_RE.test(cleaned)) {
    return { ok: false, error: `${fieldName} contiene caracteres no permitidos.` };
  }
  return { ok: true, value: cleaned };
}

function validateUuid(value, fieldName = 'uuid') {
  const cleaned = normalizeText(value);
  if (!cleaned) return { ok: false, error: `${fieldName} vacio.` };
  if (!UUID_RE.test(cleaned)) {
    return { ok: false, error: `${fieldName} con formato invalido.` };
  }
  return { ok: true, value: cleaned.toLowerCase() };
}

function validateMedicamento(item, idx) {
  const label = `medicamento #${idx + 1}`;

  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return { ok: false, error: `${label} debe ser un objeto.` };
  }

  const nombreRes = validateMedicalText(item.nombre, {
    maxLen: 200,
    fieldName: `${label} (nombre)`,
    allowNewlines: false,
    optional: false,
  });
  if (!nombreRes.ok) return nombreRes;

  const dosisCleaned = normalizeText(item.dosis);
  if (!dosisCleaned) {
    return { ok: false, error: `${label}: dosis es obligatoria.` };
  }
  if (dosisCleaned.length > 50) {
    return { ok: false, error: `${label}: dosis excede el largo maximo.` };
  }
  if (!DOSIS_RE.test(dosisCleaned)) {
    return {
      ok: false,
      error: `${label}: dosis con formato invalido (ej: 500 mg, 10 ml, 1 caps).`,
    };
  }

  // frecuencia: opcional. Si viene, valida charset y largo.
  const frecCleaned = normalizeText(item.frecuencia);
  if (frecCleaned && !FRECUENCIA_RE.test(frecCleaned)) {
    const banned = listBannedChars(frecCleaned);
    const detalle = banned.length
      ? ` Caracteres no permitidos: ${banned.join(' ')}`
      : '';
    return {
      ok: false,
      error: `${label}: frecuencia con formato invalido (ej: c/8h, cada 12 horas).${detalle}`,
    };
  }

  // duracion: opcional. Si viene, valida formato numero+unidad.
  const dur = normalizeText(item.duracion);
  if (dur && !DURACION_RE.test(dur)) {
    return {
      ok: false,
      error: `${label}: duracion con formato invalido (ej: 7 dias, 2 semanas).`,
    };
  }

  return {
    ok: true,
    value: {
      nombre: nombreRes.value,
      dosis: dosisCleaned,
      frecuencia: frecCleaned,
      duracion: dur,
    },
  };
}

function validateMedicamentos(arr) {
  if (!Array.isArray(arr)) {
    return { ok: false, error: 'El listado de medicamentos debe ser un arreglo.' };
  }
  if (arr.length === 0) {
    return { ok: false, error: 'Debe incluir al menos un medicamento.' };
  }
  if (arr.length > 30) {
    return {
      ok: false,
      error: 'Demasiados medicamentos en una sola receta (maximo 30).',
    };
  }

  const cleaned = [];
  for (let i = 0; i < arr.length; i++) {
    const r = validateMedicamento(arr[i], i);
    if (!r.ok) return r;
    cleaned.push(r.value);
  }
  return { ok: true, value: cleaned };
}

function validateSignosVitales(obj) {
  if (obj === null || typeof obj === 'undefined' || obj === '') {
    return { ok: true, value: {} };
  }
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: 'signos_vitales debe ser un objeto.' };
  }

  const cleaned = {};
  for (const [rawKey, rawVal] of Object.entries(obj)) {
    const key = String(rawKey || '').trim();
    if (!ALLOWED_SIGNOS_KEYS.has(key)) {
      // Ignoramos claves desconocidas en lugar de rechazar la receta entera.
      // Esto previene inyeccion de campos extranos sin romper el flujo.
      continue;
    }
    if (rawVal === null || typeof rawVal === 'undefined' || rawVal === '') continue;

    let valStr;
    if (typeof rawVal === 'number' && Number.isFinite(rawVal)) {
      valStr = String(rawVal);
    } else if (typeof rawVal === 'string') {
      valStr = rawVal.trim();
    } else if (typeof rawVal === 'boolean') {
      valStr = rawVal ? 'si' : 'no';
    } else {
      return { ok: false, error: `signos_vitales.${key} tipo invalido.` };
    }

    if (valStr.length > 50) {
      return { ok: false, error: `signos_vitales.${key} excede el largo maximo.` };
    }
    if (!SIGNOS_VALUE_RE.test(valStr)) {
      return {
        ok: false,
        error: `signos_vitales.${key} contiene caracteres no permitidos.`,
      };
    }
    cleaned[key] = valStr;
  }
  return { ok: true, value: cleaned };
}

function validateDoctorInfo(obj) {
  const safe =
    obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};

  const cleaned = { nombre: '', especialidad: '', firma: 'Firma Digital' };

  for (const key of ALLOWED_DOCTOR_KEYS) {
    if (safe[key] === undefined || safe[key] === null) continue;
    const r = validateMedicalText(safe[key], {
      maxLen: 200,
      fieldName: `doctor_info.${key}`,
      allowNewlines: false,
    });
    if (!r.ok) return r;
    if (r.value) cleaned[key] = r.value;
  }

  if (!cleaned.firma) cleaned.firma = 'Firma Digital';
  return { ok: true, value: cleaned };
}

function coerceBoolean(value, fallback = true) {
  if (typeof value === 'boolean') return { ok: true, value };
  if (value === null || typeof value === 'undefined') {
    return { ok: true, value: fallback };
  }
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1') return { ok: true, value: true };
    if (v === 'false' || v === '0') return { ok: true, value: false };
  }
  if (value === 1) return { ok: true, value: true };
  if (value === 0) return { ok: true, value: false };
  return { ok: false, error: 'disponible_paciente debe ser booleano.' };
}

function validateRecetaPayload(body) {
  const src = body && typeof body === 'object' ? body : {};
  const errors = [];
  const data = {};

  // pacienteid (entero positivo opcional si se usa busqueda)
  data.pacienteid = parsePositiveInt(src.pacienteid, null);

  // paciente_search (opcional)
  const psr = validateIdentifierText(src.paciente_search, {
    maxLen: 100,
    fieldName: 'paciente_search',
  });
  if (!psr.ok) errors.push(psr.error);
  else data.paciente_search = psr.value;

  // citaid: UUID opcional. Cero-uuid se trata como ausencia.
  const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
  const rawCita = normalizeText(src.citaid);
  if (rawCita && rawCita !== ZERO_UUID) {
    const cit = validateUuid(rawCita, 'citaid');
    if (!cit.ok) errors.push(cit.error);
    else data.citaid = cit.value;
  } else {
    data.citaid = null;
  }

  // diagnostico (texto medico, opcional)
  const diagR = validateMedicalText(src.diagnostico, {
    maxLen: 5000,
    fieldName: 'diagnostico',
  });
  if (!diagR.ok) errors.push(diagR.error);
  else data.diagnostico = diagR.value;

  // instrucciones (texto medico, opcional)
  const instR = validateMedicalText(src.instrucciones, {
    maxLen: 5000,
    fieldName: 'instrucciones',
  });
  if (!instR.ok) errors.push(instR.error);
  else data.instrucciones = instR.value;

  // ordenes_laboratorio (texto medico, opcional)
  const ordR = validateMedicalText(src.ordenes_laboratorio, {
    maxLen: 5000,
    fieldName: 'ordenes_laboratorio',
  });
  if (!ordR.ok) errors.push(ordR.error);
  else data.ordenes_laboratorio = ordR.value;

  // medicamentos (obligatorio)
  const medR = validateMedicamentos(src.medicamentos);
  if (!medR.ok) errors.push(medR.error);
  else data.medicamentos = medR.value;

  // signos_vitales (opcional, se filtran claves desconocidas)
  const svR = validateSignosVitales(src.signos_vitales);
  if (!svR.ok) errors.push(svR.error);
  else data.signos_vitales = svR.value;

  // doctor_info (opcional, claves restringidas)
  const diR = validateDoctorInfo(src.doctor_info);
  if (!diR.ok) errors.push(diR.error);
  else data.doctor_info = diR.value;

  // disponible_paciente (boolean)
  const dpR = coerceBoolean(src.disponible_paciente, true);
  if (!dpR.ok) errors.push(dpR.error);
  else data.disponible_paciente = dpR.value;

  // Identificacion del paciente: al menos uno
  if (!data.pacienteid && !data.paciente_search) {
    errors.push('Debe identificar un paciente valido (pacienteid o paciente_search).');
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, data };
}

// Middleware Express reutilizable.
// Valida req.body y, si pasa, deja los datos limpios en req.validatedReceta.
function validateRecetaBody(req, res, next) {
  const result = validateRecetaPayload(req.body || {});
  if (!result.ok) {
    return res.status(400).json({
      success: false,
      message: 'Datos de receta invalidos.',
      errors: result.errors,
    });
  }
  req.validatedReceta = result.data;
  return next();
}

module.exports = {
  // Regex/whitelist exportados para reuso/tests
  MEDICAL_TEXT_RE,
  MEDICAL_TEXT_NO_NEWLINE_RE,
  IDENTIFIER_RE,
  UUID_RE,
  SIGNOS_VALUE_RE,
  DOSIS_RE,
  FRECUENCIA_RE,
  DURACION_RE,
  BANNED_CHARS_RE,
  ALLOWED_SIGNOS_KEYS,
  ALLOWED_DOCTOR_KEYS,
  // Validadores granulares
  validateMedicalText,
  validateIdentifierText,
  validateUuid,
  validateMedicamento,
  validateMedicamentos,
  validateSignosVitales,
  validateDoctorInfo,
  coerceBoolean,
  // Orquestadores
  validateRecetaPayload,
  validateRecetaBody,
};
