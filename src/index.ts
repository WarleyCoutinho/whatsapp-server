// Validate required environment variables before anything else
if (!process.env.API_KEY) {
  console.error("[FATAL] Missing required environment variable: API_KEY");
  process.exit(1);
}

import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";

const app = Fastify({
  logger: true,
  bodyLimit: 65536,
});

// Security plugins
await app.register(helmet, { contentSecurityPolicy: false });

await app.register(cors, {
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",")
    : false,
  methods: ["GET", "POST"],
});

await app.register(rateLimit, {
  max: 30,
  timeWindow: "1 minute",
  keyGenerator: (request) => {
    return (request.headers["x-forwarded-for"] as string) || request.ip;
  },
});

// Custom error handler — never leak stack traces
app.setErrorHandler(
  (error: Error & { statusCode?: number }, _request, reply) => {
    app.log.error(error);
    const statusCode = error.statusCode ?? 500;
    reply.status(statusCode).send({
      error: statusCode >= 500 ? "Internal Server Error" : error.message,
    });
  },
);

// Health check registered BEFORE heavy imports
app.get("/health", async () => {
  return { status: "ok", uptime: process.uptime() };
});

// Load routes (includes baileys imports)
try {
  const { registerRoutes } = await import("./routes.js");
  await registerRoutes(app);
} catch (error) {
  console.error("[WhatsApp Server] FATAL: Failed to register routes:", error);
  process.exit(1);
}

const port = Number(process.env.PORT);
const host = "0.0.0.0";

try {
  await app.listen({ port, host });
  console.log(`[WhatsApp Server] Running on http://${host}:${port}`);
} catch (err) {
  console.error("[WhatsApp Server] FATAL:", err);
  process.exit(1);
}

// Graceful shutdown
const shutdown = async (signal: string) => {
  console.log(`[WhatsApp Server] ${signal} received, shutting down...`);
  try {
    await app.close();
    const { disconnectAll } = await import("./whatsapp.js");
    await disconnectAll();
  } catch (err) {
    console.error("[WhatsApp Server] Shutdown error:", err);
  }
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
