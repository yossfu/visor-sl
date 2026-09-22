@echo off
setlocal
cd /d "%~dp0"
title Visor SL - subir a GitHub

echo ================================================================
echo    Visor SL  -  subir el visor a GitHub  -  compilar el APK
echo ================================================================
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] No encuentro "git" en este ordenador.
  echo.
  echo Instala Git para Windows desde:  https://git-scm.com/download/win
  echo Acepta todas las opciones por defecto, cierra esta ventana y
  echo vuelve a ejecutar este archivo.
  echo.
  pause
  exit /b 1
)

if not exist "visor-sl-app.zip" (
  echo [ERROR] No veo el archivo "visor-sl-app.zip" en esta carpeta:
  echo    %~dp0
  echo.
  echo Descarga el zip desde el chat y dejalo aqui, junto a este archivo,
  echo con el nombre exacto:  visor-sl-app.zip
  echo.
  pause
  exit /b 1
)

echo [1/5] Descomprimiendo visor-sl-app.zip ...
if exist "visor-sl-app" rd /s /q "visor-sl-app"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Force -LiteralPath 'visor-sl-app.zip' -DestinationPath '.'"
if not exist "visor-sl-app\settings.gradle.kts" (
  echo [ERROR] El zip no se ha descomprimido bien. Vuelve a descargarlo.
  echo.
  pause
  exit /b 1
)

echo [2/5] Clonando o actualizando el repositorio yossfu/visor-sl ...
if exist "visor-sl\.git" (
  pushd "visor-sl"
  git pull --ff-only
  popd
) else (
  git clone https://github.com/yossfu/visor-sl.git visor-sl
  if errorlevel 1 (
    echo.
    echo [ERROR] No se pudo clonar el repositorio. Comprueba la conexion
    echo a internet y que el repositorio se llame yossfu/visor-sl
    echo.
    pause
    exit /b 1
  )
)

echo [3/5] Copiando los archivos del visor al repositorio ...
robocopy "visor-sl-app" "visor-sl" /MIR /XD .git /NFL /NDL /NJH /NJS /NP /NS /NC
if errorlevel 8 (
  echo.
  echo [ERROR] Fallo al copiar los archivos.
  echo.
  pause
  exit /b 1
)

echo [4/5] Preparando el commit ...
pushd "visor-sl"
git config user.email >nul 2>nul
if errorlevel 1 git config user.email "visor@localhost"
git config user.name >nul 2>nul
if errorlevel 1 git config user.name "Visor SL"
git add -A
git commit -m "visor: motor web + app android + workflow de APK"

echo [5/5] Subiendo a GitHub ...
git push
if errorlevel 1 (
  echo.
  echo [AVISO] El push ha fallado, casi siempre porque Git necesita que
  echo inicies sesion con tu cuenta de GitHub. Se suele abrir una ventana
  echo del navegador para autorizar - hazlo y vuelve a ejecutar este .bat.
  echo.
  echo Si aun asi falla: abre GitHub Desktop, elige el repositorio visor-sl
  echo y pulsa "Commit to main" y luego "Push origin". Los archivos ya estan
  echo copiados, asi que solo falta ese boton.
  echo.
  popd
  pause
  exit /b 1
)
popd

echo.
echo ================================================================
echo    LISTO. El codigo ya esta en GitHub.
echo.
echo    Ahora abre esta pagina y espera a que termine "Compilar APK":
echo    https://github.com/yossfu/visor-sl/actions
echo.
echo    Cuando acabe, entra en la ejecucion terminada y descarga
echo    "visor-sl-apk" al final de la pagina. Dentro hay UN solo APK
echo    con la version en el nombre (por ejemplo VisorSL-1.7.1-b9.apk).
echo.
echo    IMPORTANTE - solo la primera vez:
echo    los APK antiguos estaban firmados con otra clave, asi que
echo    Android NO deja actualizarlos por encima: si no se desinstala
echo    antes, el movil sigue abriendo el visor viejo y parece que el
echo    APK nuevo no ha cambiado nada.
echo      Ajustes - Aplicaciones - busca "Visor SL" - Desinstalar
echo      (si aparece mas de una vez, desinstalalas todas)
echo    Despues ya se puede instalar y actualizar normalmente.
echo.
echo    Al abrir la app, arriba tiene que poner "Visor SL 1.7.1" y el
echo    registro empieza por "Arranque: 1.7.1 (build 9)". Si no lo pone,
echo    el APK que se ha abierto no es el nuevo.
echo ================================================================
echo.
pause
