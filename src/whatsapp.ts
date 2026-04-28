import fs from "fs/promises";
import { HttpsProxyAgent } from "https-proxy-agent";
import path from "path";
import { fileURLToPath } from "url";
import QRCode from "qrcode";

import type { WASocket, ConnectionState } from "@whiskeysockets/baileys";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ConnectionStatus = "disconnected" | "connecting" | "qr_code" | "connected";

type BaileysError = {
  output?: {
    statusCode?: number;
  };
};

interface ProfessionalConnection {
  socket: WASocket | null;
  status: ConnectionStatus;
  qrCode: string | null;
  qrDataUrl: string | null;
  pairingCode: string | null;
  retryCount: number;
  connectPromise: Promise<void> | null;
  lastActivity: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** Proxy URL fixo assignado a este profissional */
  proxyUrl: string | null;
  /** Timestamp do último ping bem-sucedido (health check) */
  lastPing: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * AUTH_DIR pode ser sobrescrito via env para apontar para o volume do Railway.
 * Padrão: ../whatsapp-auth relativo ao dist/
 */
const AUTH_BASE_DIR =
  process.env.AUTH_DIR ?? path.join(__dirname, "..", "whatsapp-auth");

/** Máximo de conexões simultâneas */
const MAX_CONNECTIONS = 100;

/** Conexões inativas por mais de 30 min são removidas da memória */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Máximo de tentativas de reconexão antes de desistir */
const MAX_RETRIES = 8;

/**
 * Backoff exponencial com jitter.
 * retry 0 → 2s, 1 → 4s, 2 → 8s, 3 → 16s, 4 → 30s, 5-7 → 30s (cap)
 * O jitter (±20%) evita thundering herd quando vários profissionais
 * reconectam ao mesmo tempo após uma queda do servidor.
 */
function getRetryDelay(retryCount: number): number {
  const base = Math.min(2000 * Math.pow(2, retryCount), 30_000);
  const jitter = base * 0.2 * (Math.random() * 2 - 1); // ±20%
  return Math.round(base + jitter);
}

/** Intervalo do health check (ping) — 2 minutos */
const HEALTH_CHECK_INTERVAL_MS = 2 * 60 * 1000;

/** Se o último ping foi há mais de 5 min, a sessão é considerada zumbi */
const ZOMBIE_THRESHOLD_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Proxy pool
// ---------------------------------------------------------------------------

/**
 * Pool de proxies carregado da env PROXY_POOL.
 * Formato: "http://u:p@ip1:port,http://u:p@ip2:port,..."
 *
 * Cada profissional recebe um proxy FIXO e DETERMINÍSTICO via hash do UUID,
 * garantindo que o WhatsApp sempre veja o mesmo IP para aquela sessão.
 * Isso elimina o alerta "Suspeita de golpe".
 */
const proxyPool: string[] = (process.env.PROXY_POOL ?? "")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

if (proxyPool.length === 0) {
  console.warn(
    "[WA:proxy] AVISO: PROXY_POOL não configurado. " +
      "Conexões usarão o IP do servidor (risco de alerta 'Suspeita de golpe'). " +
      "Configure PROXY_POOL=http://u:p@ip-br:port,... para produção.",
  );
} else {
  console.log(`[WA:proxy] Pool carregado com ${proxyPool.length} proxy(s).`);
}

/**
 * Retorna o proxy fixo para um profissional dado seu UUID.
 * Usa uma soma simples dos char codes como hash determinístico —
 * leve, sem dependências, suficiente para distribuição uniforme.
 */
function getProxyForProfessional(professionalId: string): string | null {
  if (proxyPool.length === 0) return null;

  let hash = 0;
  for (let i = 0; i < professionalId.length; i++) {
    hash = (hash + professionalId.charCodeAt(i)) % proxyPool.length;
  }

  return proxyPool[hash] ?? null;
}

/** Verifica se há mais conexões ativas do que proxies disponíveis */
function checkProxyPoolWarning(): void {
  if (proxyPool.length === 0) return;

  const activeCount = Array.from(connections.values()).filter(
    (c) => c.status === "connected" || c.status === "connecting",
  ).length;

  if (activeCount > proxyPool.length) {
    console.warn(
      `[WA:proxy] AVISO: ${activeCount} conexões ativas mas apenas ` +
        `${proxyPool.length} proxy(s) disponíveis. ` +
        `Alguns profissionais estão compartilhando proxy — ` +
        `risco aumentado de alerta 'Suspeita de golpe'. ` +
        `Adicione mais proxies ao PROXY_POOL.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Connection map
// ---------------------------------------------------------------------------

const connections = new Map<string, ProfessionalConnection>();

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateProfessionalId(professionalId: string): void {
  if (!UUID_REGEX.test(professionalId)) {
    throw new Error("Invalid professional ID format");
  }
}

function getSafeAuthDir(professionalId: string): string {
  validateProfessionalId(professionalId);
  const authDir = path.join(AUTH_BASE_DIR, professionalId);
  const resolved = path.resolve(authDir);
  const base = path.resolve(AUTH_BASE_DIR);
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error("Path traversal detected");
  }
  return authDir;
}

function log(professionalId: string, msg: string): void {
  const short = professionalId.slice(0, 8);
  console.log(`[WA:${short}] ${msg}`);
}

function logError(professionalId: string, msg: string, err?: unknown): void {
  const short = professionalId.slice(0, 8);
  const detail = err instanceof Error ? err.message : String(err ?? "");
  console.error(`[WA:${short}] ${msg}${detail ? `: ${detail}` : ""}`);
}

function getConnection(professionalId: string): ProfessionalConnection {
  validateProfessionalId(professionalId);

  if (!connections.has(professionalId)) {
    if (connections.size >= MAX_CONNECTIONS) {
      throw new Error(
        `Limite de conexões atingido (máximo: ${MAX_CONNECTIONS}). ` +
          `Tente novamente mais tarde ou entre em contato com o suporte.`,
      );
    }

    connections.set(professionalId, {
      socket: null,
      status: "disconnected",
      qrCode: null,
      qrDataUrl: null,
      pairingCode: null,
      retryCount: 0,
      connectPromise: null,
      lastActivity: Date.now(),
      reconnectTimer: null,
      proxyUrl: getProxyForProfessional(professionalId),
      lastPing: Date.now(),
    });

    checkProxyPoolWarning();
  }

  const conn = connections.get(professionalId)!;
  conn.lastActivity = Date.now();
  return conn;
}

// ---------------------------------------------------------------------------
// Cleanup: idle disconnected connections (every 5 min)
// ---------------------------------------------------------------------------

setInterval(
  () => {
    const now = Date.now();
    for (const [id, conn] of connections.entries()) {
      if (
        conn.status === "disconnected" &&
        now - conn.lastActivity > IDLE_TIMEOUT_MS
      ) {
        if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
        connections.delete(id);
        log(id, "Sessão idle removida da memória.");
      }
    }
  },
  5 * 60 * 1000,
);

// ---------------------------------------------------------------------------
// Health check: detect zombie sessions (every 2 min)
// ---------------------------------------------------------------------------

setInterval(async () => {
  const now = Date.now();

  for (const [id, conn] of connections.entries()) {
    if (conn.status !== "connected" || !conn.socket) continue;

    const isZombie = now - conn.lastPing > ZOMBIE_THRESHOLD_MS;
    if (!isZombie) continue;

    log(id, "Sessão zumbi detectada (sem ping há 5+ min). Reconectando...");

    try {
      _cleanupSocket(conn);
      conn.status = "connecting";
      conn.retryCount = 0;
      await _createConnectedSocket(id, "qr");
    } catch (err) {
      logError(id, "Falha ao reconectar sessão zumbi", err);
      conn.status = "disconnected";
    }
  }
}, HEALTH_CHECK_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Internal: cleanup socket (preserves auth files for reconnect)
// ---------------------------------------------------------------------------

function _cleanupSocket(conn: ProfessionalConnection): void {
  if (conn.reconnectTimer) {
    clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = null;
  }
  if (conn.socket) {
    try {
      conn.socket.end(undefined);
    } catch {
      /* ignore */
    }
    conn.socket = null;
  }
  conn.qrCode = null;
  conn.qrDataUrl = null;
  conn.connectPromise = null;
}

// ---------------------------------------------------------------------------
// Internal: create Baileys socket
// ---------------------------------------------------------------------------

async function _createConnectedSocket(
  professionalId: string,
  mode: "qr" | "phone",
): Promise<void> {
  const conn = getConnection(professionalId);

  // Evita criar múltiplos sockets simultaneamente para o mesmo profissional
  if (conn.connectPromise) {
    return conn.connectPromise;
  }

  conn.status = "connecting";
  conn.qrCode = null;
  conn.qrDataUrl = null;

  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
  } = await import("@whiskeysockets/baileys");

  const authDir = getSafeAuthDir(professionalId);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  // Proxy fixo e determinístico para este profissional
  const agent = conn.proxyUrl ? new HttpsProxyAgent(conn.proxyUrl) : undefined;

  if (agent) {
    log(professionalId, `Usando proxy: ${conn.proxyUrl}`);
  }

  conn.connectPromise = (async () => {
    try {
      const socket: WASocket = makeWASocket({
        auth: state,
        version,
        printQRInTerminal:
          mode === "qr" && process.env.NODE_ENV !== "production",
        connectTimeoutMs: 60_000,
        qrTimeout: 60_000,
        keepAliveIntervalMs: 30_000,
        fetchAgent: agent,
        // Fingerprint de browser real para reduzir detecção
        browser: ["Ubuntu", "Chrome", "124.0.0.0"],
        ...(mode === "phone" ? { mobile: false } : {}),
      });

      conn.socket = socket;

      socket.ev.on("creds.update", saveCreds);

      socket.ev.on(
        "connection.update",
        async (update: Partial<ConnectionState>) => {
          const { connection, lastDisconnect, qr } = update;

          // QR gerado — profissional precisa escanear
          if (qr && mode === "qr") {
            conn.status = "qr_code";
            conn.qrCode = qr;
            conn.retryCount = 0;
            conn.lastPing = Date.now();
            try {
              conn.qrDataUrl = await QRCode.toDataURL(qr, {
                width: 256,
                margin: 2,
              });
            } catch {
              conn.qrDataUrl = null;
            }
            log(professionalId, "QR Code gerado, aguardando escaneamento.");
          }

          // Conexão estabelecida com sucesso
          if (connection === "open") {
            conn.status = "connected";
            conn.qrCode = null;
            conn.qrDataUrl = null;
            conn.pairingCode = null;
            conn.retryCount = 0;
            conn.connectPromise = null;
            conn.lastPing = Date.now();
            log(professionalId, "Conectado com sucesso.");
            checkProxyPoolWarning();
          }

          // Conexão encerrada — avaliar se deve reconectar
          if (connection === "close") {
            const statusCode = (lastDisconnect?.error as BaileysError)?.output
              ?.statusCode;

            const loggedOut = statusCode === DisconnectReason.loggedOut;
            const shouldReconnect = !loggedOut;

            log(
              professionalId,
              `Conexão encerrada. statusCode=${statusCode ?? "?"} loggedOut=${loggedOut}`,
            );

            _cleanupSocket(conn);

            if (shouldReconnect && conn.retryCount < MAX_RETRIES) {
              const delay = getRetryDelay(conn.retryCount);
              conn.retryCount++;
              conn.status = "connecting";

              log(
                professionalId,
                `Reconectando em ${delay}ms (tentativa ${conn.retryCount}/${MAX_RETRIES})...`,
              );

              conn.reconnectTimer = setTimeout(() => {
                conn.reconnectTimer = null;
                _createConnectedSocket(professionalId, mode).catch((err) => {
                  logError(professionalId, "Erro na reconexão automática", err);
                  conn.status = "disconnected";
                });
              }, delay);
            } else {
              conn.status = "disconnected";
              conn.retryCount = 0;

              if (loggedOut) {
                log(professionalId, "Profissional deslogou. Sessão encerrada.");
              } else {
                log(
                  professionalId,
                  `Máximo de tentativas (${MAX_RETRIES}) atingido. Sessão encerrada.`,
                );
              }
            }
          }
        },
      );

      // Atualiza lastPing a cada mensagem recebida (prova de vida)
      socket.ev.on("messages.upsert", () => {
        conn.lastPing = Date.now();
      });
    } catch (error) {
      conn.status = "disconnected";
      conn.connectPromise = null;
      conn.socket = null;
      logError(professionalId, "Erro ao criar socket", error);
    }
  })();

  return conn.connectPromise;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getConnectionStatus(professionalId: string): ConnectionStatus {
  return getConnection(professionalId).status;
}

export function getQRDataUrl(professionalId: string): string | null {
  return getConnection(professionalId).qrDataUrl;
}

export function getPairingCode(professionalId: string): string | null {
  return getConnection(professionalId).pairingCode;
}

/** Retorna quantas conexões estão ativas no momento */
export function getActiveConnectionCount(): number {
  return Array.from(connections.values()).filter(
    (c) => c.status === "connected" || c.status === "connecting",
  ).length;
}

/** Retorna true se o limite de conexões já foi atingido */
export function isAtConnectionLimit(): boolean {
  return connections.size >= MAX_CONNECTIONS;
}

export async function connectProfessional(
  professionalId: string,
): Promise<{ status: ConnectionStatus; qrCode: string | null }> {
  const conn = getConnection(professionalId);

  if (conn.status === "connected" && conn.socket) {
    log(professionalId, "Já conectado, retornando status atual.");
    return { status: "connected", qrCode: null };
  }

  // Destrói sessão anterior para gerar novo QR
  await disconnectProfessional(professionalId);

  // Guard: se já há uma promise em andamento, aguarda ela
  if (conn.connectPromise) {
    await conn.connectPromise;
    return { status: conn.status, qrCode: conn.qrDataUrl };
  }

  await _createConnectedSocket(professionalId, "qr");

  return { status: conn.status, qrCode: conn.qrDataUrl };
}

export async function connectWithPhone(
  professionalId: string,
  phoneNumber: string,
): Promise<{ status: ConnectionStatus; pairingCode: string | null }> {
  const conn = getConnection(professionalId);

  if (conn.status === "connected" && conn.socket) {
    return { status: "connected", pairingCode: null };
  }

  await disconnectProfessional(professionalId);

  conn.pairingCode = null;

  try {
    await _createConnectedSocket(professionalId, "phone");

    const socket = conn.socket;
    if (!socket) throw new Error("Socket não criado");

    let cleanPhone = phoneNumber.replace(/\D/g, "");
    if (!cleanPhone.startsWith("55")) cleanPhone = `55${cleanPhone}`;

    // Aguarda o QR ser gerado (sinal de que o socket está pronto)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timeout ao aguardar socket para pareamento")),
        15_000,
      );
      socket.ev.on("connection.update", (update: Partial<ConnectionState>) => {
        if (update.qr) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    const code = await socket.requestPairingCode(cleanPhone);

    conn.pairingCode = code;
    conn.status = "qr_code";

    log(professionalId, `Pairing code gerado para ${cleanPhone}.`);

    return { status: conn.status, pairingCode: code };
  } catch (error) {
    conn.status = "disconnected";
    conn.connectPromise = null;
    conn.socket = null;
    conn.pairingCode = null;
    logError(professionalId, "Erro ao conectar com telefone", error);
    return { status: "disconnected", pairingCode: null };
  }
}

export async function disconnectProfessional(
  professionalId: string,
): Promise<void> {
  const conn = getConnection(professionalId);

  if (conn.reconnectTimer) {
    clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = null;
  }

  if (conn.socket) {
    try {
      await conn.socket.logout();
    } catch {
      try {
        conn.socket.end(undefined);
      } catch {
        /* ignore */
      }
    }
    conn.socket = null;
  }

  const authDir = getSafeAuthDir(professionalId);
  try {
    await fs.rm(authDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  conn.status = "disconnected";
  conn.qrCode = null;
  conn.qrDataUrl = null;
  conn.pairingCode = null;
  conn.retryCount = 0;
  conn.connectPromise = null;

  log(professionalId, "Desconectado e sessão removida.");
}

export async function disconnectAll(): Promise<void> {
  const ids = Array.from(connections.keys());
  await Promise.allSettled(ids.map((id) => disconnectProfessional(id)));
  connections.clear();
  console.log("[WA] Todas as conexões encerradas.");
}

export async function sendGroupMessage(
  professionalId: string,
  groupName: string,
  message: string,
): Promise<boolean> {
  const conn = getConnection(professionalId);

  if (conn.status !== "connected" || !conn.socket) {
    log(
      professionalId,
      `Tentativa de envio sem conexão ativa (status: ${conn.status}).`,
    );
    return false;
  }

  // Atualiza prova de vida ao enviar mensagem
  conn.lastPing = Date.now();

  try {
    const normalize = (str: string) =>
      str
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9\s]/g, "")
        .toLowerCase()
        .trim();

    const groups = await conn.socket.groupFetchAllParticipating();
    const normalizedInput = normalize(groupName);
    const targetGroup = Object.values(groups).find(
      (group) => normalize(group.subject) === normalizedInput,
    );

    if (!targetGroup) {
      log(professionalId, `Grupo "${groupName}" não encontrado.`);
      return false;
    }

    await conn.socket.sendMessage(targetGroup.id, { text: message });
    log(professionalId, `Mensagem enviada para o grupo "${groupName}".`);
    return true;
  } catch (error) {
    logError(professionalId, "Erro ao enviar mensagem", error);
    return false;
  }
}
