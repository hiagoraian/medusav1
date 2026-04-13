# 🚀 Medusa - Orquestrador de Disparos v4.0 (Resiliente)

O Medusa é um sistema avançado de automação de mensagens WhatsApp com suporte a 28 contas, projetado para operar com alta performance e resiliência total a falhas.

## ✨ Novidades da Versão 4.0 (Refatorada)

### 1. **Persistência de Estado Real**
- **Sem Perda de Dados:** O banco de dados SQLite não é mais deletado ao iniciar. Todas as campanhas, filas e relatórios são mantidos.
- **Recuperação Pós-Falha:** Se o computador desligar ou o sistema cair, ao reiniciar, o Medusa detecta campanhas interrompidas e permite retomar exatamente de onde parou.

### 2. **Resiliência ADB e ZTE**
- **Retries Automáticos:** Configuração de portas ADB agora possui tentativas automáticas (retries) em caso de falha de conexão inicial.
- **Monitoramento de Saúde:** Verificação contínua do status dos dispositivos ZTE.

### 3. **Disparos e Naturalidade**
- **Divisão Equilibrada:** As mensagens por ciclo são divididas de forma exata entre os aparelhos ativos (ex: 16 disparos por zap em ciclos de 30 min).
- **Tratamento de Números Inválidos:** Números que não possuem WhatsApp são identificados e destacados nos relatórios, sem interromper o fluxo.
- **Simulação Humana:** Delays aleatórios e simulação de digitação aprimorados para máxima naturalidade.

### 4. **Relatórios Automáticos**
- **Salvamento Automático:** Ao final de cada ciclo de 30 minutos, relatórios gerais e de falhas são salvos automaticamente na pasta `reports/`.
- **Crash Dump:** Em caso de erro fatal, o sistema gera um log de emergência com o estado atual antes de encerrar.

### 5. **Novo Sistema de Aquecimento**
- **textAquecimento.txt:** Agora você pode editar os diálogos de aquecimento diretamente em um arquivo de texto simples, um por linha.
- **Conversação Natural:** Os chips conversam entre si de forma aleatória e natural até que o comando de parada seja enviado.

---

## 📋 Arquitetura v4.0

```
medusa/
├── server.js                          # Servidor Express (Resiliente)
├── ARCHITECTURE.md                    # Documentação técnica da v4.0
├── textAquecimento.txt                # Seus diálogos de aquecimento (Edite aqui!)
├── orquestrador.sqlite                # Banco de dados persistente
├── reports/                           # Relatórios automáticos por ciclo
├── src/
│   ├── database/
│   │   └── db.js                      # Inicialização persistente do SQLite
│   ├── services/
│   │   ├── antiSpam.js                # Spintax, delays humanos, digitação
│   │   ├── chipWarmup.js              # Aquecimento via arquivo de texto
│   │   ├── networkController.js       # Controle de rede e ADB com Retries
│   │   ├── orchestrator.js            # Orquestrador com relatórios automáticos
│   │   └── queueService.js            # Gerenciamento de fila persistente
│   └── whatsapp/
│       ├── manager.js                 # Gerenciador de contas WhatsApp
│       └── sender.js                  # Envio com tratamento de números inválidos
```

---

## 🔧 Instalação e Setup

### 1. Instalar Dependências
```bash
cd medusa
npm install
```

### 2. Configurar ADB
Certifique-se de que o ADB está no PATH ou no caminho padrão:
- **Windows:** `C:\adb\adb.exe`
- **Linux:** `/usr/bin/adb`

### 3. Iniciar o Servidor
```bash
npm start
```
Acesse: `http://localhost:3000`

---

## 🌐 Distribuição de Zaps por Porta

- **ZTE 1 (Zaps 1-12):** Porta 8080
- **ZTE 2 (Zaps 13-20):** Porta 8081
- **ZTE 3 (Zaps 21-28):** Porta 8082

---

## 📊 Funcionamento dos Ciclos

1. **Upload:** Suba sua lista Excel.
2. **Seleção:** Escolha os Zaps ativos.
3. **Configuração:** Defina as mensagens por ciclo (ex: 466 para 28 zaps = ~16 por zap).
4. **Horários:** Defina os horários de início dos ciclos.
5. **Execução:** O sistema divide a carga, dispara simultaneamente em 30 min, rotaciona IPs e gera relatórios.
6. **Aquecimento:** Após o ciclo, os zaps entram em aquecimento automático de 5 min.

---

## 🔐 Segurança e Resiliência

- **Crash Recovery:** Se o sistema cair, os números que faltam estarão salvos no banco.
- **Relatório de Erro:** Verifique `reports/crashes/` para entender por que o sistema parou.
- **IP Rotation:** Rotação automática via Modo Avião ao final de cada ciclo para evitar bloqueios.

---
**Versão:** 4.0.0  
**Desenvolvido para Máxima Resiliência e Performance.**
