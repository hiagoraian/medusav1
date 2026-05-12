# Configura netsh portproxy (requer admin) e inicia o servidor Medusa

$rules = @(
    @{ dockerPort = 9085; adbPort = 8085 },
    @{ dockerPort = 9086; adbPort = 8086 },
    @{ dockerPort = 9087; adbPort = 8087 },
    @{ dockerPort = 9088; adbPort = 8088 }
)

Write-Host "Configurando portproxy..." -ForegroundColor Cyan
foreach ($rule in $rules) {
    netsh interface portproxy delete v4tov4 listenport=$($rule.dockerPort) listenaddress=0.0.0.0 2>$null | Out-Null
    netsh interface portproxy add v4tov4 listenport=$($rule.dockerPort) listenaddress=0.0.0.0 connectport=$($rule.adbPort) connectaddress=127.0.0.1 | Out-Null
    Write-Host "  :$($rule.dockerPort) -> 127.0.0.1:$($rule.adbPort)" -ForegroundColor Green
}

Write-Host "Iniciando Medusa..." -ForegroundColor Cyan
Set-Location "C:\medusa"
node --env-file=.env server.js
