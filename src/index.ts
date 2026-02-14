import Fastify from "fastify";
import { registerRoutes } from "./routes.js";

const app = Fastify({ logger: true });

await registerRoutes(app);

const port = Number(process.env.PORT) || 3001;
const host = process.env.HOST || "0.0.0.0";

try {
  await app.listen({ port, host });
  console.log(`[WhatsApp Server] Rodando em http://${host}:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
