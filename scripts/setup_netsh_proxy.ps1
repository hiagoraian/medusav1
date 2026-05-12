# Executar como Administrador
# Cria portproxy rules para expor portas ADB (127.0.0.1) em 0.0.0.0
# Necessario para que o Docker acesse o proxy 4G dos celulares

$rules = @(
    @{ dockerPort = 9085; adbPort = 8085; nome = "ZTE1" },
    @{ dockerPort = 9086; adbPort = 8086; nome = "ZTE2" },
    @{ dockerPort = 9087; adbPort = 8087; nome = "ZTE3" },
    @{ dockerPort = 9088; adbPort = 8088; nome = "ZTE4" }
)

Write-Host "=== Configurando netsh portproxy para 4G via Docker ===" -ForegroundColor Cyan
Write-Host ""

foreach ($rule in $rules) {
    Write-Host "[$($rule.nome)] Porta $($rule.dockerPort) -> 127.0.0.1:$($rule.adbPort)..." -ForegroundColor Yellow

    netsh interface portproxy delete v4tov4 listenport=$($rule.dockerPort) listenaddress=0.0.0.0 2>$null | Out-Null
    netsh interface portproxy add v4tov4 `
        listenport=$($rule.dockerPort) `
        listenaddress=0.0.0.0 `
        connectport=$($rule.adbPort) `
        connectaddress=127.0.0.1

    if ($?) {
        Write-Host "[$($rule.nome)] OK" -ForegroundColor Green
    } else {
        Write-Host "[$($rule.nome)] FALHOU - Execute como Administrador!" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "=== Regras ativas ===" -ForegroundColor Cyan
netsh interface portproxy show v4tov4
