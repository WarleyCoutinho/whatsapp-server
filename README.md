# 📲 Servix WhatsApp Server

Microsserviço em **Node.js + Fastify + Baileys** que conecta o WhatsApp de cada profissional (barbeiro, cabeleireiro, esteticista…) à plataforma **Servix** (SaaS de agendamento) e envia a agenda automaticamente para o **grupo de WhatsApp** dele a cada novo agendamento ou cancelamento.

> Sem API oficial paga, sem Chromium/Puppeteer: a conexão usa o protocolo Web Multi-Device via [Baileys](https://github.com/WhiskeySockets/Baileys).

---

## 📌 O que o sistema faz

- Mantém **uma sessão WhatsApp por profissional**, identificada por UUID, com até **100 conexões simultâneas**.
- Permite conectar de duas formas: **QR Code** ou **código de pareamento por número de telefone**.
- Persiste a sessão em disco (volume), então após restart o profissional **não precisa escanear o QR de novo**.
- Envia mensagens de texto para **grupos** buscando o grupo pelo **nome** (ignora acento, maiúsculas e caracteres especiais).
- Reconecta sozinho com **backoff exponencial + jitter** e detecta **sessões zumbi** via health check.
- Suporta **pool de proxies** com atribuição fixa por profissional (reduz o alerta de "Suspeita de golpe" do WhatsApp).
- Expõe `/health` e `/connections/stats` para monitoramento (Railway, UptimeRobot etc.).
- Inclui um módulo de **atendimento com IA (Gemini)** para suporte via WhatsApp (veja [Módulo de IA](#-módulo-de-ia-suporte-automático)).

## 🎯 Qual problema resolve

| Problema | Solução |
|---|---|
| O profissional não vê os agendamentos novos em tempo real | A agenda é enviada automaticamente ao grupo do WhatsApp dele |
| API oficial do WhatsApp Business é cara e burocrática | Conexão via dispositivo vinculado (QR/pareamento) |
| Sessões caem e exigem novo QR | Persistência em disco + reconexão automática |
| Muitos números no mesmo IP viram alvo de bloqueio | Proxy fixo por profissional (`PROXY_POOL`) |
| Frontend não pode expor credenciais | Toda rota exige `x-api-key`, chamada pelo backend do Servix |

---

## 🏗️ Arquitetura

```
┌──────────────┐  x-api-key   ┌───────────────────────┐   WebSocket   ┌──────────┐
│ Servix (Next)│ ───────────▶ │ whatsapp-server       │ ────────────▶ │ WhatsApp │
│ API / Server │ ◀─────────── │ Fastify + Baileys     │ ◀──────────── │          │
└──────────────┘  JSON        │  ├─ routes.ts         │               └──────────┘
                              │  ├─ whatsapp.ts       │  (opcional: proxy por profissional)
                              │  ├─ whatsappHandler.ts│
                              │  └─ geminiService.ts  │
                              └──────────┬────────────┘
                                         │
                                  Volume /data/whatsapp-auth/<professionalId>/
```

```
src/
├── index.ts            # Bootstrap: valida env, plugins (helmet, cors, rate-limit), health, shutdown
├── routes.ts           # Rotas HTTP + guard de autenticação por API key
├── whatsapp.ts         # Core: sockets Baileys, QR, pairing, reconexão, proxy, envio a grupos
├── whatsappHandler.ts  # Handler de mensagens recebidas (suporte com IA) — ver seção do módulo
└── geminiService.ts    # Integração Google Gemini + histórico de conversa
```

---

## 🔌 Rotas da API

**Base URL local:** `http://localhost:8080` (ou a porta definida em `PORT`)

**Autenticação:** todas as rotas, exceto as públicas, exigem o header:

```
x-api-key: <valor de API_KEY>
```

`professionalId` deve ser um **UUID válido**.

| Método | Rota | Auth | Descrição |
|---|---|:---:|---|
| `GET` | `/health` | ❌ | Health check (`status` e `uptime`) |
| `GET` | `/connections/stats` | ❌ | Conexões ativas, limite e se atingiu o teto |
| `POST` | `/connect/:professionalId` | ✅ | Inicia conexão e retorna QR Code (data URL base64) |
| `POST` | `/connect-phone/:professionalId` | ✅ | Inicia conexão por número e retorna código de pareamento |
| `GET` | `/status/:professionalId` | ✅ | Status atual + QR/pairing code (para polling) |
| `POST` | `/disconnect/:professionalId` | ✅ | Faz logout e **apaga** a sessão em disco |
| `POST` | `/send-message` | ✅ | Envia texto para um grupo pelo nome |

**Status possíveis:** `disconnected` · `connecting` · `qr_code` · `connected`

### Exemplos

**Conectar via QR Code**

```bash
curl -X POST http://localhost:8080/connect/3f2b8c1e-9d4a-4c6b-8e21-7a5d0c9b1f44 \
  -H "x-api-key: $API_KEY"
```

```json
{ "status": "qr_code", "qrCode": "data:image/png;base64,iVBORw0KGgo..." }
```

**Conectar via número** (aceita com ou sem DDI; se não começar com `55`, o servidor adiciona)

```bash
curl -X POST http://localhost:8080/connect-phone/3f2b8c1e-9d4a-4c6b-8e21-7a5d0c9b1f44 \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber": "62999999999"}'
```

```json
{ "status": "qr_code", "pairingCode": "ABCD1234" }
```

No celular: **WhatsApp → Aparelhos conectados → Conectar um aparelho → Conectar com número de telefone** e digitar o código.

**Consultar status (polling)**

```bash
curl http://localhost:8080/status/3f2b8c1e-9d4a-4c6b-8e21-7a5d0c9b1f44 \
  -H "x-api-key: $API_KEY"
```

```json
{ "status": "connected", "qrCode": null, "pairingCode": null }
```

**Enviar mensagem para grupo**

```bash
curl -X POST http://localhost:8080/send-message \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "professionalId": "3f2b8c1e-9d4a-4c6b-8e21-7a5d0c9b1f44",
    "groupName": "Agenda Barbearia do Zé",
    "message": "✅ Novo agendamento: Corte + Barba, hoje às 15:00"
  }'
```

```json
{ "success": true }
```

`success: false` significa: sem conexão ativa, grupo não encontrado ou erro no envio (veja os logs).

**Erros comuns**

| Código | Motivo |
|---|---|
| `401` | `x-api-key` ausente ou incorreta |
| `400` | `professionalId` fora do formato UUID ou body inválido |
| `429` | Rate limit (30 req/min por IP) |
| `503` | Servidor sem `API_KEY` ou limite de 100 conexões atingido |

---

## ⚙️ Variáveis de ambiente

Copie o exemplo e preencha:

```bash
cp .env.example .env
```

| Variável | Obrigatória | Padrão | Descrição |
|---|:---:|---|---|
| `API_KEY` | ✅ | — | Chave que o cliente deve enviar em `x-api-key`. O servidor **não sobe** sem ela. Gere uma forte (veja abaixo). |
| `PORT` | ✅* | — | Porta HTTP. O código faz `Number(process.env.PORT)`, então **defina sempre** (o Dockerfile já define `3320`). |
| `AUTH_DIR` | ⚠️ recomendada | `/data/whatsapp-auth` | Pasta onde as sessões do Baileys são salvas. **Em produção aponte para um volume persistente.** |
| `ALLOWED_ORIGINS` | ❌ | CORS desativado | Origens permitidas, separadas por vírgula. Ex.: `https://meuapp.vercel.app,http://localhost:3000` |
| `NODE_ENV` | ❌ | — | Em `production`, o QR **não** é impresso no terminal. |
| `PROXY_POOL` | ❌ | vazio | Lista de proxies HTTP separados por vírgula: `http://user:pass@ip1:porta,http://user:pass@ip2:porta`. Recomendado usar proxies **brasileiros** em produção. |
| `AI_API_KEY` | ❌ | — | Chave do Gemini (módulo de IA). Alternativa: `GOOGLE_GENERATIVE_AI_API_KEY`. |
| `AI_MODEL` | ❌ | `gemini-1.5-flash` | Modelo do Gemini usado no atendimento. |
| `AI_PROVIDER` | ❌ | — | Presente no `.env.example`, mas **hoje o código só implementa Gemini** e não lê essa variável. |

### Exemplo de `.env` para desenvolvimento

```env
API_KEY=cole_aqui_uma_chave_forte
PORT=8080
NODE_ENV=development
ALLOWED_ORIGINS=http://localhost:3000
AUTH_DIR=./whatsapp-auth

# Opcional
# PROXY_POOL=http://user:pass@ip1:8000,http://user:pass@ip2:8000
# AI_API_KEY=sua_chave_gemini
# AI_MODEL=gemini-1.5-flash
```

**Gerar uma `API_KEY` segura:**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> ⚠️ **Importante para rodar local:** se você não definir `AUTH_DIR`, o `index.ts` tenta criar `/data/whatsapp-auth`, que exige permissão de root (no macOS a raiz é somente leitura e o processo encerra com erro). Localmente use `AUTH_DIR=./whatsapp-auth`.

---

## 🚀 Como rodar

### Pré-requisitos

- **Node.js 22+** (o Dockerfile usa 22; o script usa `--env-file`, que exige Node ≥ 20.6)
- **pnpm** (`corepack enable && corepack prepare pnpm@latest --activate`)
- Um WhatsApp para testar a conexão

### Desenvolvimento (local)

```bash
# 1. Instalar dependências
pnpm install

# 2. Configurar variáveis
cp .env.example .env
# edite o .env (API_KEY, PORT e AUTH_DIR=./whatsapp-auth)

# 3. Subir com hot reload
pnpm dev
```

Teste:

```bash
curl http://localhost:8080/health
# {"status":"ok","uptime":3.21}
```

Fora de `production`, o QR também aparece no terminal.

### Produção (build manual)

```bash
pnpm build     # compila TypeScript para dist/
pnpm start     # node --env-file=.env dist/index.js
```

### Docker

```bash
docker build -t servix-whatsapp-server .

docker run -d --name whatsapp-server \
  -p 3320:3320 \
  -e API_KEY=sua_chave \
  -e AUTH_DIR=/data/whatsapp-auth \
  -e ALLOWED_ORIGINS=https://seuapp.com \
  -v whatsapp_auth:/data \
  servix-whatsapp-server
```

O volume em `/data` é o que garante que as sessões sobrevivam a restarts e novos deploys.

### Deploy no Railway

O projeto já inclui `railway.toml` (build via Dockerfile, restart em falha até 10 vezes).

1. Crie um projeto no Railway apontando para o repositório.
2. Adicione um **Volume** montado em `/data`.
3. Configure as variáveis: `API_KEY`, `AUTH_DIR=/data/whatsapp-auth`, `ALLOWED_ORIGINS`, `NODE_ENV=production` (e `PROXY_POOL`, `AI_API_KEY` se for usar).
4. Faça o deploy e valide em `https://<seu-dominio>/health`.

> O Railway injeta `PORT` automaticamente. Se usar outro provedor, defina `PORT` manualmente.

---

## 🔗 Como integrar (Next.js / Node)

**Regra de ouro:** a `API_KEY` fica **somente no servidor**. O navegador nunca chama o whatsapp-server direto, sempre passa por uma Route Handler / Server Action do seu app.

No projeto Next.js, adicione:

```env
WHATSAPP_SERVER_URL=https://seu-whatsapp-server.up.railway.app
WHATSAPP_API_KEY=mesma_chave_do_API_KEY
```

### Client tipado com Zod (`lib/whatsapp.ts`)

```ts
import { z } from "zod";

const statusSchema = z.object({
  status: z.enum(["disconnected", "connecting", "qr_code", "connected"]),
  qrCode: z.string().nullable().optional(),
  pairingCode: z.string().nullable().optional(),
});

const sendSchema = z.object({ success: z.boolean() });

async function wa<T>(path: string, schema: z.ZodType<T>, init?: RequestInit) {
  const res = await fetch(`${process.env.WHATSAPP_SERVER_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.WHATSAPP_API_KEY!,
      ...init?.headers,
    },
    cache: "no-store",
  });

  if (!res.ok) throw new Error(`WhatsApp server error: ${res.status}`);
  return schema.parse(await res.json());
}

