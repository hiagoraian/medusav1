# 🔗 Guia de Configuração ADB para Rotação de IP 4G

## 📱 Dispositivos Configurados

```
Porta 8080 (ZTE 1) → Zaps 1-12
Porta 8081 (ZTE 2) → Zaps 13-20
Porta 8082 (ZTE 3) → Zaps 21-28

Device IDs:
- 320436309078 (ZTE 1)
- 320436306469 (ZTE 2)
- 320436306616 (ZTE 3)
```

---

## 🪟 Windows Setup

### 1. Instalar ADB
1. Download: https://developer.android.com/studio/releases/platform-tools
2. Extrair em: `C:\adb\`
3. Adicionar ao PATH (opcional)

### 2. Conectar Dispositivos
```bash
# Ligar USB Debug nos celulares
# Configurações → Sobre o Telefone → Tocar 7x em "Número da Compilação"
# Configurações → Opções do Desenvolvedor → Ativar "Depuração USB"

# Conectar via USB e autorizar

# Verificar conexão
C:\adb\adb.exe devices

# Resultado esperado:
# 320436309078    device
# 320436306469    device
# 320436306616    device
```

### 3. Configurar Forwards (Manual)
```bash
C:\adb\adb.exe -s 320436309078 forward tcp:8080 tcp:8080
C:\adb\adb.exe -s 320436306469 forward tcp:8081 tcp:8081
C:\adb\adb.exe -s 320436306616 forward tcp:8082 tcp:8082
```

### 4. Verificar Forwards
```bash
C:\adb\adb.exe forward --list

# Resultado esperado:
# 320436309078 tcp:8080 tcp:8080
# 320436306469 tcp:8081 tcp:8081
# 320436306616 tcp:8082 tcp:8082
```

---

## 🐧 Linux Setup

### 1. Instalar ADB
```bash
sudo apt-get update
sudo apt-get install -y android-tools-adb android-tools-fastboot
```

### 2. Conectar Dispositivos
```bash
# Mesmo processo do Windows
adb devices

# Autorizar no celular quando aparecer a notificação
```

### 3. Configurar Forwards
```bash
adb -s 320436309078 forward tcp:8080 tcp:8080
adb -s 320436306469 forward tcp:8081 tcp:8081
adb -s 320436306616 forward tcp:8082 tcp:8082
```

---

## 🍎 macOS Setup

### 1. Instalar ADB
```bash
# Via Homebrew
brew install android-platform-tools

# Ou download manual
# https://developer.android.com/studio/releases/platform-tools
```

### 2. Conectar e Configurar
```bash
# Mesmo processo anterior
adb devices
adb -s 320436309078 forward tcp:8080 tcp:8080
adb -s 320436306469 forward tcp:8081 tcp:8081
adb -s 320436306616 forward tcp:8082 tcp:8082
```

---

## 🔄 Rotação de IP Automática

### Como Funciona
1. Sistema detecta quando termina uma onda de disparos
2. Liga Modo Avião em todos os dispositivos
3. Aguarda 15 segundos (para limpar conexão)
4. Desliga Modo Avião
5. Aguarda 5 segundos para reconectar
6. Novo IP 4G é obtido automaticamente

### Monitoramento
```bash
# Ver logs no terminal
🔄 [REDE] Rotacionando IP do dispositivo: 320436309078
✈️ [REDE] Modo Avião LIGADO: 320436309078
⏳ [REDE] Aguardando 15 segundos para limpar conexão...
📶 [REDE] Modo Avião DESLIGADO: 320436309078
✅ [REDE] IP rotacionado com sucesso: 320436309078
```

---

## ⚙️ Configuração Avançada

### Customizar Dispositivos
Edite `src/services/networkController.js`:

```javascript
const ZTE_CONFIG = {
    8080: {
        devices: ['SEU_DEVICE_ID_1'],
        description: 'ZTE 1 (Zaps 1-12)',
        port: 8080
    },
    8081: {
        devices: ['SEU_DEVICE_ID_2'],
        description: 'ZTE 2 (Zaps 13-20)',
        port: 8081
    },
    8082: {
        devices: ['SEU_DEVICE_ID_3'],
        description: 'ZTE 3 (Zaps 21-28)',
        port: 8082
    }
};
```

### Customizar Delay de Rotação
```javascript
// Em delayCalculator.js
export const calculateIPRotationDelay = () => {
    // Entre 15 a 30 segundos (customize aqui)
    return Math.floor(Math.random() * 15000) + 15000;
};
```

---

## 🧪 Testes

### Teste 1: Verificar Conexão
```bash
adb devices
# Deve listar todos os 3 dispositivos
```

### Teste 2: Verificar Forwards
```bash
adb forward --list
# Deve mostrar as 3 portas configuradas
```

### Teste 3: Testar Modo Avião
```bash
# Ligar
adb -s 320436309078 shell cmd connectivity airplane-mode enable

