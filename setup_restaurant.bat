@echo off
setlocal EnableDelayedExpansion
title RestaurantOS - Automated Setup

:: -----------------------------------------------------
:: 0. ELEVATE TO ADMINISTRATOR PRIVILEGES
:: -----------------------------------------------------
net session >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo Requesting Administrator permissions...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo ===================================================
echo       RESTAURANT OS - 24/7 SETUP WIZARD
echo ===================================================

:: -----------------------------------------------------
:: CONFIGURATION
:: -----------------------------------------------------
set "REPO_URL=https://github.com/Aryan18-dotcom/RestaurantOS.git"
set "APP_DIR=%USERPROFILE%\RestaurantOS"
set "TUNNEL_LOG=%USERPROFILE%\cloudflared.log"
set "URL_FILE=%USERPROFILE%\restaurant_url.txt"
set "DESKTOP_OPEN_BAT=%USERPROFILE%\Desktop\Open-RestaurantOS.bat"
set "DESKTOP_RESET_BAT=%USERPROFILE%\Desktop\Reset-RestaurantOS.bat"

:: -----------------------------------------------------
:: 1. CONFIGURE 24/7 POWER SETTINGS (NO SLEEP)
:: -----------------------------------------------------
echo [1/8] Setting Windows power scheme to 24/7 Always-On...

:: Disable Sleep & Hibernate
powercfg -change -standby-timeout-ac 0
powercfg -change -standby-timeout-dc 0
powercfg -change -hibernate-timeout-ac 0
powercfg -change -hibernate-timeout-dc 0

:: Disable Disk Spin-Down & Keep Monitor On
powercfg -change -disk-timeout-ac 0
powercfg -change -disk-timeout-dc 0
powercfg -change -monitor-timeout-ac 0

:: Set Wi-Fi Adapter to Maximum Performance
powercfg -setacvalueindex SCHEME_CURRENT 19cbb8fa-5279-450e-9f18-984bb200871b 12bbebe6-58d6-4636-95bb-3217ef867c1a 0
powercfg -setdcvalueindex SCHEME_CURRENT 19cbb8fa-5279-450e-9f18-984bb200871b 12bbebe6-58d6-4636-95bb-3217ef867c1a 0

:: Lid Close Action: 0 = Do Nothing
powercfg -setacvalueindex SCHEME_CURRENT 4f971e89-eebd-4455-a8de-9e59040e7347 5ca83367-6e45-459f-a27b-476b1d01c936 0
powercfg -setdcvalueindex SCHEME_CURRENT 4f971e89-eebd-4455-a8de-9e59040e7347 5ca83367-6e45-459f-a27b-476b1d01c936 0

powercfg -setactive SCHEME_CURRENT
echo Power configuration applied.

:: -----------------------------------------------------
:: 2. CHECK & INSTALL NODE.JS
:: -----------------------------------------------------
echo [2/8] Checking Node.js...
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo Node.js not detected. Installing LTS...
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements --silent
) else (
    echo Node.js is already installed.
)

:: -----------------------------------------------------
:: 3. CHECK & INSTALL GIT
:: -----------------------------------------------------
echo [3/8] Checking Git...
where git >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo Git not detected. Installing Git...
    winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements --silent
) else (
    echo Git is already installed.
)

:: -----------------------------------------------------
:: 4. CHECK & INSTALL CLOUDFLARED
:: -----------------------------------------------------
echo [4/8] Checking Cloudflared...
where cloudflared >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo Cloudflared not detected. Installing...
    winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements --silent
) else (
    echo Cloudflared is already installed.
)

:: Refresh PATH
set "PATH=%SystemRoot%\system32;%SystemRoot%;C:\Program Files\nodejs\;C:\Program Files\Git\cmd\;%ProgramFiles(x86)%\cloudflared\;%ProgramFiles%\cloudflared\;%LOCALAPPDATA%\Microsoft\WinGet\Packages"

:: -----------------------------------------------------
:: 5. CLONE OR UPDATE REPOSITORY & INSTALL DEPENDENCIES
:: -----------------------------------------------------
echo [5/8] Setting up repository...
if exist "%APP_DIR%" (
    echo Updating code in %APP_DIR%...
    cd /d "%APP_DIR%"
    git pull
) else (
    echo Cloning repository...
    git clone %REPO_URL% "%APP_DIR%"
    cd /d "%APP_DIR%"
)

echo Installing dependencies (npm install)...
call npm install

