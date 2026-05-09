@echo off
chcp 65001 >nul
title 📈 股票追踪助手 - 安装启动

echo ╔═══════════════════════════════════════════════╗
echo ║      📈 股票追踪助手 v1.0 - 安装与启动        ║
echo ╠═══════════════════════════════════════════════╣
echo ║  本应用支持局域网分享                          ║
echo ║  同Wi-Fi下的其他设备可访问你的股票列表         ║
echo ╚═══════════════════════════════════════════════╝
echo.

cd /d "%~dp0"

REM Install dependencies if needed
if not exist "node_modules" (
    echo 📦 正在安装依赖...
    call npm install
    echo ✅ 依赖安装完成
    echo.
) else (
    echo ✅ 依赖已安装
    echo.
)

REM Check for existing data
if exist "data\stock-tracker.db" (
    echo 📊 发现已有数据文件（含之前添加的股票）
    echo.
)

echo 🚀 启动服务器...
echo.
echo ╔═══════════════════════════════════════════════╗
echo ║  请保持此窗口打开                             ║
echo ║  关闭此窗口 = 服务停止                        ║
echo ║                                               ║
echo ║  启动后将在浏览器自动打开                     ║
echo ╚═══════════════════════════════════════════════╝
echo.

timeout /t 2 /nobreak >nul

REM Start server - the server now binds to 0.0.0.0 and shows LAN IP
start "" http://localhost:3000
node server.js

pause
