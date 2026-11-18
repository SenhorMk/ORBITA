param(
    [Parameter(Mandatory)][string] $PgBin,
    [Parameter(Mandatory)][string] $DadosDescartaveis
)

$ErrorActionPreference = 'Stop'
$psql = Join-Path $PgBin 'psql.exe'
$repo = Resolve-Path (Join-Path $PSScriptRoot '../..')
# Use a fresh dedicated cluster, listening only on loopback. Refuse a
# pre-existing role/database and leave all other ports alone.
$base = @('-X','-h','127.0.0.1','-p','55482','-U','postgres','-v','ON_ERROR_STOP=1')
$actual = & $psql @base -d postgres -Atc 'show data_directory'
if ($LASTEXITCODE -ne 0 -or (Resolve-Path -LiteralPath $actual).Path -ne (Resolve-Path -LiteralPath $DadosDescartaveis).Path) {
    throw 'The server does not use the explicitly named disposable cluster.'
}
& $psql @base -d postgres -1 -c 'create role anon; create role authenticated; create role service_role bypassrls; create role supabase_admin;'
if ($LASTEXITCODE -ne 0) { throw 'Role provisioning failed. Use a fresh cluster.' }
& $psql @base -d postgres -c 'create database orbita_d082'
if ($LASTEXITCODE -ne 0) { throw 'Disposable database creation failed.' }
$lab = $base + @('-d','orbita_d082')
@'
create schema auth;
create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz,
    raw_app_meta_data jsonb default '{}', raw_user_meta_data jsonb default '{}', created_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
create function auth.role() returns text language sql stable as $$
    select nullif(current_setting('request.jwt.claim.role',true),'')
$$;
grant usage on schema auth to anon, authenticated, service_role;
create schema extensions;
'@ | & $psql @lab -1
if ($LASTEXITCODE -ne 0) { throw 'Native Postgres scaffolding failed.' }

$inPaths = $false
$supabase = Join-Path $repo 'supabase'
foreach ($line in Get-Content (Join-Path $supabase 'config.toml')) {
    if ($line -match '^schema_paths =') { $inPaths = $true; continue }
    if ($inPaths -and $line -match '^\]') { break }
    if ($inPaths -and $line -match '"([^"]+\.sql)"') {
        $file = (Resolve-Path (Join-Path $supabase $Matches[1])).Path
        & $psql @lab -1 -f $file
        if ($LASTEXITCODE -ne 0) { throw "SQL path failed: $file" }
    }
}
& $psql @lab -1 -f (Join-Path $PSScriptRoot '97_bootstrap_ai_first.sql')
if ($LASTEXITCODE -ne 0) { throw 'D08.2 candidate SQL failed.' }
