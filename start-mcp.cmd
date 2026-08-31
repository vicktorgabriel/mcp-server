@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

echo ========================================================================
echo  MCP Local Full Control - launcher Windows
echo ========================================================================
echo  ngrok NO es obligatorio. Es util con CGNAT, Starlink, IP dinamica,
echo  puertos cerrados o cuando no tenes una URL HTTPS publica propia.
echo  Con IP publica/fija podes usar DNS + TLS + reverse proxy sin ngrok.
echo ========================================================================
echo.

REM 1. Verificar Node.js. Si falta, intentar instalarlo con winget.
where node >nul 2>nul
if errorlevel 1 (
    where winget >nul 2>nul
    if not errorlevel 1 (
        echo [INFO] Node.js no esta instalado. Intentando instalar Node.js LTS con winget...
        winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
        echo [INFO] Si Node acaba de instalarse y aun no aparece en PATH, cerra esta ventana y ejecuta start-mcp.cmd nuevamente.
    ) else (
        echo [ERROR] Node.js no esta instalado y winget no esta disponible.
        echo Instala Node.js LTS desde https://nodejs.org/ y vuelve a ejecutar este archivo.
    )
    where node >nul 2>nul
    if errorlevel 1 (
        pause
        exit /b 1
    )
)

REM 2. Verificar dependencias e instalarlas automaticamente si se requieren y faltan
node -e "const fs=require('fs'), path=require('path'); const pkgPath=path.join(process.cwd(),'package.json'); if(!fs.existsSync(pkgPath)) process.exit(0); const pkg=JSON.parse(fs.readFileSync(pkgPath,'utf8')); const deps=Object.keys(pkg.dependencies||{}); if(deps.length>0 && (!fs.existsSync(path.join(process.cwd(),'node_modules')) || !deps.every(d=>{try{require.resolve(d,{paths:[process.cwd()]}); return true;}catch(e){return false;}}))) process.exit(1);" >nul 2>nul
if errorlevel 1 (
    echo [INFO] Se requieren dependencias faltantes. Ejecutando npm install...
    where npm >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] npm no esta instalado o no se encuentra en el PATH.
        pause
        exit /b 1
    )
    call npm install
    if errorlevel 1 (
        echo [ERROR] Fallo al instalar las dependencias con npm install.
        pause
        exit /b 1
    )
)

REM 3. Leer configuracion desde .env o variables de entorno con valores por defecto
for /f "usebackq tokens=1,* delims==" %%A in (`node -e "const fs=require('fs'), path=require('path'); const defParent=path.resolve(__dirname,'..'); const env={}; if(fs.existsSync('.env')){for(const line of fs.readFileSync('.env','utf8').split(/\r?\n/)){const s=line.trim(); if(!s||s.startsWith('#')) continue; const i=s.indexOf('='); if(i<1) continue; env[s.slice(0,i).trim()]=s.slice(i+1).trim().replace(/^['\"]|['\"]$/g,'');}} const get=(k,def)=>process.env[k]!==undefined&&process.env[k]!==''?process.env[k]:(env[k]!==undefined&&env[k]!==''?env[k]:def); console.log('PORT=' + get('PORT','3000')); console.log('HOST=' + get('HOST','127.0.0.1')); console.log('ALLOWED_PATHS=' + get('ALLOWED_PATHS',defParent)); console.log('MCP_FULL_ACCESS=' + get('MCP_FULL_ACCESS','1')); console.log('MCP_AUTH_TOKEN=' + get('MCP_AUTH_TOKEN','')); console.log('ACTIVITY_LOG=' + get('ACTIVITY_LOG','activity.log')); console.log('MCP_FAST_MODE=' + get('MCP_FAST_MODE','1')); console.log('SEARCH_CACHE_TTL_MS=' + get('SEARCH_CACHE_TTL_MS','60000')); console.log('SEARCH_MAX_FILE_BYTES=' + get('SEARCH_MAX_FILE_BYTES','524288')); console.log('SEARCH_MAX_TOTAL_BYTES=' + get('SEARCH_MAX_TOTAL_BYTES','16777216')); console.log('SEARCH_SKIP_DIRS=' + get('SEARCH_SKIP_DIRS','node_modules,.git,dist,build,.next,.nuxt,.cache,coverage,.venv,venv,__pycache__,target,out')); console.log('READ_BATCH_LIMIT=' + get('READ_BATCH_LIMIT','25')); console.log('SSE_HEARTBEAT_MS=' + get('SSE_HEARTBEAT_MS','15000')); console.log('KEEP_ALIVE_TIMEOUT_MS=' + get('KEEP_ALIVE_TIMEOUT_MS','65000')); console.log('SERVER_LOG=' + get('SERVER_LOG','mcp-server.log')); console.log('NGROK_LOG=' + get('NGROK_LOG','ngrok.log'));"`) do (
    set "%%A=%%B"
)

