import type { FastifyInstance } from "fastify";
import {
  connectProfessional,
  disconnectProfessional,
  getConnectionStatus,
  getQRDataUrl,
  sendGroupMessage,
} from "./whatsapp.js";

export async function registerRoutes(app: FastifyInstance) {
  const apiKey = process.env.API_KEY;

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") return;

    if (apiKey && request.headers["x-api-key"] !== apiKey) {
      reply.status(401).send({ error: "Unauthorized" });
    }
  });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  app.post<{ Params: { professionalId: string } }>(
    "/connect/:professionalId",
    async (request) => {
      const { professionalId } = request.params;
      const result = await connectProfessional(professionalId);
      return result;
    },
  );

  app.get<{ Params: { professionalId: string } }>(
    "/status/:professionalId",
    async (request) => {
      const { professionalId } = request.params;
      const status = getConnectionStatus(professionalId);
      const qrCode = getQRDataUrl(professionalId);
      return { status, qrCode };
    },
  );

  app.post<{ Params: { professionalId: string } }>(
    "/disconnect/:professionalId",
    async (request) => {
      const { professionalId } = request.params;
      await disconnectProfessional(professionalId);
      return { status: "disconnected" };
    },
  );

  app.post<{
    Body: { professionalId: string; groupName: string; message: string };
  }>("/send-message", async (request, reply) => {
    const { professionalId, groupName, message } = request.body;

    if (!professionalId || !groupName || !message) {
      reply.status(400).send({ error: "Missing required fields" });
      return;
    }

    const success = await sendGroupMessage(professionalId, groupName, message);
    return { success };
  });
}
