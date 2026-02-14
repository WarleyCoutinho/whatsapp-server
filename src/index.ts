import Fastify from "fastify";

const app = Fastify({ logger: true });

// Health check registrado ANTES de qualquer import pesado
app.get("/health", async () => {
  return { status: "ok", uptime: process.uptime() };
});

// Carrega rotas (inclui imports de whatsapp/baileys)
try {
  const { registerRoutes } = await import("./routes.js");
  await registerRoutes(app);
  console.log("[WhatsApp Server] Rotas registradas com sucesso");
} catch (error) {
  console.error("[WhatsApp Server] ERRO ao registrar rotas:", error);
}

const port = Number(process.env.PORT) || 3001;
const host = "0.0.0.0";

console.log(`[WhatsApp Server] Iniciando na porta ${port}...`);

try {
  await app.listen({ port, host });
  console.log(`[WhatsApp Server] Rodando em http://${host}:${port}`);
} catch (err) {
  console.error("[WhatsApp Server] ERRO FATAL ao iniciar:", err);
  process.exit(1);
}
