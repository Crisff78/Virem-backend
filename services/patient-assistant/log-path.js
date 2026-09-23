// Request bodies, user-provided query strings, filenames and request-id headers are never audit labels.
function logPath(req) {
  const path = req.originalUrl || req.url || "";
  return path.startsWith("/api/patient-assistant")
    ? "/api/patient-assistant"
    : path;
}
module.exports = { logPath };
