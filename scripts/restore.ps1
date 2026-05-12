$backupRoot = "C:\medusa\backups"
$backups    = Get-ChildItem $backupRoot -Directory -ErrorAction SilentlyContinue |
              Sort-Object LastWriteTime -Descending

if (!$backups -or $backups.Count -eq 0) {
    Write-Host "Nenhum backup encontrado em $backupRoot"
    exit 1
}

Write-Host ""
Write-Host "Backups disponiveis:"
for ($i = 0; $i -lt [Math]::Min($backups.Count, 10); $i++) {
    Write-Host "  [$i] $($backups[$i].Name)"
}

Write-Host ""
$choice   = Read-Host "Digite o numero do backup para restaurar"
$selected = $backups[[int]$choice]

Write-Host ""
Write-Host "Restaurando: $($selected.Name)..."
docker cp "$($selected.FullName)\instances\." medusa_evolution:/evolution/instances/

Write-Host "Reiniciando Evolution API..."
docker restart medusa_evolution

Write-Host ""
Write-Host "Restauracao concluida! Aguarde ~15s para o container subir."
