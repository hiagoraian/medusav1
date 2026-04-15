# Medusa — Orquestrador de Disparos WhatsApp

Sistema de automação de mensagens WhatsApp com suporte a 24 contas simultâneas, projetado para operar com alta resiliência, naturalidade humana nos envios e recuperação automática de falhas.

---

## Funcionalidades

### Disparos
- Upload de listas Excel com deduplicação automática
- Distribuição equilibrada entre os zaps ativos
- Suporte a texto com **Spintax** `{Olá|Oi} {cliente|amigo}`
- Suporte a mídia (imagem/vídeo) como legenda ou separada
- Agendamento por horários com ciclos de 45 minutos
- Parada limpa da campanha a qualquer momento
- Envio de teste antes de disparar para a lista

### Resiliência
- Banco de dados SQLite persistente — sem perda de dados ao reiniciar
- Recuperação automática de campanhas interrompidas por queda do sistema
- Crash dump com estado completo salvo em `reports/crashes/`
- Retry automático no Chromium em erros recuperáveis
- Zap "fantasma" detectado e tratado (página morta mas objeto ativo)
- Inicialização escalonada dos Chromiums para evitar pico de memória

### Conexão e Rede
- Suporte a 3 modems ZTE via ADB com retry automático por porta
- Failover automático para Wi-Fi do PC se dados móveis falharem
- Rotação de IP via Modo Avião ao final de cada ciclo
- Verificação real do status do zap (página + objetos internos do WA Web)

### Aquecimento
- Conversação natural entre pares de zaps via `textAquecimento.txt`
- Remoção automática de zaps desconectados durante o aquecimento
- Aquecimento rápido pós-ciclo (5 min)

### Gestão de Zaps
- Reconexão em massa com progresso em tempo real
- Status de conexão visual por zap (verde/vermelho)
- Exclusão de cache de sessão individual ou em massa

---

## Arquitetura

```
medusa/
├── server.js                          # Servidor Express + rotas da API
├── textAquecimento.txt                # Frases de aquecimento (uma por linha)
├── orquestrador.sqlite                # Banco de dados persistente
├── reports/                           # Relatórios por ciclo e crashes
├── public/
│   ├── index.html                     # Painel principal de disparos
│   └── zaps.html                      # Gestão de zaps e aquecimento
└── src/
    ├── database/
    │   └── db.js                      # Inicialização e schema do SQLite
    ├── services/
    │   ├── antiSpam.js                # Spintax, delays humanos, simulação de digitação
    │   ├── chipWarmup.js              # Aquecimento entre pares de zaps
    │   ├── delayCalculator.js         # Cálculo de delays adaptativos por ciclo
    │   ├── excelProcessor.js          # Leitura e normalização de listas Excel
    │   ├── mediaProcessor.js          # Processamento e hash de mídia
    │   ├── networkController.js       # ADB, ZTE, rotação de IP
    │   ├── orchestrator.js            # Loop de campanha e controle de ciclos
    │   ├── queueService.js            # Fila persistente de disparos
    │   └── reportGenerator.js         # Geração de relatórios por ciclo
    ├── tests/
    │   ├── antiSpam.test.js           # Testes de spintax e delays
    │   ├── excelProcessor.test.js     # Testes de normalização de números
    │   └── sender.test.js             # Testes de formatação de telefone
    └── whatsapp/
        ├── manager.js                 # Ciclo de vida das instâncias WhatsApp
        └── sender.js                  # Envio individual com anti-spam
```

---

## Instalação

```bash
npm install
npm start
```

Acesse: `http://localhost:3000`

### Pré-requisito: ADB
O ADB deve estar disponível no sistema:
- **Windows:** `C:\adb\adb.exe`
- **Linux/Mac:** `/usr/bin/adb`

---

## Distribuição de Zaps por Modem

| Modem | Zaps     | Porta |
|-------|----------|-------|
| ZTE 1 | WA-01–08 | 8080  |
| ZTE 2 | WA-09–16 | 8081  |
| ZTE 3 | WA-17–24 | 8082  |

---

## Fluxo de Disparo

1. **Upload** — Suba a lista Excel (`.xlsx`)
2. **Seleção** — Escolha os zaps ativos (dots verdes)
3. **Configuração** — Defina mensagens por ciclo (sugestão: 16 por zap × nº de zaps)
4. **Horários** — Selecione os horários de início dos ciclos
5. **Conteúdo** — Digite o texto (com Spintax) e anexe mídia se necessário
6. **Teste** — Envie para um número real antes de disparar para a lista
7. **Disparo** — Inicie o orquestrador. Cada ciclo dura 45 minutos.
8. **Aquecimento** — Após os disparos, aqueça os chips pelo painel de gestão

---

## Testes

```bash
npm test
```

19 testes cobrindo spintax, delays, normalização de telefone e processamento de Excel.
