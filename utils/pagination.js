function nonNegativeInteger(value, fallback) {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;
  if (!/^\d+$/.test(String(value))) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function getPagination(query = {}, { defaultLimit = 50, maxLimit = 250 } = {}) {
  const requestedLimit = nonNegativeInteger(query.limit, defaultLimit);
  const limit = Math.min(maxLimit, Math.max(1, requestedLimit));
  const page = Math.max(1, nonNegativeInteger(query.page, 1));
  const offset = Math.min(1000000, nonNegativeInteger(query.offset, (page - 1) * limit));
  return { limit, offset };
}

module.exports = { getPagination };
