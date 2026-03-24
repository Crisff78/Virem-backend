const fs = require("fs");
const path = require("path");

const baseUrl =
  process.env.BASE_URL ||
  process.env.BACKEND_BASE_URL ||
  `http://127.0.0.1:${process.env.PORT || 3000}`;

const reportPath =
  process.env.SMOKE_REPORT_PATH ||
  path.join(__dirname, "..", "reports", "smoke-report.json");

const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 8000);

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, timer };
}

async function requestJson(url) {
  const { controller, timer } = withTimeout(timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (_err) {
      body = { raw: text };
    }
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function ensure(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function saveReport(report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
}

async function run() {
  const checks = [];
  const startedAt = new Date().toISOString();

  try {
    const health = await requestJson(`${baseUrl}/health`);
    ensure(health.status === 200, `Health check fallo con status ${health.status}`);
    checks.push({
      check: "GET /health devuelve 200",
      status: "ok",
      detail: health.body,
    });

    const root = await requestJson(`${baseUrl}/`);
    ensure(root.status === 200, `Ruta raiz fallo con status ${root.status}`);
    ensure(root.body && root.body.endpoints, "Ruta raiz no devolvio endpoints");
    checks.push({
      check: "GET / devuelve metadata de endpoints",
      status: "ok",
      detail: root.body,
    });

    const notFound = await requestJson(`${baseUrl}/ruta-que-no-existe`);
    ensure(notFound.status === 404, `Ruta invalida esperaba 404 y devolvio ${notFound.status}`);
    checks.push({
      check: "GET ruta invalida devuelve 404 controlado",
      status: "ok",
      detail: notFound.body,
    });

    const report = {
      startedAt,
      finishedAt: new Date().toISOString(),
      baseUrl,
      status: "passed",
      checks,
    };
    saveReport(report);
    console.log("Smoke test completado OK");
    console.log(`Reporte: ${reportPath}`);
  } catch (error) {
    const report = {
      startedAt,
      finishedAt: new Date().toISOString(),
      baseUrl,
      status: "failed",
      checks,
      error: error.message,
    };
    saveReport(report);
    console.error("Smoke test fallo:", error.message);
    console.error(`Reporte: ${reportPath}`);
    process.exit(1);
  }
}

run();
