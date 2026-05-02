const pool = require("../../config/db");

const ADMIN_ROLE_ID = 3;
const MEDICO_ROLE_ID = 2;
const PACIENTE_ROLE_ID = 1;

function toPositiveInt(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeOwnerUserIds(value) {
  const rawItems = Array.isArray(value) ? value : [value];
  const ids = rawItems
    .map((item) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        return toPositiveInt(item.usuarioid ?? item.ownerUserId ?? item.owner_user_id);
      }
      return toPositiveInt(item);
    })
    .filter((id) => id > 0);

  return [...new Set(ids)];
}

function normalizeOwnershipResult(result) {
  if (result === null || typeof result === "undefined") {
    return {
      exists: false,
      ownerUserIds: [],
      notFoundMessage: "Recurso no encontrado.",
      forbiddenMessage: "No tienes permisos para acceder a este recurso.",
    };
  }

  const isObject = result && typeof result === "object" && !Array.isArray(result);
  if (!isObject) {
    return {
      exists: true,
      ownerUserIds: normalizeOwnerUserIds(result),
      notFoundMessage: "Recurso no encontrado.",
      forbiddenMessage: "No tienes permisos para acceder a este recurso.",
    };
  }

  return {
    exists: result.exists !== false,
    ownerUserIds: normalizeOwnerUserIds(result.ownerUserIds),
    notFoundMessage: String(result.notFoundMessage || "Recurso no encontrado."),
    forbiddenMessage: String(
      result.forbiddenMessage || "No tienes permisos para acceder a este recurso."
    ),
  };
}

function writeAccessControlError(res, error) {
  const status = Number(error?.statusCode || error?.status || 500);
  return res.status(status).json({
    success: false,
    message:
      status >= 500
        ? "Error interno verificando permisos."
        : String(error?.message || "No tienes permisos para realizar esta accion."),
  });
}

async function getAccessActor(req) {
  if (req.accessControl?.actor) {
    return req.accessControl.actor;
  }

  const usuarioid = toPositiveInt(req.user?.usuarioid);
  if (!usuarioid) {
    const err = new Error("Usuario autenticado invalido.");
    err.statusCode = 401;
    throw err;
  }

  const result = await pool.query(
    `SELECT usuarioid, rolid, email, activo
     FROM usuario
     WHERE usuarioid = $1
     LIMIT 1`,
    [usuarioid]
  );

  if (!result.rows.length) {
    const err = new Error("Usuario autenticado no encontrado.");
    err.statusCode = 404;
    throw err;
  }

  const row = result.rows[0];
  if (!Boolean(row.activo)) {
    const err = new Error("Usuario inactivo.");
    err.statusCode = 403;
    throw err;
  }

  const actor = {
    usuarioid: Number(row.usuarioid),
    roleId: Number(row.rolid || 0),
    email: String(row.email || "").trim(),
  };

  req.accessControl = req.accessControl || {};
  req.accessControl.actor = actor;
  return actor;
}

function requireRole(...allowedRoleIds) {
  const roleSet = new Set(
    allowedRoleIds.map((value) => toPositiveInt(value)).filter((value) => value > 0)
  );

  return async function requireRoleMiddleware(req, res, next) {
    try {
      const actor = await getAccessActor(req);
      if (roleSet.has(actor.roleId)) {
        return next();
      }

      return res.status(403).json({
        success: false,
        message: "No tienes permisos para acceder a este endpoint.",
      });
    } catch (error) {
      return writeAccessControlError(res, error);
    }
  };
}

function requireOwnership(resolveOwnership, options = {}) {
  const allowRoles = Array.isArray(options.allowRoles)
    ? options.allowRoles.map((value) => toPositiveInt(value)).filter((value) => value > 0)
    : [];
  const allowRoleSet = new Set(allowRoles);

  return async function requireOwnershipMiddleware(req, res, next) {
    try {
      const actor = await getAccessActor(req);
      if (allowRoleSet.has(actor.roleId)) {
        return next();
      }

      const ownershipResult = normalizeOwnershipResult(
        await resolveOwnership(req, actor)
      );

      if (!ownershipResult.exists) {
        return res.status(404).json({
          success: false,
          message: ownershipResult.notFoundMessage,
        });
      }

      if (ownershipResult.ownerUserIds.includes(actor.usuarioid)) {
        req.accessControl = req.accessControl || {};
        req.accessControl.ownership = ownershipResult;
        return next();
      }

      return res.status(403).json({
        success: false,
        message: ownershipResult.forbiddenMessage,
      });
    } catch (error) {
      return writeAccessControlError(res, error);
    }
  };
}

module.exports = {
  ADMIN_ROLE_ID,
  MEDICO_ROLE_ID,
  PACIENTE_ROLE_ID,
  getAccessActor,
  requireRole,
  requireOwnership,
};
