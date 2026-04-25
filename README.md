# Medusa Evolution v2

Sistema de disparo WhatsApp em massa com 24 contas simultâneas.  
Usa Evolution API (Baileys) — sem Chromium, sem Puppeteer.

---

## Stack

| Camada | Tecnologia |
|--------|-----------|
| WhatsApp | Evolution API (Baileys) via Docker |
| Fila | RabbitMQ — persistente por conta |
| Banco | PostgreSQL |
| Cache | Redis |
| Servidor | Node.js 20+ (ESM) |

---

## Funcionalidades

- **Disparo em ondas** — sub-grupos de 4 zaps com offset escalonado, criando um padrão de envio natural e contínuo
- **3 níveis de disparo** — controle de volume e velocidade (3/5/8 msgs por zap por onda)
- **Aquecimento 1-10** — conversas automáticas entre os zaps durante as pausas, com imagens e áudios opcionais
- **Janela de horário** — define início e fim do disparo diário
- **Rotação de IP** — modo avião automático via ADB nos ZTEs a cada 3 ondas
- **Proxy 4G por conta** — cada zap roteia pelo modem ZTE correspondente; cai para Wi-Fi se o 4G cair
- **Detecção de órfãos** — zap que cai durante o disparo tem a fila drenada automaticamente e os números vão para o relatório de falhas
- **Validação 5 camadas** — normalização de telefones brasileiros (DDD, 9º dígito, comprimento)
- **Spintax** — variações de texto: `{Olá|Oi} {cliente|amigo}!`
- **3 relatórios planos** — `enviados.txt`, `invalidos.txt`, `falhas.txt`

---

## Instalação rápida

### Pré-requisitos
- [Node.js v20+](https://nodejs.org)
- [Docker Desktop](https://www.docker.com/products/docker-desktop)
- ADB em `C:\adb\adb.exe` (para rotação de IP)

### Setup

```bash
git clone https://github.com/hiagoraian/medusa-evolution.git medusa
cd medusa
npm install
copy .env.example .env   # edite com os seriais dos ZTEs
docker compose up -d
npm start
```

Acesse: **http://localhost:3000**

---

## Configuração (.env)

```env
EVOLUTION_API_KEY=medusa-evolution-secret-key
POSTGRES_PASSWORD=medusa_strong_password
RABBITMQ_PASSWORD=medusa_rabbitmq_password
DATABASE_URL=postgresql://medusa:medusa_strong_password@localhost:5432/medusa
RABBITMQ_URL=amqp://medusa:medusa_rabbitmq_password@localhost:5672
PORT=3000

# Seriais dos ZTEs (adb devices)
ZTE_1_SERIAL=XXXXXXXX   # Zaps WA-01 a WA-08
ZTE_2_SERIAL=XXXXXXXX   # Zaps WA-09 a WA-16
ZTE_3_SERIAL=XXXXXXXX   # Zaps WA-17 a WA-24
```

---

## Arquitetura

```
medusa/
├── docker-compose.yml          # Evolution API, PostgreSQL, Redis, RabbitMQ
├── docker/postgres-init.sh     # Cria banco "evolution" para a Evolution API
├── server.js                   # Express — API REST + webhooks
├── public/
│   ├── index.html              # Painel de disparos
│   └── zaps.html               # Gestão de zaps (QR code, status)
├── warmup_media/
│   ├── imagens/                # Imagens usadas no aquecimento
│   └── audios/                 # Áudios usados no aquecimento
└── src/
    ├── database/postgres.js    # Pool PostgreSQL + schema
    ├── evolution/client.js     # Cliente HTTP para a Evolution API
    ├── queue/
    │   ├── producer.js         # Publica tarefas no RabbitMQ
    │   └── worker.js           # Consome e dispara (offset de onda + detecção de órfão)
    └── services/
        ├── orchestrator.js     # Loop de campanha (ondas, aquecimento, rotação)
        ├── chipWarmup.js       # Aquecimento entre zaps
        ├── networkController.js# ADB, ZTE, proxy 4G, rotação de IP
        ├── queueService.js     # Operações no banco (fila, ciclos)
        ├── reportGenerator.js  # Gera enviados/invalidos/falhas.txt
        ├── excelProcessor.js   # Normalização de telefones do Excel
        └── antiSpam.js         # Spintax + delays humanizados
```

---

## Testes

```bash
node --test src/tests/antiSpam.test.js
node --test src/tests/excelProcessor.test.js
```
