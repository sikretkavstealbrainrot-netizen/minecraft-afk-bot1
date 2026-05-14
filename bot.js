#!/usr/bin/env node

const mineflayer = require('mineflayer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { spawn } = require('child_process');
const FormData = require('form-data');

// ========== ЗАГРУЗКА НАСТРОЕК ==========
let config;
try {
    config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    console.log('✅ Настройки загружены');
} catch (error) {
    console.error('❌ Ошибка загрузки config.json:', error.message);
    process.exit(1);
}

// ========== ПЕРЕМЕННЫЕ ==========
let bot = null;
let screenshotCounter = 0;
let screenshotQueue = [];
let isRecording = true;
let playerDetected = false;
let lastNotificationTime = 0;
const MIN_NOTIFICATION_INTERVAL = 60000; // 1 минута между уведомлениями

// ========== СОЗДАНИЕ ПАПОК ==========
const dirs = ['screenshots', 'videos', 'logs'];
dirs.forEach(dir => {
    const dirPath = path.join(__dirname, dir);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath);
        console.log(`📁 Создана папка: ${dir}`);
    }
});

// ========== ЛОГГИРОВАНИЕ ==========
function logToFile(message, type = 'INFO') {
    if (!config.logging.enabled) return;
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${type}] ${message}\n`;
    const logFile = path.join(__dirname, 'logs', `bot_${new Date().toISOString().split('T')[0]}.log`);
    fs.appendFileSync(logFile, logMessage);
    console.log(message);
}

// ========== TELEGRAM ФУНКЦИИ ==========
async function sendTelegramMessage(text, parseMode = 'HTML', replyMarkup = null) {
    try {
        const url = `https://api.telegram.org/bot${config.telegram.token}/sendMessage`;
        const payload = {
            chat_id: config.telegram.chatId,
            text: text,
            parse_mode: parseMode,
            disable_web_page_preview: false
        };
        if (replyMarkup) payload.reply_markup = replyMarkup;
        
        const response = await axios.post(url, payload);
        logToFile(`📨 Сообщение отправлено: ${text.substring(0, 50)}...`, 'TELEGRAM');
        return response.data;
    } catch (error) {
        logToFile(`❌ Ошибка отправки сообщения: ${error.message}`, 'ERROR');
        return null;
    }
}

async function sendTelegramPhoto(photoPath, caption = '') {
    try {
        const url = `https://api.telegram.org/bot${config.telegram.token}/sendPhoto`;
        const form = new FormData();
        form.append('chat_id', config.telegram.chatId);
        form.append('photo', fs.createReadStream(photoPath));
        if (caption) form.append('caption', caption);
        
        const response = await axios.post(url, form, {
            headers: { ...form.getHeaders() }
        });
        logToFile(`📸 Скриншот отправлен: ${path.basename(photoPath)}`, 'TELEGRAM');
        return response.data;
    } catch (error) {
        logToFile(`❌ Ошибка отправки фото: ${error.message}`, 'ERROR');
        return null;
    }
}