# Desligar
adb -s 320436309078 shell cmd connectivity airplane-mode disable

# Verificar
adb -s 320436309078 shell settings get global airplane_mode_on
# Retorna: 1 (ligado) ou 0 (desligado)
```

### Teste 4: Obter IP Atual
```bash
adb -s 320436309078 shell ip addr show | grep "inet "
# Mostra o IP atual do dispositivo
```

---

## 🚨 Troubleshooting

### Problema: "adb: command not found"
**Solução:**
```bash
# Windows: Adicione C:\adb\ ao PATH
# Linux: sudo apt-get install android-tools-adb
# macOS: brew install android-platform-tools
```

### Problema: "no devices found"
**Solução:**
1. Verifique se USB Debug está ativado
2. Reconecte o cabo USB
3. Autorize a conexão no celular
4. Tente: `adb kill-server && adb start-server`

### Problema: "Permission denied"
**Solução (Linux):**
```bash
sudo usermod -a -G plugdev $USER
# Desconecte e reconecte o USB
```

### Problema: Modo Avião não funciona
**Solução:**
1. Verifique se o dispositivo está conectado
2. Tente manualmente: `adb shell cmd connectivity airplane-mode enable`
3. Verifique se é Android 10+

---

## 📊 Monitoramento em Tempo Real

### Ver Status dos Dispositivos
```bash
# Via API
curl http://localhost:3000/api/devices-status

# Resultado:
{
  "available": true,
  "devices": [
    {
      "port": "8080",
      "deviceId": "320436309078",
      "connected": true
    },
    ...
  ]
}
```

### Ver Logs de Rotação
```bash
# No terminal do Node.js
# Procure por: 🔄 [REDE]
```

---

## 🔐 Segurança

### Boas Práticas
1. **Não compartilhe IDs de dispositivos**
2. **Use VPN/Proxy** para evitar bloqueios de IP
3. **Monitore o uso** de dados 4G
4. **Teste com poucos contatos** antes de campanhas grandes
5. **Faça backup** das sessões (`.wwebjs_auth`)

---

## 📝 Checklist de Setup

- [ ] ADB instalado e no PATH
- [ ] 3 dispositivos conectados via USB
- [ ] USB Debug ativado em todos
- [ ] Forwards configurados (3 portas)
- [ ] `adb devices` mostra 3 dispositivos
- [ ] `adb forward --list` mostra 3 forwards
- [ ] Modo Avião funciona manualmente
- [ ] Node.js iniciado com sucesso
- [ ] Painel acessível em http://localhost:3000

---

## 🎯 Próximos Passos

1. Gere as sessões QR Code para os 28 zaps
2. Teste o aquecimento de chips
3. Faça upload de uma pequena lista de teste
4. Inicie uma campanha de teste
5. Monitore os logs e o banco de dados

---

**Última Atualização:** Abril 2026  
**Versão:** 2.0.0
