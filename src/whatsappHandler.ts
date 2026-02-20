import {
  deveEscalarParaHumano,
  limparHistorico,
  responderMensagem,
} from "./geminiService.js";

interface WASocket {
  ev: {
    on: (event: string, handler: (...args: unknown[]) => void) => void;
  };
  sendMessage: (
    jid: string,
    content: { text: string },
  ) => Promise<unknown>;
  sendPresenceUpdate: (
    presence: string,
    jid: string,
  ) => Promise<unknown>;
  user?: { id: string };
}

interface MessageUpsert {
  messages: Array<{
    key: {
      remoteJid?: string | null;
      fromMe?: boolean | null;
      id?: string | null;
    };
    message?: {
      conversation?: string | null;
      extendedTextMessage?: {
        text?: string | null;
      } | null;
    } | null;
    messageTimestamp?: number | bigint | null;
  }>;
  type: string;
}

const SUPPORT_WHATSAPP = "5562999687179";
const SUPPORT_EMAIL = "contatoadapticode@gmail.com";
const SPAM_COOLDOWN_MS = 3000;
const processedMessages = new Set<string>();
const lastMessageTime = new Map<string, number>();

function cleanupOldMessages(): void {
  if (processedMessages.size > 1000) {
    const iterator = processedMessages.values();
    for (let i = 0; i < 500; i++) {
      const next = iterator.next();
      if (next.done) break;
      processedMessages.delete(next.value);
    }
  }
}

function getMessageText(message: MessageUpsert["messages"][0]): string | null {
  return (
    message.message?.conversation ??
    message.message?.extendedTextMessage?.text ??
    null
  );
}

function isGroupMessage(jid: string): boolean {
  return jid.endsWith("@g.us");
}

export function initWhatsAppHandlers(
  sock: WASocket,
  getPlanoDoCliente: (phone: string) => Promise<string | null>,
): void {
  sock.ev.on("messages.upsert", async (upsert: unknown) => {
    const { messages, type } = upsert as MessageUpsert;

    if (type !== "notify") return;

    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      if (!jid) continue;

      if (msg.key.fromMe) continue;

      if (isGroupMessage(jid)) continue;

      const msgId = msg.key.id;
      if (msgId && processedMessages.has(msgId)) continue;
      if (msgId) processedMessages.add(msgId);

      const text = getMessageText(msg);
      if (!text || text.trim().length === 0) continue;

      const phone = jid.replace("@s.whatsapp.net", "");

      const now = Date.now();
      const lastTime = lastMessageTime.get(phone) ?? 0;
      if (now - lastTime < SPAM_COOLDOWN_MS) continue;
      lastMessageTime.set(phone, now);

      cleanupOldMessages();

      try {
        await sock.sendPresenceUpdate("composing", jid);

        const plano = await getPlanoDoCliente(phone);

        if (plano === "PROFESSIONAL" || plano === "ENTERPRISE") {
          await sock.sendMessage(jid, {
            text: `Olá! Como assinante do plano premium, você tem acesso ao suporte direto.\n\n📞 WhatsApp Suporte: wa.me/${SUPPORT_WHATSAPP}\n📧 E-mail: ${SUPPORT_EMAIL}\n\nNossa equipe está pronta para te atender!`,
          });
          continue;
        }

        if (deveEscalarParaHumano(text)) {
          await sock.sendMessage(jid, {
            text: `Entendi que você precisa de atendimento especializado. Vou te encaminhar para nossa equipe:\n\n📞 WhatsApp: wa.me/${SUPPORT_WHATSAPP}\n📧 E-mail: ${SUPPORT_EMAIL}\n\nSe precisar limpar nosso histórico de conversa, digite "limpar".`,
          });
          continue;
        }

        if (text.toLowerCase().trim() === "limpar") {
          limparHistorico(phone);
          await sock.sendMessage(jid, {
            text: "Histórico de conversa limpo! Como posso te ajudar?",
          });
          continue;
        }

        const response = await responderMensagem(phone, text);
        await sock.sendMessage(jid, { text: response });
      } catch (error) {
        console.error(`Error handling message from ${phone}:`, error);
        await sock.sendMessage(jid, {
          text: `Desculpe, ocorreu um erro. Por favor, tente novamente ou entre em contato:\n\n📞 WhatsApp: wa.me/${SUPPORT_WHATSAPP}\n📧 E-mail: ${SUPPORT_EMAIL}`,
        });
      }
    }
  });
}
