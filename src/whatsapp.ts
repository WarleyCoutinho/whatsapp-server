import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import QRCode from "qrcode";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type ConnectionStatus = "disconnected" | "connecting" | "qr_code" | "connected";

interface ProfessionalConnection {
  socket: unknown;
  status: ConnectionStatus;
  qrCode: string | null;
  qrDataUrl: string | null;
  retryCount: number;
  connectPromise: Promise<void> | null;
  lastActivity: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

const AUTH_BASE_DIR = path.join(__dirname, "..", "whatsapp-auth");
const MAX_RETRIES = 5;
const MAX_CONNECTIONS = 100;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const RETRY_DELAYS = [2000, 5000, 10000, 20000, 30000];

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

async function loadBaileys() {
  const baileys = await import("@whiskeysockets/baileys");
  return baileys;
}

function getConnection(professionalId: string): ProfessionalConnection {
  validateProfessionalId(professionalId);

  if (!connections.has(professionalId)) {
    if (connections.size >= MAX_CONNECTIONS) {
      throw new Error("Maximum number of connections reached");
    }
    connections.set(professionalId, {
      socket: null,
      status: "disconnected",
      qrCode: null,
      qrDataUrl: null,
      retryCount: 0,
      connectPromise: null,
      lastActivity: Date.now(),
      reconnectTimer: null,
    });
  }

  const conn = connections.get(professionalId)!;
  conn.lastActivity = Date.now();
  return conn;
}

// Cleanup idle disconnected connections every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, conn] of connections.entries()) {
    if (
      conn.status === "disconnected" &&
      now - conn.lastActivity > IDLE_TIMEOUT_MS
    ) {
      if (conn.reconnectTimer) {
        clearTimeout(conn.reconnectTimer);
      }
      connections.delete(id);
    }
  }
}, 5 * 60 * 1000);

export function getConnectionStatus(professionalId: string): ConnectionStatus {
  return getConnection(professionalId).status;
}

export function getQRDataUrl(professionalId: string): string | null {
  return getConnection(professionalId).qrDataUrl;
}

export async function connectProfessional(
  professionalId: string,
): Promise<{ status: ConnectionStatus; qrCode: string | null }> {
  const conn = getConnection(professionalId);

  if (conn.status === "connected" && conn.socket) {
    return { status: "connected", qrCode: null };
  }

  if (conn.connectPromise) {
    return { status: conn.status, qrCode: conn.qrDataUrl };
  }

  if (conn.socket) {
    try {
      const oldSocket = conn.socket as { end: (reason?: unknown) => void };
      oldSocket.end(undefined);
    } catch {
      /* ignore cleanup errors */
    }
    conn.socket = null;
  }

  conn.status = "connecting";
  conn.qrCode = null;
  conn.qrDataUrl = null;

  conn.connectPromise = (async () => {
    try {
      const {
        default: makeWASocket,
        useMultiFileAuthState,
        DisconnectReason,
        fetchLatestBaileysVersion,
      } = await loadBaileys();

      const authDir = getSafeAuthDir(professionalId);
      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      const { version } = await fetchLatestBaileysVersion();

      const socket = makeWASocket({
        auth: state,
        version,
        printQRInTerminal: process.env.NODE_ENV !== "production",
        connectTimeoutMs: 60000,
        qrTimeout: 40000,
      });

      conn.socket = socket;

      socket.ev.on("creds.update", saveCreds);

      socket.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          conn.status = "qr_code";
          conn.qrCode = qr;
          try {
            conn.qrDataUrl = await QRCode.toDataURL(qr, {
              width: 256,
              margin: 2,
            });
          } catch {
            conn.qrDataUrl = null;
          }
          conn.retryCount = 0;
        }

        if (connection === "open") {
          conn.status = "connected";
          conn.qrCode = null;
          conn.qrDataUrl = null;
          conn.retryCount = 0;
          conn.connectPromise = null;
        }

        if (connection === "close") {
          const statusCode = (
            lastDisconnect?.error as { output?: { statusCode?: number } }
          )?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          conn.socket = null;
          conn.qrCode = null;
          conn.qrDataUrl = null;
          conn.connectPromise = null;

          if (shouldReconnect && conn.retryCount < MAX_RETRIES) {
            const delay =
              RETRY_DELAYS[Math.min(conn.retryCount, RETRY_DELAYS.length - 1)];
            conn.retryCount++;
            conn.status = "connecting";
            conn.reconnectTimer = setTimeout(() => {
              conn.reconnectTimer = null;
              connectProfessional(professionalId);
            }, delay);
          } else {
            conn.status = "disconnected";
            conn.retryCount = 0;
          }
        }
      });
    } catch (error) {
      conn.status = "disconnected";
      conn.connectPromise = null;
      conn.socket = null;
      console.error(
        `[WhatsApp] Connection error for ${professionalId}:`,
        error instanceof Error ? error.message : "Unknown error",
      );
    }
  })();

  await conn.connectPromise;

  return { status: conn.status, qrCode: conn.qrDataUrl };
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
      const socket = conn.socket as {
        logout: () => Promise<void>;
        end: (reason?: unknown) => void;
      };
      await socket.logout();
    } catch {
      try {
        const socket = conn.socket as { end: (reason?: unknown) => void };
        socket.end(undefined);
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
    /* ignore if dir doesn't exist */
  }

  conn.status = "disconnected";
  conn.qrCode = null;
  conn.qrDataUrl = null;
  conn.retryCount = 0;
  conn.connectPromise = null;
}

export async function disconnectAll(): Promise<void> {
  const ids = Array.from(connections.keys());
  await Promise.allSettled(ids.map((id) => disconnectProfessional(id)));
  connections.clear();
}

export async function sendGroupMessage(
  professionalId: string,
  groupName: string,
  message: string,
): Promise<boolean> {
  const conn = getConnection(professionalId);

  if (conn.status !== "connected" || !conn.socket) {
    return false;
  }

  try {
    const socket = conn.socket as {
      groupFetchAllParticipating: () => Promise<
        Record<string, { id: string; subject: string }>
      >;
      sendMessage: (
        jid: string,
        content: { text: string },
      ) => Promise<unknown>;
    };

    const groups = await socket.groupFetchAllParticipating();
    const targetGroup = Object.values(groups).find(
      (group) => group.subject.toLowerCase() === groupName.toLowerCase(),
    );

    if (!targetGroup) {
      return false;
    }

    await socket.sendMessage(targetGroup.id, { text: message });
    return true;
  } catch (error) {
    console.error(
      `[WhatsApp] Send error for ${professionalId}:`,
      error instanceof Error ? error.message : "Unknown error",
    );
    return false;
  }
}