REM 4. Iniciar servidor MCP en segundo plano
echo Starting MCP HTTP server...
type nul > "%SERVER_LOG%" 2>nul
start "MCP Server (Local)" /b node mcp-server.js --http > "%SERVER_LOG%" 2>&1

REM Breve espera para inicializacion
ping -n 2 127.0.0.1 >nul

REM 5. Iniciar tunel ngrok si esta disponible
where ngrok >nul 2>nul
if errorlevel 1 (
    echo ngrok is not installed or is not in PATH.
    echo Local MCP URL: http://%HOST%:%PORT%/mcp
    echo Install/configure ngrok, then rerun this script for ChatGPT Web and Claude Web.
    set "PUBLIC_URL="
) else (
    echo Starting ngrok tunnel...
    type nul > "%NGROK_LOG%" 2>nul
    start "ngrok Tunnel" /b ngrok http "http://%HOST%:%PORT%" --log=stdout > "%NGROK_LOG%" 2>&1
    
    set "PUBLIC_URL="
    for /l %%I in (1,1,30) do (
        if not defined PUBLIC_URL (
            for /f "usebackq delims=" %%U in (`node -e "fetch('http://127.0.0.1:4040/api/tunnels').then(r=>r.json()).then(j=>{const t=(j.tunnels||[]).find(x=>x.public_url&&x.public_url.startsWith('https://')); if(t) console.log(t.public_url)}).catch(()=>{})" 2^>nul`) do (
                set "PUBLIC_URL=%%U"
            )
            if not defined PUBLIC_URL (
                ping -n 2 127.0.0.1 >nul
            )
        )
    )
)

if defined PUBLIC_URL (
    set "BASE_URL=%PUBLIC_URL%"
) else (
    set "BASE_URL=http://%HOST%:%PORT%"
)

for /f "usebackq delims=" %%P in (`node -e "console.log(process.cwd())"`) do set "CURRENT_DIR=%%P"

echo.
echo === MCP READY ===
echo Local health:  http://%HOST%:%PORT%/health
echo Local config:  http://%HOST%:%PORT%/config
echo ChatGPT Web:   %BASE_URL%/mcp
echo Claude Web:    %BASE_URL%/sse
echo Local stdio:   node %CURRENT_DIR%\mcp-server.js --stdio
echo Allowed paths: %ALLOWED_PATHS%
echo Full access:   %MCP_FULL_ACCESS%
echo Fast mode:     %MCP_FAST_MODE%
echo Activity log:  %ACTIVITY_LOG%
if defined MCP_AUTH_TOKEN if not "%MCP_AUTH_TOKEN%"=="" (
    echo Auth:          Bearer configured ^(value hidden^)
) else (
    echo Auth:          none
)
echo Logs:          %SERVER_LOG%, %NGROK_LOG%
if not defined PUBLIC_URL (
    where ngrok >nul 2>nul
    if not errorlevel 1 (
        echo Warning:       ngrok public URL was not detected. Check %NGROK_LOG%.
    )
)
echo =================
echo.
echo Leave this terminal open. Press Ctrl+C to stop MCP.
echo For local clients, prefer stdio so MCP starts only when the client needs it.
echo.

REM Mantener terminal abierta hasta interrupcion del usuario
node -e "process.stdin.resume();"
