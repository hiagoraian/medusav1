$ErrorActionPreference = "Stop"

$backupRoot = "C:\medusa\backups"
$timestamp  = Get-Date -Format "yyyy-MM-dd_HH-mm"
$dest       = Join-Path $backupRoot "sessions_$timestamp"

New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null

Write-Host "[BACKUP] Copiando sessoes do container..."
docker cp medusa_evolution:/evolution/instances $dest

Write-Host "[BACKUP] Salvo em: $dest"

# Manter apenas os ultimos 10 backups
$all = Get-ChildItem $backupRoot -Directory | Sort-Object LastWriteTime -Descending
if ($all.Count -gt 10) {
    $all | Select-Object -Skip 10 | ForEach-Object {
        Remove-Item $_.FullName -Recurse -Force
        Write-Host "[BACKUP] Removido backup antigo: $($_.Name)"
    }
}

Write-Host "[BACKUP] Concluido."
