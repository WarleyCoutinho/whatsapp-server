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
  pairingCode: string | null;
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
      pairingCode: null,
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

// Internal: close socket without deleting auth files (for reconnect)
function _cleanupSocket(conn: ProfessionalConnection): void {
  if (conn.reconnectTimer) {
    clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = null;
  }
  if (conn.socket) {
    try {
      const socket = conn.socket as { end: (reason?: unknown) => void };
      socket.end(undefined);
    } catch {
      /* ignore */
    }
    conn.socket = null;
  }
  conn.qrCode = null;
  conn.qrDataUrl = null;
  conn.connectPromise = null;
}

// Internal: create Baileys socket with existing auth state (preserves session)
async function _createConnectedSocket(
  professionalId: string,
  mode: "qr" | "phone",
): Promise<void> {
  const conn = getConnection(professionalId);

  conn.status = "connecting";
  conn.qrCode = null;
  conn.qrDataUrl = null;

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
      printQRInTerminal: mode === "qr" && process.env.NODE_ENV !== "production",
      connectTimeoutMs: 60000,
      qrTimeout: 60000,
      ...(mode === "phone" ? { mobile: false } : {}),
    });

    conn.socket = socket;

    socket.ev.on("creds.update", saveCreds);

    socket.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && mode === "qr") {
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
        conn.pairingCode = null;
        conn.retryCount = 0;
        conn.connectPromise = null;
      }

      if (connection === "close") {
        const statusCode = (
          lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        // Only cleanup socket, preserve auth files for reconnect
        _cleanupSocket(conn);

        if (shouldReconnect && conn.retryCount < MAX_RETRIES) {
          const delay =
            RETRY_DELAYS[Math.min(conn.retryCount, RETRY_DELAYS.length - 1)];
          conn.retryCount++;
          conn.status = "connecting";
          conn.reconnectTimer = setTimeout(() => {
            conn.reconnectTimer = null;
            // Reconnect preserving auth state (no disconnect/delete)
            _createConnectedSocket(professionalId, mode);
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
}

export function getConnectionStatus(professionalId: string): ConnectionStatus {
  return getConnection(professionalId).status;
}

export function getQRDataUrl(professionalId: string): string | null {
  return getConnection(professionalId).qrDataUrl;
}

export function getPairingCode(professionalId: string): string | null {
  return getConnection(professionalId).pairingCode;
}

export async function connectProfessional(
  professionalId: string,
): Promise<{ status: ConnectionStatus; qrCode: string | null }> {
  const conn = getConnection(professionalId);

  if (conn.status === "connected" && conn.socket) {
    return { status: "connected", qrCode: null };
  }

  // Full cleanup: destroy previous session for a fresh QR
  await disconnectProfessional(professionalId);

  // Create socket (auth files were deleted, so Baileys generates new QR)
  conn.connectPromise = _createConnectedSocket(professionalId, "qr");
  await conn.connectPromise;

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

  // Full cleanup for a fresh pairing
  await disconnectProfessional(professionalId);

  conn.pairingCode = null;

  try {
    // Create socket in phone mode
    await _createConnectedSocket(professionalId, "phone");

    const socket = conn.socket;
    if (!socket) {
      throw new Error("Socket not created");
    }

    let cleanPhone = phoneNumber.replace(/\D/g, "");
    if (!cleanPhone.startsWith("55")) {
      cleanPhone = `55${cleanPhone}`;
    }

    // Wait for socket to be ready before requesting pairing code
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timeout ao aguardar socket para pareamento")),
        15000,
      );
      (
        socket as {
          ev: {
            on: (
              event: string,
              cb: (update: { qr?: string }) => void,
            ) => void;
          };
        }
      ).ev.on("connection.update", (update) => {
        if (update.qr) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    const code = await (
      socket as { requestPairingCode: (phone: string) => Promise<string> }
    ).requestPairingCode(cleanPhone);

    conn.pairingCode = code;
    conn.status = "qr_code";

    return { status: conn.status, pairingCode: code };
  } catch (error) {
    conn.status = "disconnected";
    conn.connectPromise = null;
    conn.socket = null;
    conn.pairingCode = null;
    console.error(
      `[WhatsApp] Phone connection error for ${professionalId}:`,
      error instanceof Error ? error.message : "Unknown error",
    );
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
  conn.pairingCode = null;
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

    const normalize = (str: string) =>
      str
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9\s]/g, "")
        .toLowerCase()
        .trim();

    const groups = await socket.groupFetchAllParticipating();
    const normalizedInput = normalize(groupName);
    const targetGroup = Object.values(groups).find(
      (group) => normalize(group.subject) === normalizedInput,
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
