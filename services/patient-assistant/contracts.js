const { z } = require("zod");

const MAX_BYTES = 10 * 1024 * 1024;
const uuid = z.string().uuid();
const sendSchema = z
  .object({
    requestId: uuid,
    question: z.string().trim().max(4000).default(""),
    documentIds: z.array(uuid).max(5).default([]),
  })
  .strict()
  .refine((v) => v.question.length > 0 || v.documentIds.length > 0);
const findingSchema = z
  .object({
    label: z.string().max(200),
    value: z.string().max(200),
    unit: z.string().max(100),
    range: z.string().max(200),
    quote: z.string().max(1000),
    page: z.number().int().positive().nullable(),
  })
  .strict();
const extractionSchema = z
  .object({
    kind: z.enum(["laboratory", "written_report", "unsupported", "unreadable"]),
    text: z.string().max(60000),
    findings: z.array(findingSchema).max(100),
    limitations: z.array(z.string().max(600)).max(10),
  })
  .strict();
const answerSchema = z
  .object({
    summary: z.string().min(1).max(6000),
    interpretation: z.string().max(10000),
    uncertainty: z.string().max(3000),
    consultation: z.array(z.string().max(600)).max(6),
    followups: z.array(z.string().max(200)).max(3),
  })
  .strict();

class AssistantError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
const messages = {
  invalid_request: "Revisa la pregunta o los identificadores enviados.",
  not_found: "La conversación o el documento no está disponible.",
  unavailable: "El asistente todavía no está configurado. Intenta más tarde.",
  provider_error:
    "No pudimos completar la respuesta. Tu pregunta se conserva; puedes reintentar.",
  invalid_response: "No pudimos validar la explicación. Tu estudio y tu pregunta se conservan; puedes reintentar.",
  response_incomplete: "La explicación se interrumpió antes de terminar. Tu estudio y tu pregunta se conservan; puedes reintentar.",
  provider_busy: "El servicio de IA alcanzó su límite temporal. Espera un momento y vuelve a intentarlo.",
  provider_timeout: "El servicio de IA tardó demasiado. Tu estudio y tu pregunta se conservan; puedes reintentar.",
  invalid_file: "El archivo está dañado o no es PDF, PNG, JPEG o WebP.",
  file_too_large: "El archivo supera el límite de 10 MiB.",
  page_limit: "El PDF supera el límite de 20 páginas.",
  unreadable:
    "No pudimos leer el informe. Prueba con una copia más clara o con texto seleccionable.",
  unsupported:
    "Adjunta el informe escrito. Este asistente no interpreta radiografías, ECG ni imágenes diagnósticas.",
  document_incomplete:
    "El informe es demasiado extenso para leerlo completo. Adjunta menos páginas o solo la sección de resultados.",
  document_limit:
    "Puedes conservar hasta cinco documentos en esta conversación. Quita uno para continuar.",
  quota: "Alcanzaste el límite diario del asistente. Intenta mañana.",
  busy: "Ya hay una respuesta en curso. Deténla o espera a que termine.",
  not_ready:
    "Espera a que termine la lectura del documento o quita el archivo con error.",
  conflict: "Este envío ya existe con un contenido diferente.",
  invalid_audio:
    "No se pudo leer el audio. Graba un mensaje de hasta dos minutos y 10 MiB.",
  interrupted: "La respuesta se interrumpió. Puedes reintentar.",
};
// `reason` is a fixed technical label for diagnostics; it never contains content.
function fail(code, status, reason) {
  const error = new AssistantError(code, status);
  if (reason) error.reason = reason;
  throw error;
}
// Operations abort with an AssistantError reason: the server deadline is a timeout,
// while patient stops, disconnects and deletions are interruptions.
function abortCode(signal) {
  return signal?.reason?.code === "provider_timeout" ? "provider_timeout" : "interrupted";
}
function publicError(error) {
  const code = error instanceof AssistantError ? error.code : "provider_error";
  return {
    status: error instanceof AssistantError ? error.status : 502,
    code,
    message: messages[code] || messages.provider_error,
  };
}
function boundedHistory(rows) {
  let budget = 30000;
  const result = [];
  for (const row of [...rows].reverse()) {
    if (row.status !== "completed" || !row.answer) continue;
    const answer = JSON.stringify(row.answer);
    const size = row.question.length + answer.length;
    if (size > budget || result.length >= 12) break;
    result.unshift(
      { role: "user", content: row.question },
      { role: "assistant", content: answer },
    );
    budget -= size;
  }
  return result;
}
module.exports = {
  MAX_BYTES,
  uuid,
  sendSchema,
  extractionSchema,
  answerSchema,
  AssistantError,
  fail,
  abortCode,
  publicError,
  boundedHistory,
};
