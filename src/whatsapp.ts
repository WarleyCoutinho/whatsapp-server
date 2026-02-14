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
}

const AUTH_BASE_DIR = path.join(__dirname, "..", "whatsapp-auth");
const MAX_RETRIES = 5;
const RETRY_DELAYS = [2000, 5000, 10000, 20000, 30000];

const connections = new Map<string, ProfessionalConnection>();

async function loadBaileys() {
  const baileys = await import("@whiskeysockets/baileys");
  return baileys;
}

function getConnection(professionalId: string): ProfessionalConnection {
  if (!connections.has(professionalId)) {
    connections.set(professionalId, {
      socket: null,
      status: "disconnected",
      qrCode: null,
      qrDataUrl: null,
      retryCount: 0,
      connectPromise: null,
    });
  }
  return connections.get(professionalId)!;
}

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

      const authDir = path.join(AUTH_BASE_DIR, professionalId);
      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      const { version } = await fetchLatestBaileysVersion();

      const socket = makeWASocket({
        auth: state,
        version,
        printQRInTerminal: true,
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
          console.log(
            `[WhatsApp] QR code gerado para profissional ${professionalId}`,
          );
        }

        if (connection === "open") {
          conn.status = "connected";
          conn.qrCode = null;
          conn.qrDataUrl = null;
          conn.retryCount = 0;
          conn.connectPromise = null;
          console.log(
            `[WhatsApp] Profissional ${professionalId} conectado`,
          );
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
            console.log(
              `[WhatsApp] Reconectando profissional ${professionalId} (tentativa ${conn.retryCount}/${MAX_RETRIES}) em ${delay}ms...`,
            );
            setTimeout(() => {
              connectProfessional(professionalId);
            }, delay);
          } else {
            conn.status = "disconnected";
            conn.retryCount = 0;
            console.log(
              shouldReconnect
                ? `[WhatsApp] Profissional ${professionalId}: máximo de tentativas atingido`
                : `[WhatsApp] Profissional ${professionalId} deslogado`,
            );
          }
        }
      });
    } catch (error) {
      conn.status = "disconnected";
      conn.connectPromise = null;
      conn.socket = null;
      console.error(
        `[WhatsApp] Erro ao conectar profissional ${professionalId}:`,
        error,
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

  // Limpar arquivos de auth para forçar novo QR code na reconexão
  const authDir = path.join(AUTH_BASE_DIR, professionalId);
  try {
    await fs.rm(authDir, { recursive: true, force: true });
    console.log(`[WhatsApp] Auth removido para profissional ${professionalId}`);
  } catch {
    /* ignore if dir doesn't exist */
  }

  conn.status = "disconnected";
  conn.qrCode = null;
  conn.qrDataUrl = null;
  conn.retryCount = 0;
  conn.connectPromise = null;
}

export async function sendGroupMessage(
  professionalId: string,
  groupName: string,
  message: string,
): Promise<boolean> {
  const conn = getConnection(professionalId);

  if (conn.status !== "connected" || !conn.socket) {
    console.log(
      `[WhatsApp] Profissional ${professionalId} não está conectado. Status: ${conn.status}`,
    );
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
      console.log(
        `[WhatsApp] Grupo "${groupName}" não encontrado para profissional ${professionalId}`,
      );
      return false;
    }

    await socket.sendMessage(targetGroup.id, { text: message });
    console.log(
      `[WhatsApp] Mensagem enviada no grupo "${groupName}" para profissional ${professionalId}`,
    );
    return true;
  } catch (error) {
    console.error(
      `[WhatsApp] Erro ao enviar mensagem para profissional ${professionalId}:`,
      error,
    );
    return false;
  }
}
