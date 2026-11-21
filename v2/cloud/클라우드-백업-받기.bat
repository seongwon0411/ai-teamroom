@echo off
rem AI Teamroom v2: download a backup of the room data from the cloud VM
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0cloud.ps1" -Mode backup %*
echo.
pause
