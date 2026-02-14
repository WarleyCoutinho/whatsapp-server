FROM node:20-alpine

RUN apk add --no-cache libc6-compat python3 make g++

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

RUN mkdir -p /app/whatsapp-auth

EXPOSE 3001

CMD ["node", "dist/index.js"]