:: -----------------------------------------------------
:: 6. START SERVER & CLOUDFLARE TUNNEL (BACKGROUND)
:: -----------------------------------------------------
echo [6/8] Starting backend server and tunnel...

if exist "%TUNNEL_LOG%" del /f /q "%TUNNEL_LOG%"
if exist "%URL_FILE%" del /f /q "%URL_FILE%"

cd /d "%APP_DIR%"
start "RestaurantOS-Backend" /min cmd /c "npm start"
start "RestaurantOS-Cloudflare" /min cmd /c "cloudflared tunnel --url http://127.0.0.1:3000 --logfile \"%TUNNEL_LOG%\""

echo Waiting for Cloudflare to assign public URL...
set "ASSIGNED_URL="
set "ATTEMPTS=0"

:CHECK_URL
timeout /t 2 /nobreak >nul
set /a ATTEMPTS+=1

for /f "tokens=*" %%a in ('powershell -Command "Select-String -Path '%TUNNEL_LOG%' -Pattern 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' | ForEach-Object { $_.Matches.Value } | Select-Object -Last 1"') do (
    set "ASSIGNED_URL=%%a"
)

if not "%ASSIGNED_URL%"=="" goto URL_FOUND

if %ATTEMPTS% GEQ 15 (
    echo Warning: Tunnel connection taking longer than expected. Check %TUNNEL_LOG% manually.
    goto GENERATE_SHORTCUTS
)
goto CHECK_URL

:URL_FOUND
echo ===================================================
echo SUCCESS! Assigned Public Tunnel:
echo %ASSIGNED_URL%
echo ===================================================
echo %ASSIGNED_URL%> "%URL_FILE%"

:GENERATE_SHORTCUTS
:: -----------------------------------------------------
:: 7. CREATE DESKTOP LAUNCHER BAT FILE
:: -----------------------------------------------------
echo [7/8] Generating Desktop shortcut bat file...

(
    echo @echo off
    echo title Open RestaurantOS
    echo set "URL_FILE=%%USERPROFILE%%\restaurant_url.txt"
    echo if not exist "%%URL_FILE%%" ^(
    echo     echo Tunnel address file not found. Make sure setup script was run.
    echo     pause
    echo     exit /b
    echo ^)
    echo set /p TARGET_URL=^<"%%URL_FILE%%"
    echo echo Opening RestaurantOS at %%TARGET_URL%%...
    echo start "" "%%TARGET_URL%%"
    echo exit
) > "%DESKTOP_OPEN_BAT%"

:: -----------------------------------------------------
:: 8. CREATE DESKTOP RESET BAT FILE
:: -----------------------------------------------------
echo [8/8] Generating Desktop reset bat file...

(
    echo @echo off
    echo title Reset RestaurantOS
    echo :: Elevate to Administrator for power settings
    echo net session ^>nul 2^>^&1
    echo if %%ERRORLEVEL%% NEQ 0 ^(
    echo     powershell -Command "Start-Process '%%~f0' -Verb RunAs"
    echo     exit /b
    echo ^)
    echo ===================================================
    echo       STOPPING RESTAURANT OS ^& RESETTING POWER
    echo ===================================================
    echo.
    echo 1. Terminating background services...
    echo Stopping Cloudflare Tunnel...
    echo taskkill /f /im cloudflared.exe ^>nul 2^>^&1
    echo Stopping Node.js server...
    echo taskkill /f /im node.exe ^>nul 2^>^&1
    echo.
    echo 2. Restoring Windows standard power scheme...
    echo powercfg -restoredefaultschemes
    echo powercfg -setactive SCHEME_BALANCED
    echo.
    echo 3. Cleaning session logs...
    echo del /f /q "%%USERPROFILE%%\cloudflared.log" ^>nul 2^>^&1
    echo del /f /q "%%USERPROFILE%%\restaurant_url.txt" ^>nul 2^>^&1
    echo.
    echo ===================================================
    echo All services stopped. Laptop power settings restored to defaults.
    echo ===================================================
    echo pause
) > "%DESKTOP_RESET_BAT%"

if not "%ASSIGNED_URL%"=="" (
    start "" "%ASSIGNED_URL%"
)

echo ===================================================
echo Setup complete.
echo Shortcuts created on Desktop:
echo   - Open-RestaurantOS.bat  (Opens active POS link)
echo   - Reset-RestaurantOS.bat (Kills processes and restores laptop sleep)
echo ===================================================
pause