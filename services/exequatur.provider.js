const { chromium } = require("playwright");

const SNS_URL =
  "https://sns.gob.do/herramientas-de-consulta/consulta-de-exequatur/";

const DEBUG = String(process.env.EXEQUATUR_DEBUG || "").toLowerCase() === "true";
const PARTICLES = new Set(["de", "del", "la", "las", "los", "y"]);

function debugLog(...args) {
  if (DEBUG) {
    console.log("[EXEQUATUR_DEBUG]", ...args);
  }
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,-]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokensFromName(name, removeParticles = false) {
  const tokens = normalizeText(name).split(" ").filter(Boolean);
  if (!removeParticles) return tokens;
  return tokens.filter((token) => !PARTICLES.has(token));
}

function levenshtein(a, b) {
  const s = normalizeText(a);
  const t = normalizeText(b);

  if (!s.length) return t.length;
  if (!t.length) return s.length;

  const dp = Array.from({ length: s.length + 1 }, () => Array(t.length + 1).fill(0));

  for (let i = 0; i <= s.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= t.length; j += 1) dp[0][j] = j;

  for (let i = 1; i <= s.length; i += 1) {
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }

  return dp[s.length][t.length];
}

function scoreNameMatch(inputName, candidateName) {
  const inputNorm = normalizeText(inputName);
  const candidateNorm = normalizeText(candidateName);

  if (!inputNorm || !candidateNorm) {
    return { score: 0, method: "empty" };
  }

  const inputTokens = tokensFromName(inputNorm, true);
  const candidateTokens = tokensFromName(candidateNorm, true);
  const inputSet = new Set(inputTokens);
  const candidateSet = new Set(candidateTokens);

  const intersection = [...inputSet].filter((token) => candidateSet.has(token)).length;
  const union = new Set([...inputSet, ...candidateSet]).size || 1;
  const scoreA = intersection / union;

  const includes =
    candidateNorm.includes(inputNorm) || inputNorm.includes(candidateNorm) ? 1 : 0;

  const distance = levenshtein(inputNorm, candidateNorm);
  const maxLen = Math.max(inputNorm.length, candidateNorm.length) || 1;
  const scoreC = 1 - distance / maxLen;

  const score = Number((scoreA * 0.55 + includes * 0.2 + scoreC * 0.25).toFixed(4));

  const methods = ["token_overlap", "levenshtein_ratio"];
  if (includes) methods.push("includes");

  return {
    score,
    method: methods.join("+"),
    breakdown: { scoreA, scoreB: includes, scoreC },
  };
}

function normalizeDoctorRecord(record) {
  return {
    nombre: record.nombre || record.nombres || "",
    profesion: record.profesion || "",
    universidad: record.universidad || "",
    no_registro: record.no_registro || record.registro || "",
    fecha_registro: record.fecha_registro || "",
    folio: record.folio || "",
    libro: record.libro || "",
    no_decreto: record.no_decreto || record.decreto || "",
    cedula: record.cedula || "",
  };
}

