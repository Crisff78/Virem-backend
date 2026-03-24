const fs = require("fs");
const path = require("path");
const autocannon = require("autocannon");

const baseUrl =
  process.env.BASE_URL ||
  process.env.BACKEND_BASE_URL ||
  `http://127.0.0.1:${process.env.PORT || 3000}`;

const targetUrl = process.env.PERF_TARGET_URL || `${baseUrl}/health`;
const connections = Number(process.env.PERF_CONNECTIONS || 20);
const duration = Number(process.env.PERF_DURATION || 10);
const maxAvgLatencyMs = Number(process.env.MAX_AVG_LATENCY_MS || 500);
const maxErrorRate = Number(process.env.MAX_ERROR_RATE || 1);
const reportPath =
  process.env.PERF_REPORT_PATH ||
  path.join(__dirname, "..", "reports", "performance-report.json");

function saveReport(report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
}

function estimateTotalRequests(result) {
  if (typeof result.requests?.total === "number" && result.requests.total > 0) {
    return result.requests.total;
  }
  const avgRps = Number(result.requests?.average || 0);
  return Math.max(1, Math.round(avgRps * duration));
}

async function run() {
  const startedAt = new Date().toISOString();
  console.log("Iniciando prueba de rendimiento...");
  console.log(`URL: ${targetUrl}`);
  console.log(`Conexiones: ${connections}`);
  console.log(`Duracion: ${duration}s`);

  const result = await autocannon({
    url: targetUrl,
    connections,
    duration,
  });

  const avgLatencyMs = Number(result.latency?.average || 0);
  const totalRequests = estimateTotalRequests(result);
  const totalErrors = Number(result.errors || 0) + Number(result.timeouts || 0);
  const errorRate = Number(((totalErrors / totalRequests) * 100).toFixed(2));

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    targetUrl,
    connections,
    duration,
    metrics: {
      requestsPerSecondAvg: result.requests?.average || 0,
      latencyMsAvg: avgLatencyMs,
      throughputBytesAvg: result.throughput?.average || 0,
      totalRequests,
      totalErrors,
      errorRatePercent: errorRate,
    },
    thresholds: {
      maxAvgLatencyMs,
      maxErrorRatePercent: maxErrorRate,
    },
  };

  const latencyOk = avgLatencyMs <= maxAvgLatencyMs;
  const errorRateOk = errorRate <= maxErrorRate;

  report.status = latencyOk && errorRateOk ? "passed" : "failed";
  saveReport(report);

  console.log("Resumen de rendimiento:");
  console.log(`- RPS promedio: ${report.metrics.requestsPerSecondAvg}`);
  console.log(`- Latencia promedio: ${avgLatencyMs} ms`);
  console.log(`- Error rate: ${errorRate}%`);
  console.log(`Reporte: ${reportPath}`);

  if (report.status === "failed") {
    const reasons = [];
    if (!latencyOk) reasons.push(`latencia promedio > ${maxAvgLatencyMs} ms`);
    if (!errorRateOk) reasons.push(`error rate > ${maxErrorRate}%`);
    console.error(`Prueba de rendimiento fallo: ${reasons.join(" y ")}`);
    process.exit(1);
  }

  console.log("Prueba de rendimiento completada OK");
}

run().catch((error) => {
  console.error("No se pudo ejecutar la prueba de rendimiento:", error.message);
  process.exit(1);
});
