const { randomUUID, createHash } = require("node:crypto");
const { fail } = require("./contracts");

function createStore(pool) {
  async function transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async function owner(client, userId, conversationId, lock = false) {
    // Serializes quota reservations, deletion and document/message mutations for this owner.
    if (lock)
      await client.query(
        "SELECT usuarioid FROM usuario WHERE usuarioid=$1 FOR UPDATE",
        [userId],
      );
    const { rows } = await client.query(
      "SELECT * FROM assistant_conversation WHERE id=$1 AND usuarioid=$2 AND expires_at>NOW()",
      [conversationId, userId],
    );
    if (!rows.length) fail("not_found", 404);
    return rows[0];
  }
  async function quota(client, userId, kind) {
    const limit = { messages: 30, documents: 10, transcriptions: 30 }[kind];
    if (!limit) throw new Error("Invalid quota kind");
    const { rows } = await client.query(
      `INSERT INTO assistant_usage (usuarioid, day, ${kind})
      VALUES ($1, (NOW() AT TIME ZONE 'UTC')::date, 1)
      ON CONFLICT (usuarioid, day) DO UPDATE SET ${kind}=assistant_usage.${kind}+1
      WHERE assistant_usage.${kind}<$2 RETURNING ${kind}`,
      [userId, limit],
    );
    if (!rows.length) fail("quota", 429);
  }
  async function recover(client, conversationId) {
    await client.query(
      `UPDATE assistant_message SET status='error', error_code='interrupted'
      WHERE conversation_id=$1 AND status='running' AND created_at<NOW()-INTERVAL '2 minutes'`,
      [conversationId],
    );
    await client.query(
      `UPDATE assistant_document SET status='error', error_code='interrupted', bytes=NULL
      WHERE conversation_id=$1 AND status='reading' AND created_at<NOW()-INTERVAL '2 minutes'`,
      [conversationId],
    );
  }
  const api = {
    async conversation(userId, create = false) {
      return transaction(async (client) => {
        await client.query(
          "SELECT usuarioid FROM usuario WHERE usuarioid=$1 FOR UPDATE",
          [userId],
        );
        await client.query(
          "DELETE FROM assistant_conversation WHERE usuarioid=$1 AND expires_at<=NOW()",
          [userId],
        );
        let { rows } = await client.query(
          "SELECT * FROM assistant_conversation WHERE usuarioid=$1",
          [userId],
        );
        if (!rows.length && create) {
          ({ rows } = await client.query(
            "INSERT INTO assistant_conversation(id,usuarioid) VALUES($1,$2) RETURNING *",
            [randomUUID(), userId],
          ));
        }
        if (!rows.length) return null;
        const conversation = rows[0];
        await recover(client, conversation.id);
        const documents = await client.query(
          "SELECT id,name,mime,status,extraction,error_code FROM assistant_document WHERE conversation_id=$1 ORDER BY created_at",
          [conversation.id],
        );
        const messages = await client.query(
          "SELECT * FROM (SELECT * FROM assistant_message WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 100) recent ORDER BY created_at",
          [conversation.id],
        );
        return {
          ...conversation,
          documents: documents.rows,
          messages: messages.rows,
        };
      });
    },
    async assertOwner(userId, id) {
      return owner(pool, userId, id);
    },
    async deleteConversation(userId, id) {
      return transaction(async (client) => {
        await owner(client, userId, id, true);
        await client.query("DELETE FROM assistant_conversation WHERE id=$1", [
          id,
        ]);
      });
    },
    async addDocument(userId, id, file, mime) {
      return transaction(async (client) => {
        await owner(client, userId, id, true);
        const count = await client.query(
          "SELECT COUNT(*)::int AS count FROM assistant_document WHERE conversation_id=$1",
          [id],
        );
        if (count.rows[0].count >= 5) fail("document_limit", 409);
        await quota(client, userId, "documents");
        const result = await client.query(
          `INSERT INTO assistant_document(id,conversation_id,name,mime,bytes,status)
          VALUES($1,$2,$3,$4,$5,'reading') RETURNING id,name,mime,status`,
          [
            randomUUID(),
            id,
            file.originalname.slice(0, 180).replace(/[\x00-\x1f]/g, ""),
            mime,
            file.buffer,
          ],
        );
        return result.rows[0];
      });
    },
    async finishDocument(id, extraction, code) {
      await pool.query(
        `UPDATE assistant_document SET status=$2,extraction=$3,error_code=$4,bytes=CASE WHEN $4::text IS NULL THEN bytes ELSE NULL END
        WHERE id=$1 AND status='reading' AND EXISTS (SELECT 1 FROM assistant_conversation c WHERE c.id=conversation_id AND c.expires_at>NOW())`,
        [
          id,
          code ? "error" : "ready",
          extraction ? JSON.stringify(extraction) : null,
          code || null,
        ],
      );
    },
    async document(userId, conversationId, id) {
      await owner(pool, userId, conversationId);
      const { rows } = await pool.query(
        "SELECT id,name,mime,status,extraction,error_code FROM assistant_document WHERE id=$1 AND conversation_id=$2",
        [id, conversationId],
      );
      if (!rows.length) fail("not_found", 404);
      return rows[0];
    },
    async deleteDocument(userId, conversationId, id) {
      await transaction(async (client) => {
        await owner(client, userId, conversationId, true);
        const active = await client.query(
          "SELECT id FROM assistant_message WHERE conversation_id=$1 AND status='running'",
          [conversationId],
        );
        if (active.rows.length) fail("busy", 409);
        const removed = await client.query(
          "DELETE FROM assistant_document WHERE id=$1 AND conversation_id=$2 RETURNING id,status",
          [id, conversationId],
        );
        if (!removed.rows.length) fail("not_found", 404);
        // Remove derived answers too: a deleted report must not survive through message history.
        // Messages can only use ready documents, so failed or pending reads keep the thread.
        if (removed.rows[0].status === "ready")
          await client.query(
            "DELETE FROM assistant_message WHERE conversation_id=$1",
            [conversationId],
          );
      });
    },
    async beginMessage(userId, conversationId, input) {
      return transaction(async (client) => {
        await owner(client, userId, conversationId, true);
        await recover(client, conversationId);
        const ids = [...new Set(input.documentIds)].sort();
        const question =
          input.question ||
          "Explícame este informe de forma general y sencilla.";
        const hash = createHash("sha256")
          .update(JSON.stringify({ question, ids }))
          .digest("hex");
        const prior = await client.query(
          "SELECT * FROM assistant_message WHERE conversation_id=$1 AND request_id=$2",
          [conversationId, input.requestId],
        );
        if (prior.rows.length) {
          const message = prior.rows[0];
          if (message.request_hash !== hash) fail("conflict", 409);
          return { message, replay: true };
        }
        const active = await client.query(
          "SELECT id FROM assistant_message WHERE conversation_id=$1 AND status='running'",
          [conversationId],
        );
        if (active.rows.length) fail("busy", 409);
        const documents = await client.query(
          "SELECT id,extraction,status FROM assistant_document WHERE conversation_id=$1 AND id=ANY($2::uuid[])",
          [conversationId, ids],
        );
        if (documents.rows.length !== ids.length) fail("not_found", 404);
        if (documents.rows.some((d) => d.status !== "ready"))
          fail("not_ready", 409);
        await quota(client, userId, "messages");
        const history = await client.query(
          "SELECT * FROM (SELECT * FROM assistant_message WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 12) h ORDER BY created_at",
          [conversationId],
        );
        const { rows } = await client.query(
          `INSERT INTO assistant_message(id,conversation_id,request_id,request_hash,question,document_ids,status)
          VALUES($1,$2,$3,$4,$5,$6,'running') RETURNING *`,
          [
            randomUUID(),
            conversationId,
            input.requestId,
            hash,
            question,
            JSON.stringify(ids),
          ],
        );
        return {
          message: rows[0],
          documents: documents.rows,
          history: history.rows,
          replay: false,
        };
      });
    },
    async message(userId, conversationId, id) {
      await owner(pool, userId, conversationId);
      const { rows } = await pool.query(
        "SELECT * FROM assistant_message WHERE id=$1 AND conversation_id=$2",
        [id, conversationId],
      );
      if (!rows.length) fail("not_found", 404);
      return rows[0];
    },
    async isRunning(id) {
      const { rows } = await pool.query(
        `SELECT m.id FROM assistant_message m JOIN assistant_conversation c ON c.id=m.conversation_id
        WHERE m.id=$1 AND m.status='running' AND c.expires_at>NOW()`,
        [id],
      );
      return rows.length > 0;
    },
    async partial(id, text) {
      await pool.query(
        "UPDATE assistant_message SET partial=$2 WHERE id=$1 AND status='running'",
        [id, text.slice(0, 6000)],
      );
    },
    async finishMessage(id, status, answer, code) {
      const { rows } = await pool.query(
        `UPDATE assistant_message SET status=$2,answer=$3,error_code=$4
        WHERE id=$1 AND status='running' AND EXISTS (SELECT 1 FROM assistant_conversation c WHERE c.id=conversation_id AND c.expires_at>NOW()) RETURNING *`,
        [id, status, answer ? JSON.stringify(answer) : null, code || null],
      );
      return rows[0];
    },
    async stop(userId, conversationId, id) {
      await owner(pool, userId, conversationId);
      await pool.query(
        "UPDATE assistant_message SET status='stopped' WHERE id=$1 AND conversation_id=$2 AND status='running'",
        [id, conversationId],
      );
    },
    async reserveTranscription(userId) {
      await transaction(async (client) => {
        await client.query(
          "SELECT usuarioid FROM usuario WHERE usuarioid=$1 FOR UPDATE",
          [userId],
        );
        await quota(client, userId, "transcriptions");
      });
    },
    async cleanup() {
      await transaction(async (client) => {
        const { rows } = await client.query(
          "SELECT pg_try_advisory_xact_lock(867473, 2022) AS locked",
        );
        if (!rows[0].locked) return;
        await client.query(
          "DELETE FROM assistant_conversation WHERE expires_at<=NOW()",
        );
        await client.query(
          "DELETE FROM assistant_usage WHERE day<(NOW() AT TIME ZONE 'UTC')::date-31",
        );
      });
    },
  };
  return api;
}
module.exports = { createStore };