export const whatsapp = {
  connectQr: (id: string) =>
    wa(`/connect/${id}`, statusSchema, { method: "POST" }),

  connectPhone: (id: string, phoneNumber: string) =>
    wa(`/connect-phone/${id}`, statusSchema, {
      method: "POST",
      body: JSON.stringify({ phoneNumber }),
    }),

  status: (id: string) => wa(`/status/${id}`, statusSchema),

  disconnect: (id: string) =>
    wa(`/disconnect/${id}`, z.object({ status: z.string() }), {
      method: "POST",
    }),

  sendToGroup: (professionalId: string, groupName: string, message: string) =>
    wa("/send-message", sendSchema, {
      method: "POST",
      body: JSON.stringify({ professionalId, groupName, message }),
    }),
};
```

### Route Handler (`app/api/whatsapp/status/[id]/route.ts`)

```ts
import { NextResponse } from "next/server";
import { whatsapp } from "@/lib/whatsapp";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // TODO: validar sessão do usuário e se ele é dono desse professionalId
  return NextResponse.json(await whatsapp.status(id));
}
```

### Notificar o grupo após um agendamento

```ts
await whatsapp.sendToGroup(
  professional.id,
  professional.whatsappGroupName, // deve ser IDÊNTICO ao nome do grupo no WhatsApp
  `✅ Novo agendamento\n👤 ${client.name}\n✂️ ${service.name}\n🕒 ${date}`,
);
```

### Fluxo recomendado na tela de configuração

1. Usuário clica em **Conectar** → `POST /connect/:id` (ou `/connect-phone/:id`).
2. Exibe o QR (`<img src={qrCode} />`) ou o código de pareamento.
3. Faz **polling** em `/status/:id` a cada 3–5 s até `status === "connected"`.
4. Salva o **nome do grupo** no cadastro do profissional.
5. Nos eventos de agendar/cancelar, chama `sendToGroup`.

> O rate limit é de **30 req/min por IP**. Como o servidor do Next chega com o mesmo IP, faça polling com intervalo de 3 s no mínimo e pare assim que conectar.

---

## 🤖 Módulo de IA (suporte automático)

`geminiService.ts` e `whatsappHandler.ts` implementam um atendente de suporte no WhatsApp:

- Responde em pt-BR usando **Google Gemini**, com histórico de até 10 trocas por número.
- **Escala para humano** ao detectar palavras como `cancelar`, `reembolso`, `urgente`, `atendente`.
- Assinantes dos planos **PROFESSIONAL/ENTERPRISE** são direcionados direto ao suporte humano.
- Ignora grupos, mensagens próprias, duplicadas e aplica cooldown anti-spam de 3 s.
- Comando `limpar` zera o histórico da conversa.

> ⚠️ **Estado atual:** `initWhatsAppHandlers` **não é chamado em nenhum lugar** do projeto, então o bot ainda está inativo. Para ativá-lo, chame-o logo após criar o socket em `whatsapp.ts`:

```ts
import { initWhatsAppHandlers } from "./whatsappHandler.js";

