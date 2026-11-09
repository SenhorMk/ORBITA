<#
.SYNOPSIS
  Opera o laboratório ORBITA deste notebook (MSG-020C).
.DESCRIPTION
  Repassa o comando para scripts/infra-local.mjs, a partir da raiz do repositório
  descoberta por $PSScriptRoot: funciona de qualquer pasta e em qualquer checkout.
  Nunca liga worker: os kill switches vêm de %USERPROFILE%\orbita-infra\workers.env
  e ficam em false. Não altera a política de execução do PowerShell.
.EXAMPLE
  .\infra\local\orbita-local.ps1 verificar
.EXAMPLE
  .\infra\local\orbita-local.ps1 restore C:\caminho\chatwoot-20261108T130538Z.dump
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('preparar', 'iniciar', 'verificar', 'parar', 'atualizar', 'backup', 'restore')]
  [string]$Comando,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Resto = @()
)

$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) {
  [Console]::Error.WriteLine('orbita-local: Node.js não encontrado no PATH. Instale o Node 24 e abra um novo terminal.')
  exit 1
}

$raiz = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script = Join-Path $raiz 'scripts\infra-local.mjs'
if (-not (Test-Path $script)) {
  [Console]::Error.WriteLine("orbita-local: $script não existe; o atalho precisa estar em infra\local de um checkout do ORBITA.")
  exit 1
}

Push-Location $raiz
try {
  & $node.Source $script $Comando @Resto
  $codigo = $LASTEXITCODE
} finally {
  Pop-Location
}
exit $codigo
