$ld      = "C:\LDPlayer\LDPlayer9\ldconsole.exe"
$package = "com.whatsapp"

$instancias = @(
    "ZTE1-A","ZTE1-B","ZTE1-C",
    "ZTE2-A","ZTE2-B","ZTE2-C",
    "ZTE3-A","ZTE3-B","ZTE3-C",
    "ZTE4-A","ZTE4-B","ZTE4-C"
)

Write-Host "=== Instalando WhatsApp via Play Store nas 12 instancias ===" -ForegroundColor Cyan
Write-Host "PRE-REQUISITO: conta Google ja configurada em cada instancia" -ForegroundColor Yellow
Write-Host ""

foreach ($inst in $instancias) {
    Write-Host "[$inst] Iniciando emulador..." -ForegroundColor Yellow
    & $ld launch --name $inst | Out-Null

    Write-Host "[$inst] Aguardando Android iniciar (60s)..." -ForegroundColor Gray
    Start-Sleep -Seconds 60

    Write-Host "[$inst] Instalando WhatsApp pela Play Store..." -ForegroundColor Yellow
    & $ld installapp --name $inst --packagename $package

    Write-Host "[$inst] Aguardando instalacao (30s)..." -ForegroundColor Gray
    Start-Sleep -Seconds 30

    Write-Host "[$inst] Fechando emulador..." -ForegroundColor Gray
    & $ld quit --name $inst | Out-Null
    Start-Sleep -Seconds 8

    Write-Host "[$inst] OK" -ForegroundColor Green
    Write-Host ""
}

Write-Host "=== Concluido! ===" -ForegroundColor Cyan
