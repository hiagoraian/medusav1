# Arquitetura e Plano de Refatoração do Medusa v4.0

## 1. Visão Geral
O Medusa é um sistema de automação de disparos e aquecimento de contas do WhatsApp, operando com até 28 instâncias simultâneas via modems ZTE e conexões ADB. A versão atual (v3.2) apresenta gargalos de resiliência, perda de estado em caso de falhas e falta de flexibilidade no aquecimento.

A versão refatorada (v4.0) focará em **Persistência de Estado**, **Resiliência de Conexão** e **Relatórios Automáticos**.

## 2. Problemas Identificados na v3.2

1. **Perda de Dados no Reinício:** O arquivo `db.js` deleta o banco de dados SQLite a cada inicialização do servidor. Isso impede a retomada de campanhas interrompidas e a geração de relatórios pós-falha.
2. **Falta de Tratamento de Erros ADB:** O `networkController.js` tenta configurar os forwards ADB de forma síncrona e sem tentativas de reconexão (retries) robustas. Se um modem falha, a instância do WhatsApp associada fica inoperante.
3. **Aquecimento Estático:** O `chipWarmup.js` utiliza um arquivo JSON fixo (`warmup_phrases.json`), dificultando a edição rápida de diálogos pelo usuário.
4. **Relatórios Manuais:** Os relatórios de ciclo e de falhas só são gerados quando solicitados via API, não havendo salvamento automático em disco ao final de cada ciclo ou em caso de crash do sistema.
5. **Falta de Identificação de Números Inexistentes:** Embora o `sender.js` identifique números sem WhatsApp, essa informação não é tratada de forma destacada nos relatórios finais.

## 3. Plano de Refatoração (v4.0)

### 3.1. Persistência e Resiliência (Banco de Dados)
- **Remover a exclusão do banco de dados:** O `db.js` será alterado para manter o banco de dados existente.
- **Tabela de Estado da Campanha:** Adicionar uma tabela ou gerenciar o estado na tabela `dispatch_cycles` para saber exatamente qual ciclo estava em andamento e quais mensagens faltam.
- **Recuperação Automática:** Ao iniciar, o servidor verificará se há ciclos `em_andamento` e perguntará/retomará automaticamente os disparos pendentes.

### 3.2. Otimização de Conexão ADB e ZTE
- **Gerenciador de Conexão Robusto:** Implementar um sistema de *retry* exponencial para a configuração do ADB.
- **Monitoramento Contínuo:** O sistema verificará periodicamente a saúde da conexão ADB e tentará reconectar automaticamente caso um modem ZTE caia.

### 3.3. Lógica de Disparos e Naturalidade
- **Distribuição Inteligente:** Garantir que as 466 mensagens por ciclo sejam divididas exatamente entre os aparelhos ativos.
- **Delays Dinâmicos:** Aprimorar a função `humanDelay` para variar o tempo de digitação e envio com base no tamanho da mensagem e no histórico recente do aparelho.
- **Tratamento de Números Inexistentes:** Marcar explicitamente números não encontrados no WhatsApp e incluí-los em uma seção separada do relatório.

### 3.4. Relatórios Automáticos
- **Geração Automática por Ciclo:** Ao final de cada ciclo de 30 minutos, o relatório será gerado automaticamente em uma pasta `reports/` e salvo em formato legível (TXT/CSV/Markdown).
- **Relatório de Crash (Dump):** Implementar um tratador de exceções globais (`process.on('uncaughtException')`) que gera um relatório de emergência com o status atual antes de o servidor desligar.

### 3.5. Novo Sistema de Aquecimento
- **Arquivo de Texto Simples:** Substituir o `warmup_phrases.json` por um arquivo `textAquecimento.txt`, onde cada linha é uma frase ou diálogo.
- **Lógica de Conversação Natural:** Os aparelhos conversarão entre si usando as frases do arquivo, com delays aleatórios e simulação de digitação, até que o usuário clique em "Parar Aquecimento".

## 4. Próximos Passos de Implementação
1. Modificar `db.js` e `queueService.js` para persistência real.
2. Refatorar `networkController.js` para resiliência ADB.
3. Atualizar `orchestrator.js` e `sender.js` para relatórios automáticos e tratamento de números inválidos.
4. Criar o novo módulo de aquecimento baseado em `textAquecimento.txt`.
5. Implementar o sistema de *Crash Dump* no `server.js`.
