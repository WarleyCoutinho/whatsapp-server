FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

RUN mkdir -p /app/whatsapp-auth

ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/index.js"]
