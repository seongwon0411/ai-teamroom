@echo off
rem AI Teamroom v2: upload the server to the cloud VM (first install and updates)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0cloud.ps1" -Mode upload %*
echo.
pause
