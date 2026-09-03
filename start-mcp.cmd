@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ================================================================
echo  MCP Local Full Control - inicio seguro para Windows
echo ================================================================
echo.

where wsl.exe >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  for /f "usebackq delims=" %%P in (`wsl.exe wslpath -a "%CD%"`) do set "MCP_WSL_PATH=%%P"
  if defined MCP_WSL_PATH (
    echo [INFO] Abriendo el asistente completo mediante WSL...
    wsl.exe bash -lc "cd '%MCP_WSL_PATH%' && ./start-mcp.sh"
    exit /b %ERRORLEVEL%
  )
)

echo [ERROR] El instalador seguro completo requiere WSL o una terminal Bash.
echo.
echo Opcion recomendada:
echo   1. Instala WSL desde una terminal de administrador: wsl --install
ECHO   2. Abre Ubuntu/WSL.
echo   3. Entra a esta carpeta y ejecuta: bash start-mcp.sh
echo.
echo Tambien puede usarse Git Bash abriendo esta carpeta y ejecutando:
echo   bash start-mcp.sh
echo.
echo El launcher antiguo sin asistente ni OAuth fue retirado por seguridad.
pause
exit /b 1
