# Medusa — Arquitetura do Sistema

## Visão Geral

O Medusa opera com até 24 instâncias simultâneas do WhatsApp Web, cada uma rodando em um processo Chromium isolado via Puppeteer. Três modems ZTE fornecem IPs móveis independentes via ADB, com rotação automática ao final de cada ciclo.

---

## Camadas

### 1. Interface (`public/`)
Duas páginas HTML com JavaScript puro, sem framework:

- **`index.html`** — Painel principal: upload de lista, seleção de zaps, configuração de ciclo, conteúdo da mensagem, envio de teste e dashboard em tempo real.
- **`zaps.html`** — Gestão de contas: conectar individualmente ou em massa, excluir cache de sessão, aquecimento de chips, status ADB.

A UI se comunica com o servidor via `fetch` e faz polling periódico nas rotas de status.

---

### 2. Servidor (`server.js`)
Express.js com as seguintes responsabilidades:
- Servir os arquivos estáticos
- Expor a API REST para a UI
- Gerenciar upload de arquivos (Excel via memória, mídia via disco temporário)
- Capturar erros fatais (`uncaughtException`, `unhandledRejection`) e salvar crash dump antes de encerrar

---

### 3. Serviços (`src/services/`)

| Serviço | Responsabilidade |
|---------|-----------------|
| `orchestrator.js` | Loop principal de campanha: busca pendentes, distribui entre zaps, controla ciclos de 45 min, gera relatórios, rotaciona IPs |
| `queueService.js` | CRUD da fila de mensagens e ciclos no SQLite |
| `chipWarmup.js` | Conversação natural entre pares de zaps usando frases do `textAquecimento.txt` |
| `networkController.js` | Configuração ADB, verificação de dispositivos ZTE, modo avião para rotação de IP |
| `antiSpam.js` | Processamento de Spintax, delays aleatórios, simulação de digitação |
| `delayCalculator.js` | Cálculo de delays adaptativos baseados em mensagens por ciclo |
| `excelProcessor.js` | Leitura de `.xlsx`, normalização de números brasileiros, deduplicação |
| `mediaProcessor.js` | Hash único por arquivo de mídia para evitar bloqueios por hash repetido |
| `reportGenerator.js` | Geração de relatórios por ciclo (enviados, falhas, inválidos) |

---

### 4. WhatsApp (`src/whatsapp/`)

**`manager.js`** — Ciclo de vida das instâncias:
- Inicializa o Chromium com flags de baixo consumo de memória
- Aguarda `client.info.wid` estar disponível antes de marcar o zap como pronto (evita erros de objetos internos do WA Web não inicializados)
- Expõe `isClientReady` que verifica: objeto no mapa + página Chromium aberta + `client.info.wid` disponível
- Inicialização em massa com 5s de intervalo entre cada zap para evitar pico de OOM
- Retry automático em erros recuperáveis do Puppeteer

**`sender.js`** — Envio individual:
- Normalização defensiva do número antes de qualquer operação
- Retry em erros internos do WA Web (`WidFactory`, `Store`, `Execution context`)
- Timeout de 15s no `getNumberId` para evitar hang em caso de congelamento do WA Web
- Simulação de digitação proporcional ao tamanho do texto

---

### 5. Banco de Dados (`src/database/db.js`)

SQLite com três tabelas:

```sql
messages_queue      -- Fila de contatos com status por mensagem
dispatch_cycles     -- Ciclos de disparo com contadores de enviados/falhas
system_state        -- Estado global chave-valor (reservado para uso futuro)
```

O banco é persistente entre reinicializações. Ao iniciar, o servidor detecta ciclos `em_andamento` e oferece retomada ou suspensão.

---

## Fluxo de um Ciclo de Disparo

```
1. UI envia POST /api/start-campaign
2. server.js cria um registro em dispatch_cycles
3. orchestrator.js busca N mensagens pendentes (ORDER BY id ASC)
4. Distribui igualmente entre os zaps ativos (round-robin por índice)
5. Cada zap dispara sua fila em paralelo com delays humanos
6. A cada mensagem: verifica isClientReady → normaliza telefone →
   getNumberId (retry) → simulateTyping → sendMessage → persiste status
7. Ao final: gera relatório, rotaciona IPs via ADB, aguarda próximo ciclo
```

---

## Resiliência

| Cenário | Comportamento |
|---------|--------------|
| Servidor cai durante disparo | Ciclo marcado como `em_andamento`; ao reiniciar, UI oferece retomar ou suspender |
| Zap desconecta durante disparo | Mensagens daquele zap marcadas como `falha`; os outros continuam |
| Chromium trava (OOM) | `isClientReady` detecta página fechada; zap tratado como offline |
| WA Web não inicializou | `isClientReady` aguarda `client.info.wid`; sender faz retry em `WidFactory` |
| Modem ZTE cai | Failover automático para Wi-Fi do PC |
| Erro fatal não tratado | Crash dump salvo em `reports/crashes/` antes do processo encerrar |

---

## Rede e Proxies

Cada grupo de 8 zaps usa um modem ZTE como proxy:

```
ZTE 1 → WA-01 a WA-08  (porta 8080)
ZTE 2 → WA-09 a WA-16  (porta 8081)
ZTE 3 → WA-17 a WA-24  (porta 8082)
```

O `networkController.js` configura os forwards via `adb forward tcp:PORT tcp:PORT`. Se o proxy não responder (verificado com `curl` com timeout), o zap cai automaticamente para o Wi-Fi do PC.