async function sendTelegramVideo(videoPath, caption = '') {
    try {
        const url = `https://api.telegram.org/bot${config.telegram.token}/sendVideo`;
        const form = new FormData();
        form.append('chat_id', config.telegram.chatId);
        form.append('video', fs.createReadStream(videoPath));
        if (caption) form.append('caption', caption);
        
        const response = await axios.post(url, form, {
            headers: { ...form.getHeaders() },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        logToFile(`🎬 Видео отправлено: ${path.basename(videoPath)}`, 'TELEGRAM');
        return response.data;
    } catch (error) {
        logToFile(`❌ Ошибка отправки видео: ${error.message}`, 'ERROR');
        return null;
    }
}

// ========== ФУНКЦИЯ СКРИНШОТА ==========
function takeScreenshot(reason = 'regular', immediate = false) {
    if (!config.screenshot.enabled) return;
    if (!isRecording && reason === 'regular') return;
    
    const timestamp = Date.now();
    const date = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const filename = `scr_${date}_${screenshotCounter++}.png`;
    const filepath = path.join(__dirname, 'screenshots', filename);
    
    // Пробуем разные команды для Linux
    const commands = [
        `import -window root ${filepath} 2>/dev/null`,
        `gnome-screenshot -f ${filepath} 2>/dev/null`,
        `scrot ${filepath} 2>/dev/null`,
        `spectacle -b -o ${filepath} 2>/dev/null`
    ];
    
    let cmdIndex = 0;
    
    function tryNextCommand() {
        if (cmdIndex >= commands.length) {
            logToFile(`❌ Не удалось сделать скриншот: нет доступных утилит`, 'ERROR');
            return;
        }
        
        const cmd = commands[cmdIndex];
        const process = spawn('sh', ['-c', cmd]);
        
        process.on('close', (code) => {
            if (code === 0 && fs.existsSync(filepath)) {
                logToFile(`📸 Скриншот: ${filename} (${reason})`, 'SCREENSHOT');
                screenshotQueue.push({
                    path: filepath,
                    time: Date.now(),
                    reason: reason,
                    filename: filename
                });
                
                // Если скриншот по входу игрока - отправляем сразу
                if (reason === 'player_join' && immediate) {
                    sendTelegramPhoto(filepath, `🎮 Игрок зашёл в ${new Date().toLocaleString('ru-RU')}`);
                }
                
                // Очистка старых скриншотов (старше 24 часов)
                cleanupOldScreenshots();
            } else {
                cmdIndex++;
                tryNextCommand();
            }
        });
    }
    
    tryNextCommand();
}

// ========== ОЧИСТКА СТАРЫХ СКРИНШОТОВ ==========
function cleanupOldScreenshots() {
    const screenshotsDir = path.join(__dirname, 'screenshots');
    const files = fs.readdirSync(screenshotsDir);
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 часа
    
    files.forEach(file => {
        const filePath = path.join(screenshotsDir, file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > maxAge) {
            fs.unlinkSync(filePath);
            logToFile(`🗑️ Удалён старый скриншот: ${file}`, 'CLEANUP');
        }
    });
}

// ========== СОЗДАНИЕ ВИДЕО ==========
async function createAndSendVideo() {
    if (screenshotQueue.length === 0) {
        await sendTelegramMessage('❌ Нет скриншотов для создания видео\n\nВключи режим записи и подожди немного.');
        return false;
    }
    
    await sendTelegramMessage('🎬 Начинаю создание видео из ' + screenshotQueue.length + ' скриншотов...\nЭто может занять минуту.');
    
    const timestamp = Date.now();
    const videoFilename = `video_${timestamp}.mp4`;
    const videoPath = path.join(__dirname, 'videos', videoFilename);
    const listFile = path.join(__dirname, 'videos', 'filelist.txt');
    
    // Создаём список файлов для ffmpeg
    const fileList = screenshotQueue.map(s => `file '${s.path}'`).join('\n');
    fs.writeFileSync(listFile, fileList);
    
    // Пробуем ffmpeg
    const ffmpeg = spawn('ffmpeg', [
        '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
        '-r', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-preset', 'fast', '-crf', '23', videoPath
    ]);
    
    return new Promise((resolve) => {
        ffmpeg.on('close', async (code) => {
            fs.unlinkSync(listFile);
            
            if (code === 0 && fs.existsSync(videoPath)) {
                const stats = fs.statSync(videoPath);
                const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
                
                const caption = `🎥 ВИДЕО ОТ ГЛАЗ БОТА\n\n📅 ${screenshotQueue.length} скриншотов\n💾 Размер: ${sizeMB} MB\n👤 Цель: ${config.targetNick}\n🎮 Сервер: ${config.server.name}\n\n⏰ Временной промежуток:\n${new Date(screenshotQueue[0].time).toLocaleString('ru-RU')} — ${new Date().toLocaleString('ru-RU')}`;
                
                await sendTelegramVideo(videoPath, caption);
                logToFile(`🎬 Видео создано и отправлено: ${videoFilename} (${sizeMB} MB)`, 'VIDEO');
                
                // Не очищаем очередь, чтобы можно было сделать ещё одно видео
                resolve(true);
            } else {
                await sendTelegramMessage('❌ Ошибка создания видео. Убедитесь, что установлен ffmpeg:\n`sudo apt install ffmpeg`');
                logToFile(`❌ Ошибка ffmpeg, код: ${code}`, 'ERROR');
                resolve(false);
            }
        });
    });
}

// ========== СОЗДАНИЕ БОТА ==========
function createBot() {
    if (bot) {
        try { bot.end(); } catch(e) {}
    }
    
    logToFile(`🤖 Подключение к ${config.server.host}:${config.server.port}...`, 'BOT');
    
    bot = mineflayer.createBot({
        host: config.server.host,
        port: config.server.port,
        username: config.bot.username + Math.floor(Math.random() * 1000),
        version: config.server.version,
        viewDistance: config.bot.viewDistance,
        auth: 'offline'
    });
    
    bot.on('login', () => {
        logToFile(`✅ Бот зашёл на сервер ${config.server.host}`, 'BOT');
        sendTelegramMessage(
            `🤖 <b>AFK МОНИТОР ЗАПУЩЕН</b>\n\n` +
            `🎮 Сервер: <code>${config.server.name}</code>\n` +
            `📍 Хост: <code>${config.server.host}</code>\n` +
            `👀 Слежу за: <code>${config.targetNick}</code>\n` +
            `📸 Скриншоты: каждые ${config.screenshot.intervalSeconds} сек\n` +
            `⏰ Время: ${new Date().toLocaleString('ru-RU')}\n\n` +
            `⚡ <i>Бот активен и ждёт цель...</i>`
        );
        
        // Запускаем периодические скриншоты
        if (config.screenshot.enabled) {
            setInterval(() => takeScreenshot('regular', false), config.screenshot.intervalSeconds * 1000);
        }
    });
    
    // МОНИТОРИМ ВХОД ИГРОКОВ
    bot.on('playerJoined', (player) => {
        const playerName = player.username;
        logToFile(`🔔 Игрок зашёл: ${playerName}`, 'PLAYER');
        
        if (playerName === config.targetNick && !playerDetected) {
            const now = Date.now();
            if (now - lastNotificationTime < MIN_NOTIFICATION_INTERVAL) {
                logToFile(`⏳ Пропуск уведомления (интервал)`, 'WARN');
                return;
            }
            
            playerDetected = true;
            lastNotificationTime = now;
            
            const joinTime = new Date();
            const formattedTime = joinTime.toLocaleString('ru-RU', {
                day: '2-digit', month: '2-digit', year: 'numeric',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
                timeZoneName: 'short'
            });
            
            // Мгновенный скриншот
            takeScreenshot('player_join', true);
            
            // Формируем сообщение
            const message = `🎯 <b>ЦЕЛЬ ОБНАРУЖЕНА!</b> 🎯\n\n` +
                `👤 <b>Игрок:</b> <code>${playerName}</code>\n` +
                `⏰ <b>Время захода:</b> <code>${formattedTime}</code>\n` +
                `🎮 <b>Сервер:</b> <code>${config.server.name}</code>\n` +
                `📍 <b>Хост:</b> <code>${config.server.host}</code>\n\n` +
                `📸 <b>Скриншот сделан и отправлен выше</b>\n\n` +
                `⚡ <a href="https://t.me/${config.telegram.botUsername}">🎬 Получить видео</a> — отправь команду /video`;
            
            sendTelegramMessage(message);
            sendTelegramMessage(`✅ <b>ЗАФИКСИРОВАНО:</b> ${playerName} зашёл в ${formattedTime}`);
            
            // Сбрасываем флаг через 10 минут
            setTimeout(() => { playerDetected = false; }, 600000);
        }
    });
    
    // Мониторим выход игроков
    bot.on('playerLeft', (player) => {
        if (player.username === config.targetNick) {
            logToFile(`🚪 Цель покинула сервер: ${player.username}`, 'PLAYER');
            sendTelegramMessage(`🚪 <b>Цель покинула сервер</b>\n👤 ${player.username}\n⏰ ${new Date().toLocaleString('ru-RU')}`);
        }
    });
    
    // Обработка сообщений в чате (команды)
    bot.on('chat', (username, message) => {
        if (username === config.ownerNick) {
            if (message === '!видео' || message === '!video') {
                createAndSendVideo();
                bot.chat('🎬 Создаю видео и отправляю в Telegram...');
            } else if (message === '!статус') {
                bot.chat(`🤖 Бот активен | Скриншотов: ${screenshotQueue.length} | Цель: ${config.targetNick}`);
            }
        }
    });
    
    // Автоответ на /ping
    bot.on('message', (message) => {
        if (message.toString().includes('/ping')) {
            bot.chat('🤖 Бот работает, всё ок!');
        }
    });
    
    // Переподключение
    bot.on('end', (reason) => {
        logToFile(`❌ Отключён: ${reason}`, 'BOT');
        sendTelegramMessage(`⚠️ <b>Бот отключился</b>\nПричина: ${reason}\nПереподключение через ${config.bot.reconnectDelay/1000} сек...`);
        setTimeout(createBot, config.bot.reconnectDelay);
    });
    
    bot.on('error', (err) => {
        logToFile(`❌ Ошибка бота: ${err.message}`, 'ERROR');
    });
    
    bot.on('kicked', (reason) => {
        logToFile(`👢 Бот кикнут: ${reason}`, 'BOT');
        sendTelegramMessage(`👢 <b>Бота кикнули с сервера</b>\nПричина: ${reason}\nПереподключаюсь...`);
        setTimeout(createBot, config.bot.reconnectDelay);
    });
}

// ========== ЗАПУСК ==========
logToFile('='.repeat(60), 'START');
logToFile('🤖 ЗАПУСК MINECRAFT AFK БОТА', 'START');
logToFile('='.repeat(60), 'START');

// Проверяем наличие необходимых утилит
async function checkDependencies() {
    const deps = ['scrot', 'ffmpeg', 'import'];
    for (const dep of deps) {
        try {
            await new Promise((resolve) => {
                const proc = spawn('which', [dep]);
                proc.on('close', (code) => {
                    if (code === 0) {
                        logToFile(`✅ Найдена утилита: ${dep}`, 'DEPENDENCY');
                    } else {
                        logToFile(`⚠️ Не найдена: ${dep} — установите: sudo apt install ${dep === 'import' ? 'imagemagick' : dep}`, 'WARN');
                    }
                    resolve();
                });
            });
        } catch(e) {}
    }
}

checkDependencies().then(() => {
    createBot();
});

// Обработка завершения процесса
process.on('SIGINT', () => {
    logToFile('🛑 Получен сигнал завершения, закрываю бота...', 'SHUTDOWN');
    if (bot) bot.end();
    setTimeout(() => process.exit(0), 1000);
});
