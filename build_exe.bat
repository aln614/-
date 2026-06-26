@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
if /I "%~1"=="--inner" set LAIG_INNER_BUILD=1
set BUILD_EXIT_CODE=0
if not defined LAIG_INNER_BUILD (
  for /f "tokens=*" %%L in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Location).Path.Length" 2^>nul') do set LAIG_PATH_LEN=%%L
  if not defined LAIG_PATH_LEN set LAIG_PATH_LEN=0
  if !LAIG_PATH_LEN! GEQ 180 (
    set "LAIG_ORIGINAL_DIR=%cd%"
    set "LAIG_SHORT_BUILD_DIR=%TEMP%\AIG_Build_%RANDOM%%RANDOM%"
    echo =====================================================
    echo  Current path is too long for electron-builder.
    echo  Using short temp build folder:
    echo  !LAIG_SHORT_BUILD_DIR!
    echo =====================================================
    echo.
    if exist "!LAIG_SHORT_BUILD_DIR!" rmdir /s /q "!LAIG_SHORT_BUILD_DIR!" >nul 2>nul
    mkdir "!LAIG_SHORT_BUILD_DIR!" >nul 2>nul
    robocopy "%cd%" "!LAIG_SHORT_BUILD_DIR!" /E /XD node_modules dist .electron_builder_cache /XF build_log.txt last_error.txt >nul
    pushd "!LAIG_SHORT_BUILD_DIR!"
    call build_exe.bat --inner
    set "LAIG_BUILD_RC=!ERRORLEVEL!"
    popd
    if exist "!LAIG_SHORT_BUILD_DIR!\dist" (
      if exist "%cd%\dist" rmdir /s /q "%cd%\dist" >nul 2>nul
      robocopy "!LAIG_SHORT_BUILD_DIR!\dist" "%cd%\dist" /E >nul
    )
    if exist "!LAIG_SHORT_BUILD_DIR!\build_log.txt" copy /Y "!LAIG_SHORT_BUILD_DIR!\build_log.txt" "%cd%\build_log.txt" >nul
    if exist "!LAIG_SHORT_BUILD_DIR!\last_error.txt" copy /Y "!LAIG_SHORT_BUILD_DIR!\last_error.txt" "%cd%\last_error.txt" >nul
    if !LAIG_BUILD_RC! EQU 0 (
      echo.
      echo BUILD SUCCESS. dist folder has been copied back.
      if exist "%cd%\dist" start "" "%cd%\dist"
    ) else (
      echo.
      echo [ERROR] Build failed in short temp folder. Check build_log.txt and last_error.txt.
    )
    rmdir /s /q "!LAIG_SHORT_BUILD_DIR!" >nul 2>nul
    echo.
    echo Press any key to close this window.
    pause >nul
    exit /b !LAIG_BUILD_RC!
  )
)
title LocalApiImageGenerator Builder V14.5.4
cls
echo =====================================================
echo  LocalApiImageGenerator Builder V14.5.4
echo  electron-builder symlink privilege fix
echo  This window will NOT close automatically.
echo =====================================================
echo.
if exist build_log.txt del /f /q build_log.txt >nul 2>nul
if exist last_error.txt del /f /q last_error.txt >nul 2>nul
echo Current folder: %cd%
echo Current folder: %cd%> build_log.txt
echo.
echo Checking Node.js...
where node >nul 2>nul
if errorlevel 1 (
  set BUILD_EXIT_CODE=1
  echo [ERROR] Node.js LTS is not installed or node.exe is not in PATH.>last_error.txt
  echo [ERROR] Node.js LTS is not installed or node.exe is not in PATH.
  echo Install Node.js LTS from https://nodejs.org/ then run this script again.
  goto END
)
for /f "tokens=*" %%i in ('node -v') do set NODE_VERSION=%%i
echo Node.js: !NODE_VERSION!
echo Node.js: !NODE_VERSION!>> build_log.txt

echo.
echo Checking npm...
where npm >nul 2>nul
if errorlevel 1 (
  set BUILD_EXIT_CODE=1
  echo [ERROR] npm is not available. Reinstall Node.js LTS and enable PATH.>last_error.txt
  echo [ERROR] npm is not available. Reinstall Node.js LTS and enable PATH.
  goto END
)
call npm -v >> build_log.txt 2>&1
for /f "tokens=*" %%i in ('call npm -v') do set NPM_VERSION=%%i
echo npm: !NPM_VERSION!

echo.
echo Cleaning old build files...
if exist dist rmdir /s /q dist >> build_log.txt 2>&1

echo.
echo Setting npm mirrors and builder variables...
call npm config set registry https://registry.npmmirror.com/ >> build_log.txt 2>&1
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
set CSC_IDENTITY_AUTO_DISCOVERY=false
set npm_config_build_from_source=false
set ELECTRON_BUILDER_CACHE=%~dp0.electron_builder_cache

echo.
echo Cleaning winCodeSign cache that causes symlink errors...
echo Cleaning winCodeSign cache...>> build_log.txt
if exist "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign" rmdir /s /q "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign" >> build_log.txt 2>&1
if exist "%ELECTRON_BUILDER_CACHE%\winCodeSign" rmdir /s /q "%ELECTRON_BUILDER_CACHE%\winCodeSign" >> build_log.txt 2>&1

echo.
echo Installing dependencies. Please wait...
echo Installing dependencies...>> build_log.txt
call npm install >> build_log.txt 2>&1
if errorlevel 1 (
  set BUILD_EXIT_CODE=1
  echo [ERROR] npm install failed. Check build_log.txt>last_error.txt
  echo [ERROR] npm install failed. Check build_log.txt
  goto END
)

echo.
echo Building portable EXE. Please wait...
echo Building portable EXE...>> build_log.txt
call npm run dist >> build_log.txt 2>&1
if errorlevel 1 (
  echo Portable EXE build failed. Trying win-unpacked fallback...>> build_log.txt
  echo Portable EXE build failed. Trying win-unpacked fallback...
  call npm run dist:dir >> build_log.txt 2>&1
  if errorlevel 1 (
    set BUILD_EXIT_CODE=1
    echo [ERROR] electron-builder failed. Check build_log.txt>last_error.txt
    echo [ERROR] electron-builder failed. Check build_log.txt
    goto END
  )
)

echo.
echo =====================================================
echo  BUILD SUCCESS
echo  Check dist folder.
echo  If portable exe is not created, run:
echo  dist\win-unpacked\LocalApiImageGenerator.exe
echo =====================================================
echo BUILD SUCCESS>> build_log.txt
if not defined LAIG_INNER_BUILD start "" "%~dp0dist"
goto END

:END
if defined LAIG_INNER_BUILD exit /b !BUILD_EXIT_CODE!
echo.
echo If build failed, send build_log.txt and last_error.txt.
echo Press any key to close this window.
pause >nul
