process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const axios = require("axios");
const cheerio = require("cheerio");
const { wrapper } = require("axios-cookiejar-support");
const tough = require("tough-cookie");

const WP_URL =
  "https://sns.gob.do/herramientas-de-consulta/consulta-de-exequatur/";

async function consultarExequaturSNS({ nombreCompleto }) {
  const fullName = String(nombreCompleto || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!fullName) {
    return { ok: false, reason: "Debes enviar nombreCompleto." };
  }

  try {
    const cookieJar = new tough.CookieJar();

    const client = wrapper(
      axios.create({
        jar: cookieJar,
        withCredentials: true,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Connection: "keep-alive",
        },
      })
    );

    // 1️⃣ Obtener página WordPress
    const wpResponse = await client.get(WP_URL);
    const $wp = cheerio.load(wpResponse.data);

    const iframeSrc = $wp("iframe").attr("src");

    if (!iframeSrc) {
      return { ok: false, reason: "No se encontró iframe." };
    }

    const ASPX_URL = iframeSrc.startsWith("http")
      ? iframeSrc
      : new URL(iframeSrc, WP_URL).href;

    // 2️⃣ GET real al ASPX
    const getResponse = await client.get(ASPX_URL);
    const $ = cheerio.load(getResponse.data);

    if (!$("#__VIEWSTATE").val()) {
      return {
        ok: false,
        reason: "No se pudo obtener VIEWSTATE.",
      };
    }

    // 3️⃣ CLONAR TODO EL FORMULARIO EXACTO
    const formData = new URLSearchParams();

    $("form input, form select, form textarea").each((i, el) => {
      const name = $(el).attr("name");
      if (!name) return;

      let value = $(el).val() || "";

      formData.append(name, value);
    });

    // 4️⃣ Sobrescribir solo lo necesario
    formData.set("TextNombres", fullName);
    formData.set("DropDownListCriterio", "0");
    formData.set("ButtonBuscar1", "Buscar");

    // Eliminar botones que no fueron presionados
    formData.delete("Buttonpopup");
    formData.delete("ButtonLimpiar1");
    formData.delete("ButtonCerrar");

    // Asegurar que solo el botón correcto vaya
    formData.set("ButtonBuscar1", "Buscar");
    
    // Asegurar que estos estén vacíos como navegador
    formData.set("__EVENTTARGET", "");
    formData.set("__EVENTARGUMENT", "");

    console.log(formData.toString());
    // 5️⃣ POST exacto
    const postResponse = await client.post(
      ASPX_URL,
      formData.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: ASPX_URL,
          Origin: "https://sns.gob.do/herramientas-de-consulta/consulta-de-exequatur/",
        },
      }
    );

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
  } catch (error) {
    console.error("Error SNS:", error.message);
    return {
      ok: false,
      reason: "Error consultando SNS.",
    };
  }
}

module.exports = {
  consultarExequaturSNS,
};