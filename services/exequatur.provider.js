const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const https = require("https");

const WP_URL =
  "https://sns.gob.do/herramientas-de-consulta/consulta-de-exequatur/";

const TEMPORARY_UNAVAILABLE_REASON =
  "El servicio del SNS esta temporalmente no disponible. Intenta nuevamente en unos minutos.";

const TEMPORARY_NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

const TLS_CERT_ERROR_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

const SNS_TIMEOUT_MS = Math.max(
  3000,
  Number.parseInt(process.env.SNS_TIMEOUT_MS || "10000", 10) || 10000
);
const SNS_MAX_ATTEMPTS = Math.max(
  1,
  Number.parseInt(process.env.SNS_MAX_ATTEMPTS || "5", 10) || 5
);
const SNS_BACKOFF_BASE_MS = Math.max(
  200,
  Number.parseInt(process.env.SNS_BACKOFF_BASE_MS || "600", 10) || 600
);
const SNS_UNAVAILABLE_CACHE_MS = Math.max(
  0,
  Number.parseInt(process.env.SNS_UNAVAILABLE_CACHE_MS || "0", 10) || 0
);
const SNS_TLS_MIN_VERSION =
  String(process.env.SNS_TLS_MIN_VERSION || "TLSv1.2").trim() || "TLSv1.2";
const SNS_CA_CERT_PATH = String(process.env.SNS_CA_CERT_PATH || "").trim();
const SNS_CA_CERT_PEM = String(process.env.SNS_CA_CERT_PEM || "").trim();

let snsUnavailableUntil = 0;
let lastUnavailableLogAt = 0;

function nowMs() {
  return Date.now();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSnsConfigError(message, cause, code = "SNS_TLS_CONFIG_ERROR") {
  const error = new Error(message);
  error.code = code;
  error.cause = cause || null;
  error.isSnsConfigError = true;
  return error;
}

function normalizePem(value) {
  return String(value || "").replace(/\\n/g, "\n").trim();
}

function loadCustomCaCertificates() {
  const certificates = [];

  const pemInline = normalizePem(SNS_CA_CERT_PEM);
  if (pemInline) {
    certificates.push(pemInline);
  }

  if (SNS_CA_CERT_PATH) {
    try {
      const pemFromFile = fs.readFileSync(SNS_CA_CERT_PATH, "utf8").trim();
      if (!pemFromFile) {
        throw new Error("El archivo de CA esta vacio.");
      }
      certificates.push(pemFromFile);
    } catch (error) {
      throw createSnsConfigError(
        `No se pudo leer SNS_CA_CERT_PATH (${SNS_CA_CERT_PATH}).`,
        error,
        "SNS_CA_CERT_LOAD_FAILED"
      );
    }
  }

  return certificates;
}

function buildHttpsAgent() {
  const options = {
    keepAlive: true,
    minVersion: SNS_TLS_MIN_VERSION,
    rejectUnauthorized: true,
  };

  const certificates = loadCustomCaCertificates();
  if (certificates.length) {
    options.ca = certificates;
  }

  try {
    return new https.Agent(options);
  } catch (error) {
    throw createSnsConfigError(
      "No se pudo construir el agente HTTPS seguro para el SNS.",
      error
    );
  }
}

function buildClient() {
  return axios.create({
    httpsAgent: buildHttpsAgent(),
    timeout: SNS_TIMEOUT_MS,
    maxRedirects: 5,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-DO,es;q=0.9,en;q=0.8",
      Connection: "keep-alive",
    },
  });
}

function createCookieStore() {
  return new Map();
}

function captureCookies(store, headers) {
  const setCookie = headers?.["set-cookie"];
  if (!Array.isArray(setCookie)) return;

  for (const entry of setCookie) {
    const pair = String(entry || "").split(";")[0].trim();
    if (!pair || !pair.includes("=")) continue;
    const cookieName = pair.split("=")[0].trim();
    if (!cookieName) continue;
    store.set(cookieName, pair);
  }
}

function getCookieHeader(store) {
  if (!store || store.size === 0) return "";
  return Array.from(store.values()).join("; ");
}

async function requestWithCookies(client, cookieStore, config) {
  const headers = { ...(config?.headers || {}) };
  const cookieHeader = getCookieHeader(cookieStore);
  if (cookieHeader) {
    headers.Cookie = cookieHeader;
  }

  const response = await client.request({
    ...config,
    headers,
  });

  captureCookies(cookieStore, response.headers);
  return response;
}

function parseSnsError(error) {
  const status = Number(error?.response?.status || 0);
  const code = String(error?.code || "");
  const message = error?.message || "Error desconocido";
  const configError = Boolean(error?.isSnsConfigError);
  const tlsError = TLS_CERT_ERROR_CODES.has(code);
  const serviceUnavailable =
    !configError &&
    (status >= 500 || TEMPORARY_NETWORK_CODES.has(code) || tlsError);

  return {
    status: status || null,
    code: code || null,
    message,
    configError,
    tlsError,
    serviceUnavailable,
  };
}

function logSnsUnavailableOnce(meta) {
  const now = nowMs();
  if (now - lastUnavailableLogAt < 5000) return;
  lastUnavailableLogAt = now;
  console.error("Error SNS:", meta);
}

