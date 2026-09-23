const express = require("express");
const multer = require("multer");
const { rateLimit } = require("express-rate-limit");
const {
  MAX_BYTES,
  uuid,
  sendSchema,
  fail,
  abortCode,
  publicError,
  boundedHistory,
  answerSchema,
  AssistantError,
} = require("../services/patient-assistant/contracts");
const {
  validateFile,
  validateAudio,
  verifiedExtraction,
} = require("../services/patient-assistant/files");

function createAssistantRouter({
  store,
  provider,
  authenticate,
  patientOnly,
  log = (entry) => console.error(JSON.stringify(entry)),
  deadlineMs = 90000,
}) {
  const router = express.Router();
  const operations = new Map();
  // Local failures (database, callbacks) must not look like provider errors. No content is logged.
  const internal = (operation) => {
    try {
      log({ event: "assistant_internal_error", operation });
    } catch {
      /* Diagnostics must not alter the request outcome. */
    }
  };
  const interrupted = () => new AssistantError("interrupted", 409);
  const upload = multer({
    storage: multer.memoryStorage(),
    // Browsers send UTF-8 filenames; busboy's default latin1 would corrupt accents.
    defParamCharset: "utf8",
    limits: { fileSize: MAX_BYTES, files: 1, fields: 0, parts: 1 },
  });
  router.use(authenticate, patientOnly);
  router.use(
    rateLimit({
      windowMs: 60000,
      limit: 120,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) =>
        String(req.accessControl?.actor?.usuarioid ?? req.user.usuarioid),
      message: {
        code: "quota",
        message: "Demasiadas solicitudes. Espera un minuto antes de continuar.",
      },
    }),
  );
  router.use(express.json({ limit: "32kb" }));
  const uid = (req) =>
    req.accessControl?.actor?.usuarioid ?? req.user.usuarioid;
  const route = (handler) => (req, res, next) =>
    Promise.resolve(handler(req, res)).catch(next);
  router.param("conversationId", (req, res, next, id) =>
    uuid.safeParse(id).success
      ? next()
      : next(Object.assign(new Error(), { code: "bad_id" })),
  );
  router.param("id", (req, res, next, id) =>
    uuid.safeParse(id).success
      ? next()
      : next(Object.assign(new Error(), { code: "bad_id" })),
  );
  function operation(id, conversationId, onCheck) {
    const controller = new AbortController();
    const deadline = setTimeout(
      () => controller.abort(new AssistantError("provider_timeout", 504)),
      deadlineMs,
    );
    let checking = false;
    const poll = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        if (!(await onCheck())) controller.abort(interrupted());
      } catch {
        internal("status_check");
        controller.abort(interrupted());
      } finally {
        checking = false;
      }
    }, 750);
    operations.set(id, { conversationId, controller });
    return {
      signal: controller.signal,
      abort: () => controller.abort(interrupted()),
      done() {
        clearTimeout(deadline);
        clearInterval(poll);
        operations.delete(id);
      },
    };
  }
  router.get(
    "/conversation",
    route(async (req, res) =>
      res.json({ conversation: await store.conversation(uid(req)) }),
    ),
  );
  router.post(
    "/conversation",
    route(async (req, res) =>
      res.json({ conversation: await store.conversation(uid(req), true) }),
    ),
  );
  router.delete(
    "/conversations/:conversationId",
    route(async (req, res) => {
      await store.deleteConversation(uid(req), req.params.conversationId);
      for (const op of operations.values())
        if (op.conversationId === req.params.conversationId)
          op.controller.abort();
      res.json({ success: true });
    }),
  );
  router.post(
    "/conversations/:conversationId/documents",
    route(async (req, res) => {
      await store.assertOwner(uid(req), req.params.conversationId);
      provider.available("extract");
      await new Promise((resolve, reject) =>
        upload.single("file")(req, res, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
      if (!req.file) fail("invalid_file");
      const validated = await validateFile(req.file.buffer);
      const document = await store.addDocument(
        uid(req),
        req.params.conversationId,
        req.file,
        validated.mime,
      );
      const op = operation(document.id, req.params.conversationId, async () => {
        const doc = await store.document(
          uid(req),
          req.params.conversationId,
          document.id,
        );
        return doc.status === "reading";
      });
      const bytes = req.file.buffer;
      // Every rejection is handled; no clinical content is logged.
      void (async () => {
        try {
          const raw = await provider.extract({
            bytes,
            ...validated,
            signal: op.signal,
          });
          if (op.signal.aborted) fail(abortCode(op.signal), 409);
          const result = verifiedExtraction(raw, validated.pages);
          await store.finishDocument(document.id, result);
        } catch (error) {
          const aborted = op.signal.aborted;
          if (!aborted && !(error instanceof AssistantError)) internal("extract");
          await store.finishDocument(
            document.id,
            null,
            aborted ? abortCode(op.signal) : publicError(error).code,
          );
        } finally {
          bytes.fill(0);
          op.done();
        }
      })().catch(() => {});
      res.status(202).json({ document });
    }),
  );
  router.get(
    "/conversations/:conversationId/documents/:id",
    route(async (req, res) => {
      res.json({
        document: await store.document(
          uid(req),
          req.params.conversationId,
          req.params.id,
        ),
      });
    }),
  );
  router.delete(
    "/conversations/:conversationId/documents/:id",
    route(async (req, res) => {
      await store.document(uid(req), req.params.conversationId, req.params.id);
      await store.deleteDocument(
        uid(req),
        req.params.conversationId,
        req.params.id,
      );
      operations.get(req.params.id)?.controller.abort();
      res.json({ success: true });
    }),
  );
  router.get(
    "/conversations/:conversationId/messages/:id",
    route(async (req, res) => {
      res.json({
        message: await store.message(
          uid(req),
          req.params.conversationId,
          req.params.id,
        ),
      });
    }),
  );
  router.post(
    "/conversations/:conversationId/messages/:id/stop",
    route(async (req, res) => {
      await store.message(uid(req), req.params.conversationId, req.params.id);
      await store.stop(uid(req), req.params.conversationId, req.params.id);
      operations.get(req.params.id)?.controller.abort();
      res.json({ success: true });
    }),
  );
  router.post(
    "/conversations/:conversationId/messages",
    route(async (req, res) => {
      const parsed = sendSchema.safeParse(req.body);
      if (!parsed.success) fail("invalid_request");
      provider.available("answer");
      const state = await store.beginMessage(
        uid(req),
        req.params.conversationId,
        parsed.data,
      );
      res.set({
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      const emit = (type, data) => {
        if (!res.destroyed && !res.writableEnded)
          res.write(JSON.stringify({ type, ...data }) + "\n");
      };
      emit("status", { message: state.message });
      if (state.replay) {
        // A repeated requestId reports the stored outcome, including failures.
        const { status, error_code } = state.message;
        if (status === "error" || status === "stopped")
          emit("error", {
            code: error_code || (status === "stopped" ? "interrupted" : "provider_error"),
            message: state.message,
          });
        else emit("done", { message: state.message });
        res.end();
        return;
      }
      const op = operation(state.message.id, req.params.conversationId, () =>
        store.isRunning(state.message.id),
      );
      const onClose = () => {
        if (!res.writableEnded) op.abort();
      };
      res.on("close", onClose);
      let lastSave = 0,
        partial = "";
      try {
        const result = await provider.answer({
          question: state.message.question,
          documents: state.documents.map((d) => ({
            id: d.id,
            ...d.extraction,
          })),
          history: boundedHistory(state.history),
          signal: op.signal,
          onSummary: async (text) => {
            if (op.signal.aborted) fail("interrupted", 409);
            partial = text.slice(0, 6000);
            emit("content", { text: partial });
            if (Date.now() - lastSave > 500) {
              await store.partial(state.message.id, partial);
              lastSave = Date.now();
            }
          },
        });
        if (op.signal.aborted) fail("interrupted", 409);
        const answer = answerSchema.parse(result);
        await store.partial(state.message.id, answer.summary);
        const message = await store.finishMessage(
          state.message.id,
          "completed",
          answer,
        );
        // A simultaneous stop/delete wins over the provider result.
        emit("done", {
          message:
            message ||
            (await store.message(
              uid(req),
              req.params.conversationId,
              state.message.id,
            )),
        });
      } catch (error) {
        await store.partial(state.message.id, partial);
        const aborted = op.signal.aborted;
        if (!aborted && !(error instanceof AssistantError)) internal("answer");
        const code = aborted ? abortCode(op.signal) : publicError(error).code;
        // Only a patient stop, disconnect or deletion is "stopped"; the deadline is a failure.
        const status = code === "interrupted" ? "stopped" : "error";
        const message = await store.finishMessage(
          state.message.id,
          status,
          null,
          code,
        );
        emit("error", {
          code,
          message: message || { ...state.message, status: "stopped", partial },
        });
      } finally {
        op.done();
        res.off("close", onClose);
        res.end();
      }
    }),
  );
  router.post(
    "/transcriptions",
    route(async (req, res) => {
      provider.available("transcribe");
      await new Promise((resolve, reject) =>
        upload.single("audio")(req, res, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
      if (!req.file) fail("invalid_audio");
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new AssistantError("provider_timeout", 504)),
        60000,
      );
      const close = () => {
        if (!res.writableEnded) controller.abort(interrupted());
      };
      res.on("close", close);
      try {
        const audio = await validateAudio(req.file.buffer);
        await store.reserveTranscription(uid(req));
        res.json({
          text: await provider.transcribe({
            bytes: req.file.buffer,
            ...audio,
            signal: controller.signal,
          }),
        });
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw error;
      } finally {
        req.file.buffer.fill(0);
        clearTimeout(timer);
        res.off("close", close);
      }
    }),
  );
  router.use((error, req, res, next) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof multer.MulterError) {
      res
        .status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
        .json({
          code: "invalid_file",
          message:
            error.code === "LIMIT_FILE_SIZE"
              ? "El archivo supera el límite de 10 MiB."
              : "Adjunta un solo archivo válido.",
        });
      return;
    }
    if (error.code === "bad_id") {
      res
        .status(400)
        .json({ code: "invalid_request", message: "Identificador inválido." });
      return;
    }
    if (
      error.type === "entity.parse.failed" ||
      error.type === "entity.too.large"
    ) {
      res
        .status(error.type === "entity.too.large" ? 413 : 400)
        .json({
          code: "invalid_request",
          message:
            "El mensaje enviado no es válido o supera el tamaño permitido.",
        });
      return;
    }
    if (!(error instanceof AssistantError)) internal("request");
    const safe = publicError(error);
    res.status(safe.status).json({ code: safe.code, message: safe.message });
  });
  return router;
}
module.exports = { createAssistantRouter };