// dentro de _createConnectedSocket, depois de: conn.socket = socket;
initWhatsAppHandlers(socket as never, async (phone) => {
  // Consulte seu banco/API do Servix e retorne "BASIC" | "STANDARD" | "PROFESSIONAL" | "ENTERPRISE" | null
  return null;
});
```

Depois configure `AI_API_KEY` e, se quiser, `AI_MODEL`. O prompt do sistema (planos, preços, fluxos) fica em `geminiService.ts`; **atualize-o sempre que os planos mudarem**. Os contatos de suporte humano também estão fixos no código (`whatsappHandler.ts` e `geminiService.ts`).

---

## 🛡️ Segurança e comportamento

- `x-api-key` comparada com `timingSafeEqual` (resistente a timing attack).
- `helmet`, CORS restrito por `ALLOWED_ORIGINS`, rate limit de 30 req/min e body limitado a 64 KB.
- Proteção contra **path traversal** no diretório de sessões (UUID validado).
- Erros 5xx nunca expõem stack trace.
- **Reconexão:** até 8 tentativas com backoff de 2 s a 30 s (±20% de jitter). Se o usuário deslogar pelo celular, a sessão é encerrada.
- **Health check** a cada 2 min recria sessões sem sinal de vida há mais de 5 min.
- **Limpeza:** sessões desconectadas e ociosas por mais de 30 min saem da memória.
- **Shutdown gracioso** em `SIGTERM`/`SIGINT`.

## ⚠️ Limitações conhecidas

- O estado (conexões e histórico da IA) fica **em memória**: rode **uma única instância** (não escala horizontalmente sem refatorar).
- `/connections/stats` é **público** por design (monitoramento). Ele só expõe contagens, mas restrinja no proxy/firewall se preferir.
- `POST /connect/:id` sempre **descarta a sessão anterior** e gera novo QR, exceto se já estiver conectado.
- Biblioteca não oficial (Baileys): o WhatsApp pode alterar o protocolo e o uso em massa pode gerar bloqueio de número. Use com responsabilidade e respeite os Termos do WhatsApp.

## 🧰 Stack

Node.js 22 · TypeScript · Fastify 5 · Baileys 7 (rc) · Google Generative AI · QRCode · https-proxy-agent · Docker · Railway · pnpm

---

## 👨‍💻 Desenvolvedor

**Warley Coutinho**
Desenvolvedor Full Stack

- 💼 LinkedIn: [linkedin.com/in/coutinho-warley](https://www.linkedin.com/in/coutinho-warley)
- 🌐 Portfólio: [warley-portfolio.vercel.app](https://warley-portfolio.vercel.app/)
