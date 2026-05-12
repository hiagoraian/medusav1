$ld      = "C:\LDPlayer\LDPlayer9\ldconsole.exe"
$aptoide = "C:\Users\Convidado!\Downloads\aptoide.apk"

$instancias = @(
    @{ nome = "Medusa 40"; modelo = "SM-S901B" },
    @{ nome = "Medusa 41"; modelo = "SM-A536B" },
    @{ nome = "Medusa 42"; modelo = "SM-G996B" },
    @{ nome = "Medusa 43"; modelo = "SM-A226B" },
    @{ nome = "Medusa 44"; modelo = "SM-A525F" },
    @{ nome = "Medusa 45"; modelo = "SM-M526B" },
    @{ nome = "Medusa 46"; modelo = "SM-S906B" },
    @{ nome = "Medusa 47"; modelo = "SM-A035G" },
    @{ nome = "Medusa 48"; modelo = "SM-A336B" }
)

if (!(Test-Path $aptoide)) {
    Write-Host "ERRO: aptoide.apk nao encontrado em $aptoide" -ForegroundColor Red
    exit 1
}

# ── Etapa 1: Criar e configurar instancias ─────────────────────────────────────

Write-Host ""
Write-Host "=== ETAPA 1: Criando 9 instancias (Medusa 40-48) ===" -ForegroundColor Cyan
Write-Host ""

foreach ($inst in $instancias) {
    Write-Host "[$($inst.nome)] Criando..." -ForegroundColor Yellow
    & $ld add --name $inst.nome | Out-Null
    Start-Sleep -Seconds 2

    & $ld modify --name $inst.nome `
        --manufacturer samsung `
        --model $inst.modelo `
        --imei auto `
        --imsi auto `
        --simserial auto `
        --androidid auto `
        --mac auto `
        --memory 2048 `
        --cpu 2 `
        --resolution 720,1280,320 | Out-Null

    Write-Host "[$($inst.nome)] OK - $($inst.modelo)" -ForegroundColor Green
    Start-Sleep -Seconds 1
}

# ── Obter indices pelo list2 ───────────────────────────────────────────────────

$list2 = & $ld list2
$indexMap = @{}
foreach ($line in $list2) {
    $parts = $line -split ","
    if ($parts.Count -ge 2) {
        $indexMap[$parts[1].Trim()] = [int]$parts[0].Trim()
    }
}

# ── Etapa 2: Iniciar, configurar e instalar Aptoide ───────────────────────────

Write-Host ""
Write-Host "=== ETAPA 2: Configurando cada instancia ===" -ForegroundColor Cyan
Write-Host ""

foreach ($inst in $instancias) {
    $idx = $indexMap[$inst.nome]
    Write-Host "[$($inst.nome)] (index $idx) Iniciando emulador..." -ForegroundColor Yellow
    & $ld launch --name $inst.nome | Out-Null

    Write-Host "[$($inst.nome)] Aguardando Android iniciar (60s)..." -ForegroundColor Gray
    Start-Sleep -Seconds 60

    Write-Host "[$($inst.nome)] Desabilitando dados moveis..." -ForegroundColor Yellow
    & $ld adb --index $idx --command "shell svc data disable"

    Write-Host "[$($inst.nome)] Desabilitando Bluetooth..." -ForegroundColor Yellow
    & $ld adb --index $idx --command "shell svc bluetooth disable"

    Write-Host "[$($inst.nome)] Desabilitando localizacao..." -ForegroundColor Yellow
    & $ld adb --index $idx --command "shell settings put secure location_mode 0"

    Write-Host "[$($inst.nome)] Instalando Aptoide..." -ForegroundColor Yellow
    & $ld installapp --name $inst.nome --filename $aptoide
    Start-Sleep -Seconds 20

    Write-Host "[$($inst.nome)] Fechando emulador..." -ForegroundColor Gray
    & $ld quit --name $inst.nome | Out-Null
    Start-Sleep -Seconds 8

    Write-Host "[$($inst.nome)] Concluido!" -ForegroundColor Green
    Write-Host ""
}

Write-Host "=== Tudo pronto! Instancias criadas ===" -ForegroundColor Cyan
Write-Host ""
& $ld list2
