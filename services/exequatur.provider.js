const axios = require("axios");
const cheerio = require("cheerio");
const { wrapper } = require("axios-cookiejar-support");
const tough = require("tough-cookie");

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
]);

const ALLOW_INSECURE_TLS_FALLBACK =
  String(process.env.SNS_ALLOW_INSECURE_TLS_FALLBACK || "true") !== "false";
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
const SNS_TLS_FALLBACK_CACHE_MS = Math.max(
  5000,
  Number.parseInt(process.env.SNS_TLS_FALLBACK_CACHE_MS || "1800000", 10) ||
    1800000
);

let snsUnavailableUntil = 0;
let forceInsecureTlsUntil = 0;
let lastTlsWarningAt = 0;
let lastUnavailableLogAt = 0;

function nowMs() {
  return Date.now();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildClient() {
  return wrapper(
    axios.create({
      jar: new tough.CookieJar(),
      withCredentials: true,
      timeout: SNS_TIMEOUT_MS,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-DO,es;q=0.9,en;q=0.8",
        Connection: "keep-alive",
      },
    })
  );
}

function parseSnsError(error) {
  const status = Number(error?.response?.status || 0);
  const code = String(error?.code || "");
  const message = error?.message || "Error desconocido";
  const serviceUnavailable =
    status >= 500 ||
    TEMPORARY_NETWORK_CODES.has(code) ||
    TLS_CERT_ERROR_CODES.has(code);

  return {
    status: status || null,
    code: code || null,
    message,
    serviceUnavailable,
  };
}

function shouldUseInsecureTlsByCache() {
  return ALLOW_INSECURE_TLS_FALLBACK && nowMs() < forceInsecureTlsUntil;
}

function openTlsFallbackWindow() {
  const until = nowMs() + SNS_TLS_FALLBACK_CACHE_MS;
  forceInsecureTlsUntil = Math.max(forceInsecureTlsUntil, until);
}

function warnTlsFallbackOnce(code) {
  const now = nowMs();
  if (now - lastTlsWarningAt < 30000) return;
  lastTlsWarningAt = now;
  console.warn(
    `SNS TLS warning (${code}). Using insecure TLS fallback for exequatur provider.`
  );
}

function logSnsUnavailableOnce(meta) {
  const now = nowMs();
  if (now - lastUnavailableLogAt < 5000) return;
  lastUnavailableLogAt = now;
  console.error("Error SNS:", meta);
}

async function runWithInsecureTls(task) {
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  try {
    return await task();
  } finally {
    if (typeof previous === "undefined") {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    }
  }
}

async function consultarConCliente({ client, fullName }) {
  const wpResponse = await client.get(WP_URL);
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

  const getResponse = await client.get(ASPX_URL);
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

  const postResponse = await client.post(ASPX_URL, formData.toString(), {
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

async function ejecutarConsultaSns({ fullName, insecureTls }) {
  try {
    const result = insecureTls
      ? await runWithInsecureTls(() =>
          consultarConCliente({ client: buildClient(), fullName })
        )
      : await consultarConCliente({ client: buildClient(), fullName });

    if (insecureTls) {
      return { ...result, tlsFallbackInsecure: true };
    }

    return result;
  } catch (error) {
    const parsed = parseSnsError(error);

    if (
      !insecureTls &&
      ALLOW_INSECURE_TLS_FALLBACK &&
      parsed.code &&
      TLS_CERT_ERROR_CODES.has(parsed.code)
    ) {
      openTlsFallbackWindow();
      warnTlsFallbackOnce(parsed.code);

      try {
        const fallbackResult = await runWithInsecureTls(() =>
          consultarConCliente({ client: buildClient(), fullName })
        );
        return { ...fallbackResult, tlsFallbackInsecure: true };
      } catch (fallbackError) {
        const fallbackParsed = parseSnsError(fallbackError);
        return {
          ok: false,
          serviceUnavailable: fallbackParsed.serviceUnavailable,
          reason: fallbackParsed.serviceUnavailable
            ? TEMPORARY_UNAVAILABLE_REASON
            : "Error consultando SNS.",
          _meta: fallbackParsed,
        };
      }
    }

    return {
      ok: false,
      serviceUnavailable: parsed.serviceUnavailable,
      reason: parsed.serviceUnavailable
        ? TEMPORARY_UNAVAILABLE_REASON
        : "Error consultando SNS.",
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

  let useInsecureTls = shouldUseInsecureTlsByCache();
  let lastResult = null;

  for (let attempt = 1; attempt <= SNS_MAX_ATTEMPTS; attempt += 1) {
    const result = await ejecutarConsultaSns({
      fullName,
      insecureTls: useInsecureTls,
    });

    if (result.tlsFallbackInsecure) {
      useInsecureTls = true;
      openTlsFallbackWindow();
    }

    if (result.ok || !result.serviceUnavailable || attempt === SNS_MAX_ATTEMPTS) {
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
