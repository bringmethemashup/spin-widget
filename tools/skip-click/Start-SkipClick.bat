@echo off
title Spin Widget - Skip Click
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0SkipClick.ps1" %*
echo.
pause
