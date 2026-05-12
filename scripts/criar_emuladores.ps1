$ld = "C:\LDPlayer\LDPlayer9\ldconsole.exe"

$instancias = @(
    @{ nome = "ZTE1-A"; modelo = "SM-G991B"  },
    @{ nome = "ZTE1-B"; modelo = "SM-A515F"  },
    @{ nome = "ZTE1-C"; modelo = "SM-A325F"  },
    @{ nome = "ZTE2-A"; modelo = "SM-G990B"  },
    @{ nome = "ZTE2-B"; modelo = "SM-A135F"  },
    @{ nome = "ZTE2-C"; modelo = "SM-A526B"  },
    @{ nome = "ZTE3-A"; modelo = "SM-A725F"  },
    @{ nome = "ZTE3-B"; modelo = "SM-A346B"  },
    @{ nome = "ZTE3-C"; modelo = "SM-A236B"  },
    @{ nome = "ZTE4-A"; modelo = "SM-G780G"  },
    @{ nome = "ZTE4-B"; modelo = "SM-A546B"  },
    @{ nome = "ZTE4-C"; modelo = "SM-M336BU" }
)

Write-Host "=== Criando 12 instancias LDPlayer ===" -ForegroundColor Cyan

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

Write-Host ""
Write-Host "=== Concluido! ===" -ForegroundColor Cyan
& $ld list2