function buildSnsFailureReason(parsed) {
  if (parsed.configError) {
    return "La configuracion TLS del SNS es invalida. Revisa SNS_CA_CERT_PATH o SNS_CA_CERT_PEM.";
  }

  if (parsed.tlsError) {
    return (
      "No se pudo establecer una conexion TLS segura con el SNS. " +
      "Verifica la cadena de certificados del servicio o configura una CA valida con SNS_CA_CERT_PATH/SNS_CA_CERT_PEM."
    );
  }

  if (parsed.serviceUnavailable) {
    return TEMPORARY_UNAVAILABLE_REASON;
  }

  return "Error consultando SNS.";
}

async function consultarConCliente({ client, fullName }) {
  const cookieStore = createCookieStore();
  const wpResponse = await requestWithCookies(client, cookieStore, {
    method: "GET",
    url: WP_URL,
  });
  const $wp = cheerio.load(wpResponse.data);

  const iframeSrc = $wp("iframe").attr("src");
  if (!iframeSrc) {
    return {
      ok: false,
      serviceUnavailable: false,
      reason: "No se encontro iframe.",
    };
  }

  const ASPX_URL = iframeSrc.startsWith("http")
    ? iframeSrc
    : new URL(iframeSrc, WP_URL).href;

  const getResponse = await requestWithCookies(client, cookieStore, {
    method: "GET",
    url: ASPX_URL,
  });
  const $ = cheerio.load(getResponse.data);

  if (!$("#__VIEWSTATE").val()) {
    return {
      ok: false,
      serviceUnavailable: false,
      reason: "No se pudo obtener VIEWSTATE.",
    };
  }

  const formData = new URLSearchParams();
  $("form input, form select, form textarea").each((_, el) => {
    const name = $(el).attr("name");
    if (!name) return;
    formData.append(name, $(el).val() || "");
  });

  formData.set("TextNombres", fullName);
  formData.set("DropDownListCriterio", "0");
  formData.set("ButtonBuscar1", "Buscar");
  formData.delete("Buttonpopup");
  formData.delete("ButtonLimpiar1");
  formData.delete("ButtonCerrar");
  formData.set("__EVENTTARGET", "");
  formData.set("__EVENTARGUMENT", "");

  const postResponse = await requestWithCookies(client, cookieStore, {
    method: "POST",
    url: ASPX_URL,
    data: formData.toString(),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: ASPX_URL,
    },
  });

  const $$ = cheerio.load(postResponse.data);
  const rows = [];
  $$("#GridView1 tbody tr").each((i, el) => {
    if (i === 0) return;

    const cols = $$(el).find("td");
    if (cols.length < 11) return;

    rows.push({
      nombre: cols.eq(2).text().trim(),
      profesion: cols.eq(4).text().trim(),
      universidad: cols.eq(5).text().trim(),
      no_registro: cols.eq(6).text().trim(),
      fecha_registro: cols.eq(7).text().trim(),
      folio: cols.eq(8).text().trim(),
      libro: cols.eq(9).text().trim(),
      no_decreto: cols.eq(10).text().trim(),
    });
  });

  if (!rows.length) {
    return { ok: true, exists: false };
  }

  return {
    ok: true,
    exists: true,
    data: rows,
  };
}

async function ejecutarConsultaSns({ fullName }) {
  try {
    return await consultarConCliente({ client: buildClient(), fullName });
  } catch (error) {
    const parsed = parseSnsError(error);
    return {
      ok: false,
      serviceUnavailable: parsed.serviceUnavailable,
      configError: parsed.configError,
      tlsError: parsed.tlsError,
      reason: buildSnsFailureReason(parsed),
      _meta: parsed,
    };
  }
}

async function consultarExequaturSNS({ nombreCompleto }) {
  const fullName = String(nombreCompleto || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!fullName) {
    return { ok: false, reason: "Debes enviar nombreCompleto." };
  }

  if (SNS_UNAVAILABLE_CACHE_MS > 0 && nowMs() < snsUnavailableUntil) {
    return {
      ok: false,
      serviceUnavailable: true,
      reason: TEMPORARY_UNAVAILABLE_REASON,
      fastFailCached: true,
    };
  }

  let lastResult = null;

  for (let attempt = 1; attempt <= SNS_MAX_ATTEMPTS; attempt += 1) {
    const result = await ejecutarConsultaSns({ fullName });

    if (
      result.ok ||
      !result.serviceUnavailable ||
      result.configError ||
      result.tlsError ||
      attempt === SNS_MAX_ATTEMPTS
    ) {
      if (!result.ok && result.serviceUnavailable) {
        if (SNS_UNAVAILABLE_CACHE_MS > 0) {
          snsUnavailableUntil = nowMs() + SNS_UNAVAILABLE_CACHE_MS;
        } else {
          snsUnavailableUntil = 0;
        }
        if (result._meta) {
          logSnsUnavailableOnce(result._meta);
        }
      }
      return result;
    }

    lastResult = result;
    await wait(SNS_BACKOFF_BASE_MS * attempt);
  }

  const fallback = {
    ok: false,
    serviceUnavailable: true,
    reason: TEMPORARY_UNAVAILABLE_REASON,
  };

  if (lastResult?._meta) {
    logSnsUnavailableOnce(lastResult._meta);
  }
  if (SNS_UNAVAILABLE_CACHE_MS > 0) {
    snsUnavailableUntil = nowMs() + SNS_UNAVAILABLE_CACHE_MS;
  } else {
    snsUnavailableUntil = 0;
  }

  return fallback;
}

module.exports = {
  consultarExequaturSNS,
};
