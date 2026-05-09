@echo off
chcp 65001 >nul
title 📈 股票追踪助手
echo ================================================
echo          📈 股票追踪助手 - 启动脚本
echo ================================================
echo.
echo [1/2] 检查依赖...
cd /d "%~dp0"
call npm install --silent 2>nul
echo [2/2] 启动服务器...
echo.
echo ⚠ 重要提示：请保持此窗口打开，关闭即停止服务！
echo.
start "" http://localhost:3000
node server.js
pause