function findBestDoctorMatch(rows, nombreCompleto, cedulaDigits) {
  const scored = rows
    .map((row) => {
      const doctor = normalizeDoctorRecord(row);
      const nameForMatch = doctor.nombre || row.rawName || "";
      const match = scoreNameMatch(nombreCompleto, nameForMatch);

      if (cedulaDigits && doctor.cedula) {
        const rowCedulaDigits = String(doctor.cedula).replace(/\D/g, "");
        if (rowCedulaDigits && rowCedulaDigits !== cedulaDigits) {
          return { doctor, score: 0, method: `${match.method}+cedula_mismatch` };
        }
      }

      return {
        doctor,
        score: match.score,
        method: match.method,
        breakdown: match.breakdown,
      };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0] || null;
}

async function parseTableRows(page) {
  return page.evaluate(() => {
    const normalizeHeader = (v) =>
      String(v || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim();

    const tableCandidates = Array.from(document.querySelectorAll("table"));

    for (const table of tableCandidates) {
      const rows = Array.from(table.querySelectorAll("tbody tr"));
      if (!rows.length) continue;

      const headerCells = Array.from(table.querySelectorAll("thead th"));
      const headers = headerCells.map((cell) => normalizeHeader(cell.textContent));

      const mapped = rows
        .map((row) => {
          const cols = Array.from(row.querySelectorAll("td")).map((td) =>
            String(td.textContent || "").replace(/\s+/g, " ").trim(),
          );

          if (!cols.some(Boolean)) return null;

          const data = {
            rawName: cols[0] || "",
            nombre: "",
            profesion: "",
            universidad: "",
            no_registro: "",
            fecha_registro: "",
            folio: "",
            libro: "",
            no_decreto: "",
            cedula: "",
          };

          if (headers.length === cols.length) {
            headers.forEach((header, i) => {
              const value = cols[i] || "";
              if (!value) return;

              if (header.includes("nombre")) data.nombre = value;
              else if (header.includes("profesion")) data.profesion = value;
              else if (header.includes("universidad")) data.universidad = value;
              else if (header.includes("registro") || header.includes("no. registro")) {
                data.no_registro = value;
              } else if (header.includes("fecha")) data.fecha_registro = value;
              else if (header.includes("folio")) data.folio = value;
              else if (header.includes("libro")) data.libro = value;
              else if (header.includes("decreto")) data.no_decreto = value;
              else if (header.includes("cedula")) data.cedula = value;
            });
          }

          if (!data.nombre && cols[0]) data.nombre = cols[0];
          if (!data.profesion && cols[1]) data.profesion = cols[1];
          if (!data.universidad && cols[2]) data.universidad = cols[2];
          if (!data.no_registro && cols[3]) data.no_registro = cols[3];
          if (!data.fecha_registro && cols[4]) data.fecha_registro = cols[4];
          if (!data.folio && cols[5]) data.folio = cols[5];
          if (!data.libro && cols[6]) data.libro = cols[6];
          if (!data.no_decreto && cols[7]) data.no_decreto = cols[7];

          return data;
        })
        .filter(Boolean);

      if (mapped.length) {
        return mapped;
      }
    }

    return [];
  });
}

async function consultarExequaturSNS({ cedula, nombreCompleto, nombres, apellidos }) {
  const cedulaDigits = String(cedula || "").replace(/\D/g, "");
  const fullName = String(
    nombreCompleto || `${String(nombres || "").trim()} ${String(apellidos || "").trim()}`,
  )
    .replace(/\s+/g, " ")
    .trim();

  if (!cedulaDigits && !fullName) {
    return {
      ok: false,
      reason: "Debes enviar cédula o nombreCompleto para validar Exequátur.",
    };
  }

  const query = cedulaDigits || fullName;
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    debugLog("Query SNS:", cedulaDigits ? "[cedula]" : normalizeText(fullName));

    await page.goto(SNS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    await page.waitForTimeout(1500);

    const inputCandidates = [
      'input[type="search"]',
      'input[placeholder*="Buscar" i]',
      'input[placeholder*="Cédula" i]',
      'input[placeholder*="Cedula" i]',
      'input[name*="search" i]',
      'input[name*="cedula" i]',
      'input[name*="nombre" i]',
      "input[type='text']",
    ];

    let input = null;
    for (const sel of inputCandidates) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
        input = loc;
        break;
      }
    }

    if (!input) {
      return { ok: false, reason: "No se encontró el campo de búsqueda en SNS." };
    }

    await input.click().catch(() => {});
    await input.fill(query);

    const buttonCandidates = [
      'button:has-text("Buscar")',
      'button:has-text("CONSULTAR")',
      'button[type="submit"]',
      'input[type="submit"]',
    ];

    let clicked = false;
    for (const bsel of buttonCandidates) {
      const btn = page.locator(bsel).first();
      if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
        await btn.click().catch(() => {});
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      await input.press("Enter").catch(() => {});
    }

    await page.waitForTimeout(3500);

    try {
      await page.waitForFunction(
        () => {
          const countRows = document.querySelectorAll("table tbody tr").length;
          const bodyText = document.body?.innerText || "";
          return countRows > 0 || /cantidad de registros|no se encontraron|sin resultados/i.test(bodyText);
        },
        { timeout: 10000 },
      );
    } catch (_err) {
      debugLog("Timeout esperando resultados de tabla en SNS");
    }

    const bodyText = (await page.textContent("body").catch(() => "")) || "";
    const registrosMatch = bodyText.match(/cantidad\s+de\s+registros\s*:?\s*(\d+)/i);
    const cantidadRegistros = registrosMatch ? Number(registrosMatch[1]) : null;

    const rows = await parseTableRows(page);
    debugLog("Cantidad de registros (texto):", cantidadRegistros);
    debugLog("Filas parseadas:", rows.length);
    if (DEBUG) {
      debugLog(
        "Nombres parseados:",
        rows.map((row) => row.nombre || row.rawName).slice(0, 15),
      );
    }

    if (!rows.length) {
      const txt = normalizeText(bodyText);
      if (txt.includes("no") && (txt.includes("resultado") || txt.includes("encontro"))) {
        return { ok: true, exists: false };
      }
      return { ok: true, exists: false };
    }

    const best = findBestDoctorMatch(rows, fullName, cedulaDigits);
    if (!best) {
      return { ok: true, exists: false };
    }

    debugLog("Mejor score:", best.score, "Método:", best.method);

    const THRESHOLD = 0.75;
    if (best.score >= THRESHOLD) {
      return {
        ok: true,
        exists: true,
        doctor: best.doctor,
        match: {
          score: best.score,
          method: best.method,
          threshold: THRESHOLD,
        },
      };
    }

    return {
      ok: true,
      exists: false,
      match: {
        score: best.score,
        method: best.method,
        threshold: THRESHOLD,
      },
    };
  } catch (err) {
    debugLog("Error consultando SNS:", err?.message || err);
    return {
      ok: false,
      reason: "No se pudo consultar Exequátur en SNS (sitio caído o cambió la página).",
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = {
  consultarExequaturSNS,
  normalizeText,
  scoreNameMatch,
};
