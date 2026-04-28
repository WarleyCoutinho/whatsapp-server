import { timingSafeEqual } from "crypto";
import type { FastifyInstance } from "fastify";
import {
  connectProfessional,
  connectWithPhone,
  disconnectProfessional,
  getActiveConnectionCount,
  getConnectionStatus,
  getPairingCode,
  getQRDataUrl,
  isAtConnectionLimit,
  sendGroupMessage,
} from "./whatsapp.js";

const UUID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

const professionalIdSchema = {
  type: "object" as const,
  required: ["professionalId"] as const,
  properties: {
    professionalId: { type: "string" as const, pattern: UUID_PATTERN },
  },
};

export async function registerRoutes(app: FastifyInstance) {
  const apiKey = process.env.API_KEY;

  if (!apiKey) {
    app.log.error("FATAL: API_KEY is not set. All requests will be rejected.");
  }

  // Auth guard
  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions?.url === "/health") return;
    if (request.routeOptions?.url === "/connections/stats") return;

    if (!apiKey) {
      return reply.status(503).send({ error: "Server misconfigured" });
    }

    const provided = request.headers["x-api-key"];

    if (typeof provided !== "string" || provided.length !== apiKey.length) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const isValid = timingSafeEqual(Buffer.from(provided), Buffer.from(apiKey));

    if (!isValid) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
  });

  // ------------------------------------------------------------------
  // Stats — útil para monitorar no Railway
  // ------------------------------------------------------------------

  app.get("/connections/stats", async () => {
    return {
      active: getActiveConnectionCount(),
      limit: 100,
      atLimit: isAtConnectionLimit(),
    };
  });

  // ------------------------------------------------------------------
  // Connect via QR Code
  // ------------------------------------------------------------------

  app.post<{ Params: { professionalId: string } }>(
    "/connect/:professionalId",
    { schema: { params: professionalIdSchema } },
    async (request, reply) => {
      if (isAtConnectionLimit()) {
        return reply.status(503).send({
          error: "Limite de conexões atingido",
          message:
            "O servidor atingiu o máximo de 100 conexões simultâneas. " +
            "Tente novamente mais tarde ou entre em contato com o suporte.",
          active: getActiveConnectionCount(),
          limit: 100,
        });
      }

      const { professionalId } = request.params;
      return connectProfessional(professionalId);
    },
  );

  // ------------------------------------------------------------------
  // Connect via número de telefone (pairing code)
  // ------------------------------------------------------------------

  app.post<{
    Params: { professionalId: string };
    Body: { phoneNumber: string };
  }>(
    "/connect-phone/:professionalId",
    {
      schema: {
        params: professionalIdSchema,
        body: {
          type: "object" as const,
          required: ["phoneNumber"] as const,
          properties: {
            phoneNumber: {
              type: "string" as const,
              minLength: 10,
              maxLength: 20,
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (isAtConnectionLimit()) {
        return reply.status(503).send({
          error: "Limite de conexões atingido",
          message:
            "O servidor atingiu o máximo de 100 conexões simultâneas. " +
            "Tente novamente mais tarde ou entre em contato com o suporte.",
          active: getActiveConnectionCount(),
          limit: 100,
        });
      }

      const { professionalId } = request.params;
      const { phoneNumber } = request.body;
      return connectWithPhone(professionalId, phoneNumber);
    },
  );

  // ------------------------------------------------------------------
  // Status
  // ------------------------------------------------------------------

  app.get<{ Params: { professionalId: string } }>(
    "/status/:professionalId",
    { schema: { params: professionalIdSchema } },
    async (request) => {
      const { professionalId } = request.params;
      const status = getConnectionStatus(professionalId);
      const qrCode = getQRDataUrl(professionalId);
      const pairingCode = getPairingCode(professionalId);
      return { status, qrCode, pairingCode };
    },
  );

  // ------------------------------------------------------------------
  // Disconnect
  // ------------------------------------------------------------------

  app.post<{ Params: { professionalId: string } }>(
    "/disconnect/:professionalId",
    { schema: { params: professionalIdSchema } },
    async (request) => {
      const { professionalId } = request.params;
      await disconnectProfessional(professionalId);
      return { status: "disconnected" };
    },
  );

  // ------------------------------------------------------------------
  // Send message to group
  // ------------------------------------------------------------------

  app.post<{
    Body: { professionalId: string; groupName: string; message: string };
  }>(
    "/send-message",
    {
      schema: {
        body: {
          type: "object" as const,
          required: ["professionalId", "groupName", "message"] as const,
          properties: {
            professionalId: {
              type: "string" as const,
              pattern: UUID_PATTERN,
            },
            groupName: {
              type: "string" as const,
              minLength: 1,
              maxLength: 200,
            },
            message: {
              type: "string" as const,
              minLength: 1,
              maxLength: 5000,
            },
          },
        },
      },
    },
    async (request) => {
      const { professionalId, groupName, message } = request.body;
      const success = await sendGroupMessage(
        professionalId,
        groupName,
        message,
      );
      return { success };
    },
  );
}
