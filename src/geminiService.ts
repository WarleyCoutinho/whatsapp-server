import { GoogleGenerativeAI, type Content } from "@google/generative-ai";

const SYSTEM_PROMPT = `Você é o assistente de suporte do Servix via WhatsApp, uma plataforma SaaS de agendamento para barbearias, salões de beleza e estética.

REGRAS:
- Responda SEMPRE em português brasileiro
- Seja educado, objetivo e direto
- Máximo 3 parágrafos curtos por resposta (formato WhatsApp)
- NUNCA invente informações sobre planos ou preços
- Use apenas os dados oficiais abaixo

PLANOS SERVIX:
1. Solo (BASIC) — R$ 39,90/mês: 1 loja, 1 profissional, até 4 serviços, agendamento online 24/7, página pública, pagamentos integrados, suporte via chat
2. Equipe (STANDARD) — R$ 79,90/mês: 1 loja, até 5 profissionais, até 20 serviços, agendamento por profissional, comissão automática, relatórios de faturamento, suporte prioritário
3. Profissional (PROFESSIONAL) — R$ 129,90/mês: 1 loja, até 20 profissionais, até 50 serviços, relatórios avançados, ranking de desempenho, histórico completo de clientes, suporte prioritário

FUNCIONALIDADES:
- Agendamento online 24/7: clientes agendam pelo site a qualquer hora
- Notificações WhatsApp automáticas: agenda enviada ao grupo após cada agendamento/cancelamento
- Pagamento online com cartão de crédito via Stripe
- Pagamento presencial: "Pagar após o serviço" (dinheiro, PIX externo, maquininha)
- Controle de horários: expediente, intervalo de almoço, dias de folga
- Gestão de equipe em tempo real
- Login com Google, configuração em menos de 10 minutos

FLUXO DE CONFIGURAÇÃO:
1. Login com Google → escolher Proprietário
2. Criar loja (nome, endereço, cidade, estado, telefone, CPF, descrição)
3. Ativar plano de assinatura
4. Cadastrar profissionais (nome, e-mail Google, nome do grupo WhatsApp)
5. Cadastrar serviços (nome, preço, duração, foto)
6. Profissional configura: pagamento, WhatsApp, horários e Stripe

STRIPE (configuração do profissional):
- Acessar Painel Profissional → aviso amarelo → Configurar conta Stripe
- Necessário: RG/CNH, CPF, dados bancários, comprovante de endereço
- Passos: dados pessoais → setor (Serviços pessoais > Salões de beleza) → documentos → conta bancária → revisão
- Link expira — recarregar página gera novo link

WHATSAPP:
- Nome do grupo no sistema deve ser IDÊNTICO ao nome do grupo no WhatsApp
- Opção A: QR Code (Dispositivos Conectados > Conectar dispositivo)
- Opção B: Número de celular (parear com código)
- Grupo como "Somente admins enviam mensagens" para organização

FORMAS DE PAGAMENTO:
- Cartão: já ativo, cliente paga online na hora
- Pagar após o serviço: ativar nas configurações para cobrar presencialmente
- PIX: em desenvolvimento
- Sempre marcar como "Finalizado" após atendimento presencial

HORÁRIOS:
- Configurar no Painel Profissional → Minha Agenda
- Ativar/desativar dias, definir expediente e intervalo de almoço
- Sistema bloqueia alteração se houver agendamento no horário

CONTATO SUPORTE HUMANO:
- WhatsApp: +55 62 99968-7179
- E-mail: contatoadapticode@gmail.com

Se não souber a resposta, oriente o usuário a entrar em contato com o suporte humano.`;

const ESCALATION_KEYWORDS = [
  "cancelar",
  "reembolso",
  "falar com humano",
  "urgente",
  "atendente",
  "suporte humano",
];

const MAX_HISTORY = 10;
const conversationHistory = new Map<string, Content[]>();

type AIProvider = "gemini" | "openai" | "anthropic";

interface ChatMessage {
  role: "user" | "model";
  content: string;
}

function getProvider(): AIProvider {
  const provider = (process.env.AI_PROVIDER ?? "gemini") as AIProvider;
  if (!["gemini", "openai", "anthropic"].includes(provider)) {
    throw new Error(
      `AI_PROVIDER "${provider}" não suportado. Use: gemini, openai ou anthropic`,
    );
  }
  return provider;
}

function getApiKey(): string {
  const key = process.env.AI_API_KEY;
  if (!key) {
    throw new Error("AI_API_KEY não configurada");
  }
  return key;
}

function getModel(): string {
  return process.env.AI_MODEL ?? "gemini-1.5-flash";
}

let genAIInstance: GoogleGenerativeAI | null = null;

function getGenAI(): GoogleGenerativeAI {
  if (!genAIInstance) {
    genAIInstance = new GoogleGenerativeAI(getApiKey());
  }
  return genAIInstance;
}

async function responderGemini(
  history: Content[],
  message: string,
): Promise<string> {
  const genAI = getGenAI();
  const model = genAI.getGenerativeModel({
    model: getModel(),
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 400,
    },
  });

  const chat = model.startChat({
    history: history.slice(0, -1),
    systemInstruction: SYSTEM_PROMPT,
  });

  const result = await chat.sendMessage(message);
  return result.response.text();
}

async function responderOpenAI(
  history: Content[],
  message: string,
): Promise<string> {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((h) => ({
      role: h.role === "model" ? "assistant" : "user",
      content: h.parts.map((p) => ("text" in p ? p.text : "")).join(""),
    })),
    { role: "user", content: message },
  ];

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({
      model: getModel(),
      max_tokens: 400,
      temperature: 0.7,
      messages,
    }),
  });

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

async function responderAnthropic(
  history: Content[],
  message: string,
): Promise<string> {
  const messages = [
    ...history.map((h) => ({
      role: h.role === "model" ? ("assistant" as const) : ("user" as const),
      content: h.parts.map((p) => ("text" in p ? p.text : "")).join(""),
    })),
    { role: "user" as const, content: message },
  ];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": getApiKey(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: getModel(),
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages,
    }),
  });

  const data = await res.json();
  return data.content?.[0]?.text ?? "";
}

export function deveEscalarParaHumano(message: string): boolean {
  const lower = message.toLowerCase();
  return ESCALATION_KEYWORDS.some((keyword) => lower.includes(keyword));
}

export async function responderMensagem(
  phoneNumber: string,
  message: string,
): Promise<string> {
  try {
    const provider = getProvider();
    const history = conversationHistory.get(phoneNumber) ?? [];

    history.push({
      role: "user",
      parts: [{ text: message }],
    });

    if (history.length > MAX_HISTORY * 2) {
      history.splice(0, history.length - MAX_HISTORY * 2);
    }

    let responseText: string;

    switch (provider) {
      case "openai":
        responseText = await responderOpenAI(history, message);
        break;
      case "anthropic":
        responseText = await responderAnthropic(history, message);
        break;
      case "gemini":
      default:
        responseText = await responderGemini(history, message);
        break;
    }

    history.push({
      role: "model",
      parts: [{ text: responseText }],
    });

    conversationHistory.set(phoneNumber, history);

    return responseText;
  } catch (error) {
    console.error(`AI error for ${phoneNumber}:`, error);
    return "Desculpe, estou com dificuldades técnicas no momento. Por favor, entre em contato com nosso suporte pelo WhatsApp: +55 62 99968-7179 ou e-mail: contatoadapticode@gmail.com";
  }
}

export function limparHistorico(phoneNumber: string): void {
  conversationHistory.delete(phoneNumber);
}
