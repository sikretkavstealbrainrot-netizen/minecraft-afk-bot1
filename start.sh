#!/bin/bash

# Minecraft AFK Bot - Автозапуск
# Установка: chmod +x start.sh

echo "🚀 Запуск Minecraft AFK Бота..."

# Проверка Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js не установлен!"
    echo "Установите: curl -fsSL https://deb.nodesource.com/setup_18.x | sudo bash - && sudo apt install -y nodejs"
    exit 1
fi

# Проверка зависимостей
echo "📦 Проверка зависимостей..."
sudo apt update
sudo apt install -y scrot ffmpeg imagemagick

# Установка npm пакетов
if [ ! -d "node_modules" ]; then
    echo "📦 Установка npm пакетов..."
    npm install
fi

# Запуск через PM2 (для постоянной работы)
if command -v pm2 &> /dev/null; then
    echo "🔄 Запуск через PM2..."
    pm2 start bot.js --name mc-afk-bot
    pm2 save
    pm2 logs mc-afk-bot
else
    echo "🔄 Установка PM2..."
    npm install -g pm2
    pm2 start bot.js --name mc-afk-bot
    pm2 save
    pm2 logs mc-afk-bot
fi
