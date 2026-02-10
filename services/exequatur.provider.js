const { chromium } = require("playwright");

const SNS_URL =
  "https://sns.gob.do/herramientas-de-consulta/consulta-de-exequatur/";

/**
 * Consulta Exequátur Médico en SNS
 * Devuelve:
 * - ok:true exists:true doctor
 * - ok:true exists:false
 * - ok:false reason
 */
async function consultarExequaturSNS({ cedula, nombres, apellidos }) {
  const cedulaDigits = String(cedula || "").replace(/\D/g, "");
  const nom = String(nombres || "").trim();
  const ape = String(apellidos || "").trim();

  if (!cedulaDigits && !nom) {
    return {
      ok: false,
      reason: "Debes enviar cédula o nombres para validar Exequátur.",
    };
  }

  // Query: si hay cédula, usarla; si no, nombre+apellido
  const query = cedulaDigits || `${nom} ${ape}`.trim();

  let browser;

  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.goto(SNS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    // Espera un poquito a que scripts armen la UI
    await page.waitForTimeout(1500);

    // 1) Encuentra un input que parezca de búsqueda
    // (muchas páginas usan placeholder, name o type search)
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
      if ((await loc.count()) > 0) {
        // que sea visible
        if (await loc.isVisible().catch(() => false)) {
          input = loc;
          break;
        }
      }
    }

    if (!input) {
      // DEBUG: guarda html para revisar
      const html = await page.content();
      console.log("SNS DEBUG: no encontré input. HTML length:", html.length);
      return { ok: false, reason: "No se encontró el campo de búsqueda en SNS." };
    }

    await input.click().catch(() => {});
    await input.fill(query);

    // 2) Intentar click en botón Buscar si existe
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

    // Si no hay botón, Enter
    if (!clicked) {
      await input.press("Enter").catch(() => {});
    }

    // 3) Espera resultados (más tiempo porque a veces tarda)
    await page.waitForTimeout(3500);

    // 4) Detectar si hay tabla/filas o algún “no results”
    const rowCount = await page.locator("table tbody tr").count().catch(() => 0);

    // Si hay tabla y filas: parsear
    if (rowCount > 0) {
      const cols = await page
        .locator("table tbody tr")
        .first()
        .locator("td")
        .allTextContents();

      const clean = cols.map((x) => String(x || "").trim()).filter((x) => x.length > 0);

      const doctor = {
        nombres: clean[0] || "",
        cedula: clean[1] || "",
        decreto: clean[2] || "",
        registro: clean[3] || "",
      };

      // Validación extra por cédula
      if (cedulaDigits && doctor.cedula) {
        const doctorCed = String(doctor.cedula).replace(/\D/g, "");
        if (doctorCed && doctorCed !== cedulaDigits) {
          return { ok: true, exists: false };
        }
      }

      return { ok: true, exists: true, doctor };
    }

    // 5) Si no hay filas, buscar textos típicos (por si la página muestra mensaje)
    const bodyText = await page.textContent("body").catch(() => "");
    const txt = String(bodyText || "").toLowerCase();

    // mensajes comunes (puede variar)
    if (txt.includes("no") && (txt.includes("resultado") || txt.includes("encontr"))) {
      return { ok: true, exists: false };
    }

    // DEBUG: si llegamos aquí, es que no detectamos ni tabla ni mensaje.
    // imprimimos algo para ajustar selectores.
    const html = await page.content();
    console.log("SNS DEBUG: sin filas y sin mensaje claro.");
    console.log("SNS DEBUG HTML length:", html.length);

    return { ok: true, exists: false };
  } catch (err) {
    return {
      ok: false,
      reason: "No se pudo consultar Exequátur en SNS (sitio caído o cambió la página).",
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { consultarExequaturSNS };
