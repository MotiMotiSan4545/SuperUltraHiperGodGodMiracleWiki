// index.js (PostgreSQL 対応版)

require("dotenv").config();
console.log("[CHECK] index.js 開始");

// --- DB Connection Setup (From replace.js logic) ---
const { Pool } = require("pg");
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// 既存のライブラリ
const stringSimilarity = require("string-similarity");
const token = process.env.DISCORD_TOKEN;
const fs = require("node:fs");
const path = require("node:path");
const authPanel = require("./commands/aaa/auth-panel.js");
const { Player } = require("discord-player");
const axios = require("axios");
const Jimp = require("jimp");
const express = require("express");
const {
    Client,
    Collection,
    Events,
    GatewayIntentBits,
    ChannelType,
} = require("discord.js");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 1280;

// --- グローバル設定変数 (メモリキャッシュ) ---
// DBから読み込んだデータをここに保持し、Botの動作はここを参照します
let ngWordsData = {};
global.insultSettings = {};
global.threadSpamSettings = new Map();
global.spamExclusionRoles = new Map();
global.exclusionRoles = new Map();
let gifDetectorSettingsCache = {}; // GIF設定用キャッシュ

// --- Database Initialization & Helper Functions ---

// データベースの初期化とテーブル作成
async function initDatabase() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Settings Tables (JSONBを使用して既存のデータ構造をそのまま保存します)
        await client.query(`
            CREATE TABLE IF NOT EXISTS bot_ng_words (
                guild_id TEXT PRIMARY KEY,
                data JSONB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS bot_exclusion_roles (
                guild_id TEXT PRIMARY KEY,
                data JSONB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS bot_gif_settings (
                guild_id TEXT PRIMARY KEY,
                data JSONB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS bot_insult_settings (
                guild_id TEXT PRIMARY KEY,
                data JSONB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS bot_thread_spam_settings (
                guild_id TEXT PRIMARY KEY,
                data JSONB NOT NULL
            );
        `);
        
        await client.query('COMMIT');
        console.log("✅ データベーステーブルの初期化完了");
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("❌ データベース初期化エラー:", err);
    } finally {
        client.release();
    }
}

// 全設定をDBからメモリにロードする
async function loadSettingsFromDB() {
    try {
        // NG Words
        const ngRes = await pool.query('SELECT * FROM bot_ng_words');
        ngWordsData = {};
        ngRes.rows.forEach(row => {
            ngWordsData[row.guild_id] = row.data;
        });

        // Exclusion Roles
        const excRes = await pool.query('SELECT * FROM bot_exclusion_roles');
        global.exclusionRoles = new Map();
        global.spamExclusionRoles = new Map();
        
        excRes.rows.forEach(row => {
            const guildId = row.guild_id;
            const roles = row.data;
            
            const convertedRoles = {
                spam: new Set(roles.spam || []),
                profanity: new Set(roles.profanity || []),
                inmu: new Set(roles.inmu || []),
                link: new Set(roles.link || []),
                threadSpam: new Set(roles.threadSpam || []),
                profanityDetection: new Set(roles.profanityDetection || []),
            };
            
            global.exclusionRoles.set(guildId, convertedRoles);
            global.spamExclusionRoles.set(guildId, convertedRoles.spam);
        });

        // GIF Settings
        const gifRes = await pool.query('SELECT * FROM bot_gif_settings');
        gifDetectorSettingsCache = {};
        gifRes.rows.forEach(row => {
            gifDetectorSettingsCache[row.guild_id] = row.data;
        });

        // Insult Settings
        const insultRes = await pool.query('SELECT * FROM bot_insult_settings');
        global.insultSettings = {};
        insultRes.rows.forEach(row => {
            global.insultSettings[row.guild_id] = row.data;
        });
        
        // Thread Spam Settings (Optional persistence)
        const threadRes = await pool.query('SELECT * FROM bot_thread_spam_settings');
        global.threadSpamSettings = new Map();
        threadRes.rows.forEach(row => {
            global.threadSpamSettings.set(row.guild_id, row.data);
        });

        console.log("✅ DBから設定をロードしました");
    } catch (error) {
        console.error("❌ 設定ロードエラー:", error);
    }
}

// 設定保存用関数 (fs.writeFileSyncの代わり)
async function saveNgWordsToDB(guildId, data) {
    // メモリ更新
    if (guildId) ngWordsData[guildId] = data;
    // DB更新
    try {
        if (guildId) {
             await pool.query(
                `INSERT INTO bot_ng_words (guild_id, data) VALUES ($1 (¥155), <span class="currency-converted" title="自動変換: $2 → ¥311" data-original="$2" data-jpy="311" style="color: rgb(33, 150, 243); font-weight: bold;">$2 (¥311)</span>)
                 ON CONFLICT(guild_id) DO UPDATE SET data = &lt;span class="currency-converted" title="自動変換: $2 → ¥311" data-original="$2" data-jpy="311" style="color: rgb(33, 150, 243); font-weight: bold;"&gt;$2 (¥311)&lt;/span&gt;`,
                [guildId, data]
            );
        } else {
            // 全保存の場合（互換性のため）
            for (const [gid, d] of Object.entries(ngWordsData)) {
                await pool.query(
                    `INSERT INTO bot_ng_words (guild_id, data) VALUES ($1 (¥155), <span class="currency-converted" title="自動変換: $2 → ¥311" data-original="$2" data-jpy="311" style="color: rgb(33, 150, 243); font-weight: bold;">$2 (¥311)</span>)
                     ON CONFLICT(guild_id) DO UPDATE SET data = &lt;span class="currency-converted" title="自動変換: $2 → ¥311" data-original="$2" data-jpy="311" style="color: rgb(33, 150, 243); font-weight: bold;"&gt;$2 (¥311)&lt;/span&gt;`,
                    [gid, d]
                );
            }
        }
    } catch (e) {
        console.error("Failed to save NG Words to DB:", e);
    }
}

// 従来の saveNgWords 関数をラップ (互換性維持)
function saveNgWords() {
    saveNgWordsToDB(null, null); // 全保存トリガー
}

// 除外ロール保存
global.saveExclusionRolesToDB = async function(guildId, dataObj) {
    try {
        await pool.query(
            `INSERT INTO bot_exclusion_roles (guild_id, data) VALUES ($1 (¥155), <span class="currency-converted" title="自動変換: $2 → ¥311" data-original="$2" data-jpy="311" style="color: rgb(33, 150, 243); font-weight: bold;">$2 (¥311)</span>)
             ON CONFLICT(guild_id) DO UPDATE SET data = &lt;span class="currency-converted" title="自動変換: $2 → ¥311" data-original="$2" data-jpy="311" style="color: rgb(33, 150, 243); font-weight: bold;"&gt;$2 (¥311)&lt;/span&gt;`,
            [guildId, dataObj]
        );
        // メモリ更新はコマンド側で行われている前提ですが、必要ならここでもSet再構築を行う
    } catch (e) {
        console.error("Failed to save Exclusion Roles:", e);
    }
};

// --- Bot Settings & Constants ---

// スパム検知のための設定
const SPAM_THRESHOLD_MESSAGES = 3;
const SPAM_THRESHOLD_TIME_MS = 10000;
const SIMILARITY_THRESHOLD = 0.6;
const userMessageHistory = new Map();

// スレッドスパム検知のための設定
const THREAD_SPAM_THRESHOLD_OPERATIONS = 3;
const THREAD_SPAM_THRESHOLD_TIME_MS = 30000;
const THREAD_SPAM_TIMEOUT_DURATION = 600000;
const userThreadHistory = new Map();

// レイド対策のための設定
const RAID_DETECTION_WINDOW = 5 * 60 * 1000;
const RAID_THRESHOLD_MULTIPLIER = 5;
const MIN_RAID_MEMBERS = 5;
const NORMAL_PERIOD_DAYS = 7;
const joinHistory = new Map();

const userMessageData = new Map();
const raidModeStatus = new Map();

console.log("[CHECK] 取得したPORT:", PORT);

// GIF検出設定を読み込む (キャッシュから)
function loadGifDetectorSettings() {
    return gifDetectorSettingsCache;
}

// 色の明度を計算(0-255)
function getLuminance(r, g, b) {
    return 0.299 * r + 0.587 * g + 0.114 * b;
}

// RGBから色相を計算(0-360)
function getHue(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    if (delta === 0) return 0;

    let hue;
    if (max === r) {
        hue = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
    } else if (max === g) {
        hue = ((b - r) / delta + 2) / 6;
    } else {
        hue = ((r - g) / delta + 4) / 6;
    }

    return hue * 360;
}

/**
 * ピクセルバッファから平均色・輝度・色相を計算する
 */
function calculateAverageFromPixels(pixelBuffer, sampleRate = 100) {
    let totalR = 0,
        totalG = 0,
        totalB = 0;
    let pixelCount = 0;

    for (let i = 0; i < pixelBuffer.length; i += 4 * sampleRate) {
        if (pixelBuffer[i + 3] === 0) {
            continue;
        }

        totalR += pixelBuffer[i];
        totalG += pixelBuffer[i + 1];
        totalB += pixelBuffer[i + 2];
        pixelCount++;
    }

    if (pixelCount === 0) {
        return { luminance: 0, hue: 0, r: 0, g: 0, b: 0 };
    }

    const avgR = Math.round(totalR / pixelCount);
    const avgG = Math.round(totalG / pixelCount);
    const avgB = Math.round(totalB / pixelCount);

    const luminance = getLuminance(avgR, avgG, avgB);
    const hue = getHue(avgR, avgG, avgB);

    return { luminance, hue, r: avgR, g: avgG, b: avgB };
}

// URLからGIF画像を検出する関数(Imgur対応版)
function extractImageUrlsFromMessage(content) {
    const urls = [];

    const urlPattern =
        /(https?:\/\/[^\s]+\.(?:gif|png|jpg|jpeg|webp)(?:\?[^\s]*)?)/gi;
    const matches = content.match(urlPattern);

    if (matches) {
        urls.push(...matches);
    }

    const tenorMediaPattern =
        /(https?:\/\/(?:media\.tenor\.com|c\.tenor\.com)\/[^\s]+\.gif)/gi;
    const tenorMediaMatches = content.match(tenorMediaPattern);
    if (tenorMediaMatches) {
        urls.push(...tenorMediaMatches);
    }

    const giphyPattern =
        /(https?:\/\/(?:media\.giphy\.com|i\.giphy\.com)\/[^\s]+\.gif)/gi;
    const giphyMatches = content.match(giphyPattern);
    if (giphyMatches) {
        urls.push(...giphyMatches);
    }

    const imgurDirectPattern =
        /(https?:\/\/i\.imgur\.com\/[a-zA-Z0-9]+\.(?:gif|png|jpg|jpeg|webp))/gi;
    const imgurDirectMatches = content.match(imgurDirectPattern);
    if (imgurDirectMatches) {
        urls.push(...imgurDirectMatches);
    }

    return urls;
}

// URLから画像情報を取得
async function getImageInfoFromUrl(url) {
    try {
        const headResponse = await axios.head(url, {
            timeout: 5000,
            maxRedirects: 5,
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            },
            validateStatus: function (status) {
                return status < 500;
            },
        });

        if (headResponse.status === 429) {
            return null;
        }

        const contentType = headResponse.headers["content-type"];
        const contentLength = parseInt(
            headResponse.headers["content-length"] || "0",
        );

        if (!contentType || !contentType.startsWith("image/")) {
            return null;
        }

        return {
            url: url,
            name: url.split("/").pop().split("?")[0] || "image",
            size: contentLength,
            contentType: contentType,
            isFromUrl: true,
        };
    } catch (error) {
        return null;
    }
}

// GIFフレーム情報を解析
async function analyzeGifFrames(buffer) {
    const frames = [];

    try {
        let gif;
        try {
            gif = await Jimp.read(buffer);
        } catch (jimpError) {
            console.error("Jimp読み込みエラー:", jimpError.message);
            return [];
        }

        const frameData = gif._frames || gif.frames || [];

        if (!frameData || frameData.length === 0) {
            const { luminance, hue, r, g, b } = calculateAverageFromPixels(
                gif.bitmap.data,
                100,
            );
            return [
                {
                    delay: 0,
                    luminance: luminance,
                    hue: hue,
                    r: r,
                    g: g,
                    b: b,
                },
            ];
        }

        if (frameData.length > 200) {
            return [];
        }

        for (let i = 0; i < frameData.length; i++) {
            const frame = frameData[i];
            const pixelData = frame.bitmap ? frame.bitmap.data : frame.data;

            if (!pixelData) {
                continue;
            }

            const delay = (frame.delay || 10) * 10;
            const { luminance, hue, r, g, b } = calculateAverageFromPixels(
                pixelData,
                100,
            );

            frames.push({
                delay: delay,
                luminance: luminance,
                hue: hue,
                r: r,
                g: g,
                b: b,
            });
        }
    } catch (error) {
        console.error("❌ GIF解析中の致命的エラー:", error.message);
        return [];
    }

    return frames;
}

// 改善された点滅GIF検出
function detectFlashingGif(frames) {
    if (frames.length < 2) {
        return { isFlashing: false, reason: "フレーム数不足または解析失敗" };
    }

    let rapidChanges = 0;
    let maxLuminanceChange = 0;
    let maxHueChange = 0;
    let veryFastFrames = 0;
    let consecutiveRapidChanges = 0;
    let maxConsecutiveRapidChanges = 0;

    for (let i = 1; i < frames.length; i++) {
        const prev = frames[i - 1];
        const curr = frames[i];

        const luminanceChange = Math.abs(curr.luminance - prev.luminance);
        maxLuminanceChange = Math.max(maxLuminanceChange, luminanceChange);

        let hueChange = Math.abs(curr.hue - prev.hue);
        if (hueChange > 180) hueChange = 360 - hueChange;
        maxHueChange = Math.max(maxHueChange, hueChange);

        if (curr.delay <= 2) {
            veryFastFrames++;
        }

        if (luminanceChange > 150 && hueChange > 150) {
            rapidChanges++;
            consecutiveRapidChanges++;
            maxConsecutiveRapidChanges = Math.max(
                maxConsecutiveRapidChanges,
                consecutiveRapidChanges,
            );
        } else {
            consecutiveRapidChanges = 0;
        }
    }

    const changeRate = rapidChanges / (frames.length - 1);
    const fastFrameRate = veryFastFrames / frames.length;

    const isFlashing =
        changeRate > 0.6 ||
        (changeRate > 0.4 && fastFrameRate > 0.6) ||
        (maxLuminanceChange > 180 &&
            maxHueChange > 180 &&
            fastFrameRate > 0.5) ||
        maxConsecutiveRapidChanges >= 5;

    return {
        isFlashing: isFlashing,
        details: {
            totalFrames: frames.length,
            rapidChanges: rapidChanges,
            changeRate: (changeRate * 100).toFixed(1) + "%",
            maxLuminanceChange: Math.round(maxLuminanceChange),
            maxHueChange: Math.round(maxHueChange),
            veryFastFrames: veryFastFrames,
            fastFrameRate: (fastFrameRate * 100).toFixed(1) + "%",
            maxConsecutiveRapidChanges: maxConsecutiveRapidChanges,
        },
    };
}

// 危険なGIFを検出する関数
async function checkDangerousGif(attachment) {
    try {
        if (
            !attachment.contentType ||
            !attachment.contentType.startsWith("image/")
        ) {
            return { isDangerous: false };
        }

        if (attachment.size > 15 * 1024 * 1024) {
            return {
                isDangerous: true,
                reason: "ファイルサイズが大きすぎます",
                details: `${(attachment.size / 1024 / 1024).toFixed(2)}MB`,
            };
        }

        if (attachment.contentType === "image/gif") {
            try {
                const response = await axios.get(attachment.url, {
                    responseType: "arraybuffer",
                    timeout: 15000,
                    maxContentLength: 20 * 1024 * 1024,
                });

                const buffer = Buffer.from(response.data);
                const header = buffer.toString("ascii", 0, 6);

                if (header !== "GIF87a" && header !== "GIF89a") {
                    return {
                        isDangerous: true,
                        reason: "無効なGIFファイル形式",
                    };
                }

                const width = buffer.readUInt16LE(6);
                const height = buffer.readUInt16LE(8);

                if (width > 8192 || height > 8192) {
                    return {
                        isDangerous: true,
                        reason: "解像度が大きすぎます",
                        details: `${width}x${height}`,
                    };
                }

                const frames = await analyzeGifFrames(buffer);

                if (frames.length > 500) {
                    return {
                        isDangerous: true,
                        reason: "フレーム数が多すぎます",
                        details: `${frames.length}フレーム`,
                    };
                }

                const flashResult = detectFlashingGif(frames);

                if (flashResult.isFlashing) {
                    return {
                        isDangerous: true,
                        reason: "点滅GIF(フォトセンシティブ発作の危険性)",
                        details: flashResult.details,
                    };
                }

                if (frames.length > 50 && buffer.length / frames.length < 100) {
                    return {
                        isDangerous: true,
                        reason: "異常なファイル構造(クラッシュGIF)",
                    };
                }

            } catch (error) {
                console.error("❌ GIF解析中のエラー:", error.message);
                if (
                    error.code === "ECONNABORTED" ||
                    error.code === "ERR_BAD_REQUEST"
                ) {
                    return {
                        isDangerous: true,
                        reason: "ファイルの読み込みに失敗(破損またはサイズ過大)",
                    };
                }

                return {
                    isDangerous: true,
                    reason: "GIF解析エラー(安全のため制限)",
                };
            }
        }

        return { isDangerous: false };
    } catch (error) {
        console.error("❌ GIFチェック中の外部エラー:", error);
        return { isDangerous: false };
    }
}

// レイドモード状態をリセットする関数
function resetRaidMode(guildId) {
    raidModeStatus.delete(guildId);
    console.log(`レイドモード状態をリセットしました - Guild ID: ${guildId}`);
}

// スレッドスパム検知関数
async function checkThreadSpam(member, guild) {
    const userId = member.id;
    const guildId = guild.id;
    const now = Date.now();

    const serverSettings = global.threadSpamSettings.get(guildId) || {
        threshold: THREAD_SPAM_THRESHOLD_OPERATIONS,
        timeWindow: THREAD_SPAM_THRESHOLD_TIME_MS,
        timeoutDuration: THREAD_SPAM_TIMEOUT_DURATION,
    };

    if (!userThreadHistory.has(userId)) {
        userThreadHistory.set(userId, []);
    }

    const history = userThreadHistory.get(userId);

    const cleanHistory = history.filter(
        (entry) =>
            now - entry.timestamp < serverSettings.timeWindow &&
            entry.guildId === guildId,
    );

    cleanHistory.push({ timestamp: now, guildId: guildId });
    userThreadHistory.set(userId, cleanHistory);

    if (cleanHistory.length >= serverSettings.threshold) {
        console.log(`スレッドスパム検知！ユーザー: ${member.user.username}`);

        try {
            await member.timeout(
                serverSettings.timeoutDuration,
                "スレッドスパム検知による自動タイムアウト",
            );

            let logChannel = guild.channels.cache.find(
                (channel) =>
                    channel.name === "nightguard-log" &&
                    channel.type === ChannelType.GuildText,
            );

            if (!logChannel) {
                logChannel = await guild.channels.create({
                    name: "nightguard-log",
                    type: ChannelType.GuildText,
                    permissionOverwrites: [
                        {
                            id: guild.roles.everyone,
                            deny: ["ViewChannel"],
                        },
                        {
                            id: client.user.id,
                            allow: ["ViewChannel", "SendMessages"],
                        },
                    ],
                    reason: "スレッドスパム検知ログ用チャンネルを作成",
                });
            }

            const timeoutMinutes = Math.ceil(
                serverSettings.timeoutDuration / 60000,
            );
            await logChannel.send(
                `🚨 **スレッドスパム検知 & 自動タイムアウト** 🚨\n` +
                    `ユーザー: ${member.user.username} (${member.user.id})\n` +
                    `検知内容: ${Math.floor(serverSettings.timeWindow / 1000)}秒間に${cleanHistory.length}回のスレッド操作\n` +
                    `タイムアウト時間: ${timeoutMinutes}分\n` +
                    `自動的にタイムアウトしました。`,
            );

            userThreadHistory.delete(userId);

            return true;
        } catch (error) {
            console.error(`スレッドスパムタイムアウト失敗 (${userId}):`, error);
        }
    }

    return false;
}

// グローバルでアクセスできるようにする
global.resetRaidMode = resetRaidMode;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

client.commands = new Collection();

const foldersPath = path.join(__dirname, "commands");
const commandFolders = fs.readdirSync(foldersPath);
const player = new Player(client);
client.player = player;

for (const folder of commandFolders) {
    const commandsPath = path.join(foldersPath, folder);
    const commandFiles = fs
        .readdirSync(commandsPath)
        .filter((file) => file.endsWith(".js"));
    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const command = require(filePath);
        if ("data" in command && "execute" in command) {
            client.commands.set(command.data.name, command);
        } else {
            console.log(
                `[あれ] ${filePath}のコマンドには、dataかexecuteのプロパティがないんだってさ。`,
            );
        }
    }
}

// 暴言リストのみ残す
const abunai_words = [
    "死ね",
    "消えろ",
    "殺す",
    "殺して",
    "殺してやる",
    "障害者",
    "ガイジ",
    "がいじ",
    "知的障害",
    "きえろ",
    "ころす",
    "ころして",
    "ころしてやる",
    "しょうがいしゃ",
    "ちてきしょうがい",
    "!kiken",
    "RAID BY OZEU",
    "discord.gg/ozeu",
    "discord.gg/ozeu-x",
];

// 危険なBotのIDリスト
const DANGEROUS_BOT_IDS = [
    "1363066479100170330",
    "1286667959397515355",
    "1371866834818826380",
    "1321414173602746419",
    "1349568375839264870",
    "1352599521032540190",
    "1378391189576876174",
    "1336633477868683305",
    "1352779479302410260",
    "1379825654035648555",
    "1386680498537107666",
];

// アプリケーション使用時の悪意あるワード
const MALICIOUS_APP_WORDS = [
    "死ね",
    "殺す",
    "殺して",
    "消えろ",
    "ころす",
    "しね",
    "きえろ",
    "障害者",
    "ガイジ",
    "がいじ",
    "知的障害",
    "ちてきしょうがい",
    "バカ",
    "アホ",
    "ばか",
    "あほ",
    "うざい",
    "きもい",
    "気持ち悪い",
    "うんち",
    "うんこ",
    "クソ",
    "くそ",
    "ファック",
    "fuck",
    "shit",
    "bitch",
    "RAID BY OZEU",
    "discord.gg/ozeu",
    "discord.gg/ozeu-x",
];

// NukeBot検知のための設定
const NUKEBOT_DETECTION_WINDOW = 2 * 60 * 1000;
const NUKEBOT_ROLE_THRESHOLD = 10;
const NUKEBOT_CHANNEL_THRESHOLD = 5;
const nukeBotHistory = new Map();

function hasProfanityExclusion(member, guildId) {
    const exclusion = global.exclusionRoles?.get(guildId);
    if (!exclusion || exclusion.profanityDetection?.size === 0) return false;
    return member.roles.cache.some((role) =>
        exclusion.profanityDetection.has(role.id),
    );
}

// NukeBot検知用の操作履歴を記録する関数
function recordBotActivity(botId, guildId, activityType) {
    const now = Date.now();
    const key = `${botId}-${guildId}`;

    if (!nukeBotHistory.has(key)) {
        nukeBotHistory.set(key, {
            roleActions: [],
            channelActions: [],
        });
    }

    const history = nukeBotHistory.get(key);
    const windowStart = now - NUKEBOT_DETECTION_WINDOW;

    if (activityType === "role") {
        history.roleActions = history.roleActions.filter(
            (timestamp) => timestamp >= windowStart,
        );
        history.roleActions.push(now);
    } else if (activityType === "channel") {
        history.channelActions = history.channelActions.filter(
            (timestamp) => timestamp >= windowStart,
        );
        history.channelActions.push(now);
    }

    nukeBotHistory.set(key, history);
    return history;
}

// NukeBot検知関数
async function checkForNukeBot(guild, botUser, activityType) {
    const history = recordBotActivity(botUser.id, guild.id, activityType);

    const roleActionsCount = history.roleActions.length;
    const channelActionsCount = history.channelActions.length;

    console.log(
        `NukeBot検知チェック - Bot: ${botUser.username}, ロール操作: ${roleActionsCount}, チャンネル操作: ${channelActionsCount}`,
    );

    if (
        roleActionsCount >= NUKEBOT_ROLE_THRESHOLD ||
        channelActionsCount >= NUKEBOT_CHANNEL_THRESHOLD
    ) {
        console.log(`NukeBot検知！ Bot: ${botUser.username} (${botUser.id})`);
        await banNukeBot(guild, botUser, roleActionsCount, channelActionsCount);
    }
}

// NukeBotをBANする関数
async function banNukeBot(guild, botUser, roleCount, channelCount) {
    try {
        const member = guild.members.cache.get(botUser.id);
        if (!member) return;

        await member.ban({
            reason: `NukeBot検知: 2分間でロール操作${roleCount}回、チャンネル操作${channelCount}回`,
        });

        console.log(
            `NukeBot ${botUser.username} (${botUser.id}) をBANしました`,
        );

        let logChannel = guild.channels.cache.find(
            (channel) =>
                channel.name === "nightguard-log" &&
                channel.type === ChannelType.GuildText,
        );

        if (!logChannel) {
            logChannel = await guild.channels.create({
                name: "nightguard-log",
                type: ChannelType.GuildText,
                permissionOverwrites: [
                    {
                        id: guild.roles.everyone,
                        deny: ["ViewChannel"],
                    },
                    {
                        id: client.user.id,
                        allow: ["ViewChannel", "SendMessages"],
                    },
                ],
                reason: "NukeBot検知ログ用チャンネルを作成",
            });
        }

        await logChannel.send(
            `🚨 **NukeBot検知 & 自動BAN** 🚨\n` +
                `Bot名: ${botUser.username}\n` +
                `BotID: \`${botUser.id}\`\n` +
                `検知理由: 2分間で異常な操作を検知\n` +
                `- ロール操作: ${roleCount}回\n` +
                `- チャンネル操作: ${channelCount}回\n` +
                `自動的にBANしました。サーバーを保護しています。`,
        );
    } catch (error) {
        console.error(
            `NukeBot (${botUser.id}) のBAN中にエラーが発生しました:`,
            error,
        );
    }
}

// 通常の参加者ペースを計算する関数
function calculateNormalJoinRate(guildId) {
    const history = joinHistory.get(guildId) || [];
    const now = Date.now();
    const normalPeriodStart = now - NORMAL_PERIOD_DAYS * 24 * 60 * 60 * 1000;

    const normalPeriodJoins = history.filter(
        (timestamp) => timestamp >= normalPeriodStart,
    );

    if (normalPeriodJoins.length === 0) {
        return 0;
    }

    const hoursInPeriod = (now - normalPeriodStart) / (60 * 60 * 1000);
    const avgJoinsPerHour = normalPeriodJoins.length / hoursInPeriod;
    return avgJoinsPerHour * (5 / 60);
}

// レイド検知関数
async function checkForRaid(guild) {
    const guildId = guild.id;
    const history = joinHistory.get(guildId) || [];
    const now = Date.now();
    const windowStart = now - RAID_DETECTION_WINDOW;

    const recentJoins = history.filter((timestamp) => timestamp >= windowStart);
    const recentJoinCount = recentJoins.length;

    const normalRate = calculateNormalJoinRate(guildId);
    const threshold = Math.max(
        normalRate * RAID_THRESHOLD_MULTIPLIER,
        MIN_RAID_MEMBERS,
    );

    if (recentJoinCount >= threshold) {
        console.log(`レイド検知！ サーバー: ${guild.name}`);
        await activateRaidMode(guild);
    }
}

// レイドモード有効化関数
async function activateRaidMode(guild) {
    try {
        const guildId = guild.id;

        if (raidModeStatus.get(guildId)) {
            console.log(`レイドモードは既に有効です - サーバー: ${guild.name}`);
            return;
        }

        let raidGuardRole = guild.roles.cache.find(
            (role) => role.name === "RaidGuard_NightGuard",
        );

        const isNewRaidMode = !raidGuardRole;

        if (!raidGuardRole) {
            raidGuardRole = await guild.roles.create({
                name: "RaidGuard_NightGuard",
                color: "#FF0000",
                reason: "レイド対策用制限ロール",
            });
            console.log(`RaidGuard_NightGuardロールを作成しました`);

            guild.channels.cache.forEach(async (channel) => {
                if (
                    channel.type === ChannelType.GuildText ||
                    channel.type === ChannelType.GuildVoice
                ) {
                    try {
                        await channel.permissionOverwrites.create(
                            raidGuardRole,
                            {
                                SendMessages: false,
                                AddReactions: false,
                                SendMessagesInThreads: false,
                                CreatePublicThreads: false,
                                CreatePrivateThreads: false,
                            },
                        );
                    } catch (error) {
                        console.error(
                            `チャンネル ${channel.name} の権限設定に失敗:`,
                            error,
                        );
                    }
                }
            });
        }

        raidModeStatus.set(guildId, true);

        const now = Date.now();
        const recentJoinThreshold = now - RAID_DETECTION_WINDOW;

        const recentMembers = guild.members.cache.filter(
            (member) =>
                member.joinedTimestamp >= recentJoinThreshold &&
                !member.user.bot &&
                !member.roles.cache.has(raidGuardRole.id),
        );

        for (const [, member] of recentMembers) {
            try {
                await member.roles.add(raidGuardRole);
            } catch (error) {
                console.error(
                    `${member.user.username} へのロール与に失敗:`,
                    error,
                );
            }
        }

        if (isNewRaidMode) {
            let logChannel = guild.channels.cache.find(
                (channel) =>
                    channel.name === "nightguard-log" &&
                    channel.type === ChannelType.GuildText,
            );

            if (!logChannel) {
                logChannel = await guild.channels.create({
                    name: "nightguard-log",
                    type: ChannelType.GuildText,
                    permissionOverwrites: [
                        {
                            id: guild.roles.everyone,
                            deny: ["ViewChannel"],
                        },
                        {
                            id: client.user.id,
                            allow: ["ViewChannel", "SendMessages"],
                        },
                    ],
                    reason: "レイド対策ログ用チャンネルを作成",
                });
            }

            await logChannel.send(
                `⚠️ **異常な参加ペースを検知しました！**\n` +
                    `現在、いつもより明らかに早いスピードで新規メンバーが参加しています。\n` +
                    `あなたのサーバーが **Raidの標的**Thな ている可能性があります。\n` +
                    `🛡️ セキュリティ ードを自動で有効化し、**新規メンバー全員に \`RaidGuard_NightGuard\` ロール**を付与しました。\n` +
                    `**対応方法：**\n` +
                    `- 様子を見て問題が落ち着いたら \`/unmute_raid\` コマンドを実行してく  さい。\n` +
                    `- それまでは新規参加者を**慎重に監視**してください。\n` +
                    `- ❇️落ち着くことも重要です。 冷静な判断を下すためにお茶をを飲みながら警戒するのをおすすめします。\n` +
                    `*（by NightGuard）*`,
            );
        }
    } catch (error) {
        console.error("レイドモード有効化中にエラーが発生しました:", error);
    }
}

async function updatePresence() {
    const serverCount = client.guilds.cache.size;
    await client.user.setPresence({
        activities: [
            {
                name: `${serverCount}個のサーバーでせっせと働いています`,
                type: 0,
            },
        ],
        status: "online",
    });
}

client.on("ready", updatePresence);
client.on("guildCreate", updatePresence);
client.on("guildDelete", updatePresence);

client.on("ready", async () => {
    // 起動時にDB初期化と設定読み込みを実行
    await initDatabase();
    await loadSettingsFromDB();
    
    console.log(`${client.user.tag}でログインしました!!`);

    const activities = [
        () => `${client.guilds.cache.size}個のサーバーでせっせと働いています`,
        () => `導入は公式サイトから`,
    ];

    let index = 0;

    setInterval(() => {
        const status = activities[index % activities.length]();
        client.user.setPresence({
            activities: [{ name: status, type: 0 }],
            status: "online",
        });
        index++;
    }, 30000);
});

client.on(Events.GuildCreate, async (guild) => {
    try {
        console.log(`新しいサーバーに参加しました: ${guild.name}`);

        let logChannel = guild.channels.cache.find(
            (channel) =>
                channel.name === "nightguard-log" &&
                channel.type === ChannelType.GuildText,
        );

        if (!logChannel) {
            logChannel = await guild.channels.create({
                name: "nightguard-log",
                type: ChannelType.GuildText,
                permissionOverwrites: [
                    {
                        id: guild.roles.everyone,
                        deny: ["ViewChannel"],
                    },
                    {
                        id: client.user.id,
                        allow: ["ViewChannel", "SendMessages"],
                    },
                ],
                reason: "NightGuard初期化 - ログチャンネル作成",
            });
        }

        let muteRole = guild.roles.cache.find(
            (role) => role.name === "Muted_NightGuard",
        );
        if (!muteRole) {
            muteRole = await guild.roles.create({
                name: "Muted_NightGuard",
                color: "#808080",
                reason: "NightGuard初期化 - ミュートロール作成",
            });
        }

        let raidGuardRole = guild.roles.cache.find(
            (role) => role.name === "RaidGuard_NightGuard",
        );
        if (!raidGuardRole) {
            raidGuardRole = await guild.roles.create({
                name: "RaidGuard_NightGuard",
                color: "#FF0000",
                reason: "NightGuard初期化 - レイドガードロール作成",
            });
        }

        let appRestrictRole = guild.roles.cache.find(
            (role) => role.name === "AppRestrict_NightGuard",
        );
        if (!appRestrictRole) {
            appRestrictRole = await guild.roles.create({
                name: "AppRestrict_NightGuard",
                color: "#FFA500",
                reason: "NightGuard初期化 - アプリケーション制限ロール作成",
            });
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));

        const channels = guild.channels.cache.filter(
            (channel) =>
                channel.type === ChannelType.GuildText ||
                channel.type === ChannelType.GuildVoice,
        );

        for (const [, channel] of channels) {
            try {
                const botMember = guild.members.cache.get(client.user.id);
                if (
                    !channel
                        .permissionsFor(botMember)
                        .has(["ManageRoles", "ManageChannels"])
                ) {
                    continue;
                }

                await channel.permissionOverwrites.create(muteRole, {
                    SendMessages: false,
                    Speak: false,
                    AddReactions: false,
                    SendMessagesInThreads: false,
                    CreatePublicThreads: false,
                    CreatePrivateThreads: false,
                });

                await channel.permissionOverwrites.create(raidGuardRole, {
                    SendMessages: false,
                    AddReactions: false,
                    SendMessagesInThreads: false,
                    CreatePublicThreads: false,
                    CreatePrivateThreads: false,
                });

                await new Promise((resolve) => setTimeout(resolve, 200));
            } catch (error) {
                // エラーログ省略
            }
        }

        await logChannel.send({
            content:
                `\n` +
                `Botの導入ありがとうございます、NightGuardのロールの順位をなるべく高くして、\n` +
                `その下にRaidGuard_NightGuardロール、Muted_NightGuardロールを設置してください。\n` +
                `現在はおそらく権限の問題でチャンネルにロールが付いてないと思うので、上を行ってから/resetupコマンドの実行をお願いします`,
            files: ["https://i.imgur.com/hoaV8id.gif"],
        });

        console.log(`${guild.name} への初期化が完了しました`);
    } catch (error) {
        console.error(
            "サーバー参加時の初期化処理でエラーが発生しました:",
            error,
        );
    }
});

const COMMAND_COOLDOWN_TIME = 15000;
const commandCooldowns = new Map();

client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) {
        const command = interaction.client.commands.get(
            interaction.commandName,
        );
        if (!command) {
            return;
        }

        const userId = interaction.user.id;
        const commandName = interaction.commandName;
        const now = Date.now();

        if (!commandCooldowns.has(userId)) {
            commandCooldowns.set(userId, {});
        }

        const userCooldowns = commandCooldowns.get(userId);
        const lastExecuted = userCooldowns[commandName] || 0;
        const timeDiff = now - lastExecuted;

        if (timeDiff < COMMAND_COOLDOWN_TIME) {
            const remainingTime = Math.ceil(
                (COMMAND_COOLDOWN_TIME - timeDiff) / 1000,
            );
            await interaction.reply({
                content: `⏰ コマンドのクールダウン中です。あと ${remainingTime} 秒お待ちください。`,
                ephemeral: true,
            });
            return;
        }

        userCooldowns[commandName] = now;
        commandCooldowns.set(userId, userCooldowns);

        try {
            await command.execute(interaction);
        } catch (error) {
            console.error(error);
            const replyContent = {
                content: "コマンド実行してるときにエラー出たんだってさ。",
                ephemeral: true,
            };
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(replyContent);
            } else {
                await interaction.reply(replyContent);
            }
        }
    } else if (interaction.isButton() || interaction.isStringSelectMenu()) {
        if (
            interaction.customId === "start_auth" ||
            interaction.customId === "auth_answer"
        ) {
            await authPanel.handleAuthInteraction(interaction);
        }
    }
});

client.on(Events.GuildMemberAdd, async (member) => {
    const guildId = member.guild.id;
    const now = Date.now();

    if (!joinHistory.has(guildId)) {
        joinHistory.set(guildId, []);
    }

    const history = joinHistory.get(guildId);
    history.push(now);

    const sevenDaysAgo = now - NORMAL_PERIOD_DAYS * 24 * 60 * 60 * 1000;
    const cleanHistory = history.filter(
        (timestamp) => timestamp >= sevenDaysAgo,
    );
    joinHistory.set(guildId, cleanHistory);

    if (member.user.bot) {
        if (DANGEROUS_BOT_IDS.includes(member.user.id)) {
            try {
                await member.ban({ reason: "危険なBotのため自動BAN" });

                let logChannel = member.guild.channels.cache.find(
                    (channel) =>
                        channel.name === "nightguard-log" &&
                        channel.type === ChannelType.GuildText,
                );

                if (!logChannel) {
                    logChannel = await member.guild.channels.create({
                        name: "nightguard-log",
                        type: ChannelType.GuildText,
                        permissionOverwrites: [
                            {
                                id: member.guild.roles.everyone,
                                deny: ["ViewChannel"],
                            },
                            {
                                id: client.user.id,
                                allow: ["ViewChannel", "SendMessages"],
                            },
                        ],
                        reason: "危険なBotのログ用チャンネルを作成",
                    });
                }

                await logChannel.send(
                    `:rotating_light: **危険なBot検知 & BAN** :rotating_light:\n` +
                        `Botの名前: ${member.user.tag}\n` +
                        `BotのID: \`${member.user.id}\`\n` +
                        `理由: 危険なBotリストに含まれていたため、自動的にBANしました。`,
                );
            } catch (error) {
                console.error(
                    `危険なBot (${member.user.id}) のBANまたはログ送信中にエラーが発生しました:`,
                    error,
                );
            }
        }
    } else {
        await checkForRaid(member.guild);

        const raidGuardRole = member.guild.roles.cache.find(
            (role) => role.name === "RaidGuard_NightGuard",
        );
        const isRaidMode = raidModeStatus.get(guildId);

        if (raidGuardRole && isRaidMode) {
            try {
                await member.roles.add(raidGuardRole);
            } catch (error) {
                console.error(
                    `新規参加者へのRaidGuard_NightGuardロール付与に失敗:`,
                    error,
                );
            }
        }
    }
});

client.on(Events.GuildRoleCreate, async (role) => {
    try {
        const auditLogs = await role.guild.fetchAuditLogs({
            type: 30, // ROLE_CREATE
            limit: 1,
        });

        const logEntry = auditLogs.entries.first();
        if (logEntry && logEntry.executor && logEntry.executor.bot) {
            await checkForNukeBot(role.guild, logEntry.executor, "role");
        }
    } catch (error) {
        console.error("ロール作成監視中にエラーが発生しました:", error);
    }
});

client.on(Events.GuildRoleDelete, async (role) => {
    try {
        const auditLogs = await role.guild.fetchAuditLogs({
            type: 32, // ROLE_DELETE
            limit: 1,
        });

        const logEntry = auditLogs.entries.first();
        if (logEntry && logEntry.executor && logEntry.executor.bot) {
            await checkForNukeBot(role.guild, logEntry.executor, "role");
        }
    } catch (error) {
        console.error("ロール削除監視中にエラーが発生しました:", error);
    }
});

client.on(Events.ChannelCreate, async (channel) => {
    try {
        const auditLogs = await channel.guild.fetchAuditLogs({
            type: 10, // CHANNEL_CREATE
            limit: 1,
        });

        const logEntry = auditLogs.entries.first();
        if (logEntry && logEntry.executor && logEntry.executor.bot) {
            await checkForNukeBot(channel.guild, logEntry.executor, "channel");
        }
    } catch (error) {
        console.error("チャンネル作成監視中にエラーが発生しました:", error);
    }

    if (
        channel.type === ChannelType.GuildText ||
        channel.type === ChannelType.GuildVoice
    ) {
        const muteRole = channel.guild.roles.cache.find(
            (role) => role.name === "Muted_NightGuard",
        );

        if (muteRole) {
            try {
                await channel.permissionOverwrites.create(muteRole, {
                    SendMessages: false,
                    Speak: false,
                    AddReactions: false,
                    SendMessagesInThreads: false,
                    CreatePublicThreads: false,
                });
            } catch (error) {
                console.error(
                    `チャンネル ${channel.name} の権限設定に失敗:`,
                    error,
                );
            }
        }

        const raidGuardRole = channel.guild.roles.cache.find(
            (role) => role.name === "RaidGuard_NightGuard",
        );

        if (raidGuardRole) {
            try {
                await channel.permissionOverwrites.create(raidGuardRole, {
                    SendMessages: false,
                    AddReactions: false,
                    SendMessagesInThreads: false,
                    CreatePublicThreads: false,
                    CreatePrivateThreads: false,
                });
            } catch (error) {
                console.error(
                    `チャンネル ${channel.name} のRaidGuard_NightGuard権限設定に失敗:`,
                    error,
                );
            }
        }

        const appRestrictRole = channel.guild.roles.cache.find(
            (role) => role.name === "AppRestrict_NightGuard",
        );

        if (appRestrictRole) {
            try {
                await channel.permissionOverwrites.create(appRestrictRole, {
                    UseApplicationCommands: false,
                });
            } catch (error) {
                console.error(
                    `チャンネル ${channel.name} のAppRestrict_NightGuard権限設定に失敗:`,
                    error,
                );
            }
        }
    }
});

client.on(Events.ChannelDelete, async (channel) => {
    try {
        const auditLogs = await channel.guild.fetchAuditLogs({
            type: 12, // CHANNEL_DELETE
            limit: 1,
        });

        const logEntry = auditLogs.entries.first();
        if (logEntry && logEntry.executor && logEntry.executor.bot) {
            await checkForNukeBot(channel.guild, logEntry.executor, "channel");
        }
    } catch (error) {
        console.error("チャンネル削除監視中にエラーが発生しました:", error);
    }
});

client.on(Events.ThreadCreate, async (thread) => {
    if (!thread.ownerId) return;
    const member = thread.guild.members.cache.get(thread.ownerId);
    if (!member || member.user.bot) return;

    const guildId = thread.guild.id;
    const exclusion = global.exclusionRoles?.get(guildId);

    if (exclusion && exclusion.threadSpam?.size > 0) {
        const hasExclusionRole = member.roles.cache.some((role) =>
            exclusion.threadSpam.has(role.id),
        );
        if (hasExclusionRole) {
            return;
        }
    }

    await checkThreadSpam(member, thread.guild);
});

client.on(Events.ThreadUpdate, async (oldThread, newThread) => {
    if (!newThread.ownerId) return;
    const member = newThread.guild.members.cache.get(newThread.ownerId);
    if (!member || member.user.bot) return;

    if (
        oldThread.name !== newThread.name ||
        oldThread.archived !== newThread.archived ||
        oldThread.locked !== newThread.locked
    ) {
        const guildId = newThread.guild.id;
        const exclusion = global.exclusionRoles?.get(guildId);

        if (exclusion && exclusion.threadSpam?.size > 0) {
            const hasExclusionRole = member.roles.cache.some((role) =>
                exclusion.threadSpam.has(role.id),
            );
            if (hasExclusionRole) {
                return;
            }
        }

        await checkThreadSpam(member, newThread.guild);
    }
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

client.on("messageCreate", async (msg) => {
    if (msg.author.bot) return;

    const gifSettings = loadGifDetectorSettings();
    const guildId = msg.guild?.id;

    if (guildId && gifSettings[guildId]?.enabled) {
        const imagesToCheck = [];

        if (msg.attachments.size > 0) {
            msg.attachments.forEach((att) => {
                imagesToCheck.push(att);
            });
        }

        if (msg.content) {
            const urls = extractImageUrlsFromMessage(msg.content);
            if (urls.length > 0) {
                for (const url of urls) {
                    const imageInfo = await getImageInfoFromUrl(url);
                    if (imageInfo) {
                        imagesToCheck.push(imageInfo);
                    }
                }
            }
        }

        for (const attachment of imagesToCheck) {
            const result = await checkDangerousGif(attachment);

            if (result.isDangerous) {
                try {
                    await msg.delete();

                    let muteRole = msg.guild.roles.cache.find(
                        (role) => role.name === "Muted_NightGuard",
                    );

                    if (!muteRole) {
                        muteRole = await msg.guild.roles.create({
                            name: "Muted_NightGuard",
                            color: "#808080",
                            reason: "危険なGIF検出用ミュートロール",
                        });

                        msg.guild.channels.cache.forEach(async (channel) => {
                            if (
                                channel.type === ChannelType.GuildText ||
                                channel.type === ChannelType.GuildVoice
                            ) {
                                try {
                                    await channel.permissionOverwrites.create(
                                        muteRole,
                                        {
                                            SendMessages: false,
                                            Speak: false,
                                            AddReactions: false,
                                            SendMessagesInThreads: false,
                                            CreatePublicThreads: false,
                                            CreatePrivateThreads: false,
                                        },
                                    );
                                } catch (error) {
                                    console.error(
                                        `チャンネル ${channel.name} の権限設定に失敗:`,
                                        error,
                                    );
                                }
                            }
                        });
                    }

                    const member = msg.guild.members.cache.get(msg.author.id);
                    if (member) {
                        await member.roles.add(muteRole);

                        setTimeout(async () => {
                            try {
                                await member.roles.remove(muteRole);
                            } catch (error) {
                                console.error("ミュート解除エラー:", error);
                            }
                        }, 5000);
                    }

                    let detailsText = "";
                    if (result.details) {
                        if (typeof result.details === "string") {
                            detailsText = `詳細: ${result.details}`;
                        } else if (typeof result.details === "object") {
                            detailsText =
                                `詳細情報:\n` +
                                `  - 総フレーム数: ${result.details.totalFrames}\n` +
                                `  - 急激な変化: ${result.details.rapidChanges}回 (${result.details.changeRate})\n` +
                                `  - 最大輝度変化: ${result.details.maxLuminanceChange}\n` +
                                `  - 最大色相変化: ${result.details.maxHueChange}度\n` +
                                `  - 高速フレーム: ${result.details.veryFastFrames}個 (${result.details.fastFrameRate})`;
                        }
                    }

                    const warning = await msg.channel.send(
                        `🚨 ${msg.author} **危険なGIF/画像を検出しました** 🚨\n` +
                            `**検出理由**: ${result.reason}\n` +
                            `${attachment.isFromUrl ? "URL" : "ファイル"}: \`${attachment.name}\`\n` +
                            `サイズ: ${(attachment.size / 1024).toFixed(2)}KB\n` +
                            (detailsText ? `${detailsText}\n` : "") +
                            `\n⚠️ メッセージを削除し、5秒間のミュートを適用しました。`,
                    );

                    setTimeout(() => warning.delete().catch(() => {}), 15000);

                    let logChannel = msg.guild.channels.cache.find(
                        (channel) =>
                            channel.name === "nightguard-log" &&
                            channel.type === ChannelType.GuildText,
                    );

                    if (logChannel) {
                        await logChannel.send(
                            `🚨 **危険なGIF/画像検出** 🚨\n` +
                                `ユーザー: ${msg.author.tag} (${msg.author.id})\n` +
                                `チャンネル: ${msg.channel.name}\n` +
                                `${attachment.isFromUrl ? "URL" : "ファイル"}: \`${attachment.name}\`\n` +
                                `サイズ: ${(attachment.size / 1024).toFixed(2)}KB\n` +
                                `検出理由: ${result.reason}\n` +
                                (detailsText ? `${detailsText}\n` : "") +
                                `処理: メッセージ削除 + 5秒間ミュート`,
                        );
                    }

                    break;
                } catch (error) {
                    console.error("危険なGIF処理中のエラー:", error);
                }
            }
        }
    }

    if (msg.reference && msg.mentions.has(client.user)) {
        if (
            msg.content.includes("ファクトチェック") ||
            msg.content.includes("factcheck")
        ) {
            try {
                const repliedMessage = await msg.channel.messages.fetch(
                    msg.reference.messageId,
                );

                if (
                    !repliedMessage.content ||
                    repliedMessage.content.trim().length === 0
                ) {
                    await msg.reply(
                        "ファクトチェックできるテキストがありません。",
                    );
                    return;
                }

                const processingMessage =
                    await msg.reply("🔎 ファクトチェック中...");

                const model = genAI.getGenerativeModel({
                    model: "gemini-1.5-flash",
                });
                const result = await model.generateContent([
                    "以下の文が事実かどうかファクトチェックしてください。簡潔に解説も添えてください。",
                    repliedMessage.content,
                ]);
                const response = await result.response;
                const text = response.text();

                await processingMessage.edit(
                    `🔎 **ファクトチェック結果:**\n${text}`,
                );

                return;
            } catch (error) {
                console.error("FactCheck Error:", error);
                if (error.code === 10008) {
                    await msg.reply(
                        "リプライされたメッセージが見つかりません。メッセージが削除されているか、古すぎる可能性があります。",
                    );
                } else {
                    await msg.reply(
                        "エラーが発生しました。もう一度お試しください。",
                    );
                }
                return;
            }
        }
    }

    const exclusion = global.exclusionRoles?.get(guildId);

    if (exclusion && exclusion.spam?.size > 0) {
        const member = msg.guild.members.cache.get(msg.author.id);
        if (member) {
            const hasExclusionRole = member.roles.cache.some((role) =>
                exclusion.spam.has(role.id),
            );
            if (hasExclusionRole) {
                await processNonSpamMessage(msg);
                return;
            }
        }
    }

    const userId = msg.author.id;
    const now = Date.now();

    if (!userMessageHistory.has(userId)) {
        userMessageHistory.set(userId, []);
    }

    const history = userMessageHistory.get(userId);
    const cleanHistory = history.filter(
        (entry) => now - entry.timestamp < SPAM_THRESHOLD_TIME_MS,
    );

    let similarCount = 1;

    for (const entry of cleanHistory) {
        const similarity = stringSimilarity.compareTwoStrings(
            msg.content,
            entry.content,
        );
        if (similarity >= SIMILARITY_THRESHOLD) {
            similarCount++;
        }
    }

    cleanHistory.push({ content: msg.content, timestamp: now });
    userMessageHistory.set(userId, cleanHistory);

    if (similarCount >= SPAM_THRESHOLD_MESSAGES) {
        console.log(
            `スパム検知！ユーザー: ${msg.author.username}, 類似メッセージ数: ${similarCount}`,
        );

        try {
            await msg.delete();

            let muteRole = msg.guild.roles.cache.find(
                (role) => role.name === "Muted_NightGuard",
            );

            if (!muteRole) {
                muteRole = await msg.guild.roles.create({
                    name: "Muted_NightGuard",
                    color: "#808080",
                    reason: "スパム対策用ミュートロール",
                });

                msg.guild.channels.cache.forEach(async (channel) => {
                    if (
                        channel.type === ChannelType.GuildText ||
                        channel.type === ChannelType.GuildVoice
                    ) {
                        try {
                            await channel.permissionOverwrites.create(
                                muteRole,
                                {
                                    SendMessages: false,
                                    Speak: false,
                                    AddReactions: false,
                                    SendMessagesInThreads: false,
                                    CreatePublicThreads: false,
                                    CreatePrivateThreads: false,
                                },
                            );
                        } catch (error) {
                            console.error(
                                `チャンネル ${channel.name} の権限設定に失敗:`,
                                error,
                            );
                        }
                    }
                });
            }

            const member = msg.guild.members.cache.get(msg.author.id);
            if (member && !member.roles.cache.has(muteRole.id)) {
                await member.roles.add(muteRole);
            }

            const warn = await msg.channel.send(
                `${msg.author} 類似メッセージの連投を検知しました（${similarCount}件）\n` +
                    `自動的にミュートロールが付与されました。管理者にお問い合わせください。`,
            );
            setTimeout(() => warn.delete().catch(() => {}), 10000);

            return;
        } catch (err) {
            console.error("スパム処理失敗:", err);
        }
    }

    await handleNgWords(msg, false);
    await processNonSpamMessage(msg);
});

let appRestrictionEnabled = false;
global.appRestrictionEnabled = false;

client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isCommand()) {
        const user = interaction.user;
        const guild = interaction.guild;

        if (!guild) return;

        if (interaction.applicationId === client.user.id) {
            return;
        }

        if (global.appRestrictionEnabled) {
            try {
                let restrictRole = guild.roles.cache.find(
                    (role) => role.name === "AppRestrict_NightGuard",
                );

                if (!restrictRole) {
                    restrictRole = await guild.roles.create({
                        name: "AppRestrict_NightGuard",
                        color: "#FFA500",
                        reason: "アプリケーション使用制限ロール",
                    });

                    guild.channels.cache.forEach(async (channel) => {
                        if (
                            channel.type === ChannelType.GuildText ||
                            channel.type === ChannelType.GuildVoice
                        ) {
                            try {
                                await channel.permissionOverwrites.create(
                                    restrictRole,
                                    {
                                        UseApplicationCommands: false,
                                        UseSlashCommands: false,
                                    },
                                );
                            } catch (error) {
                                console.error(
                                    `チャンネル ${channel.name} のアプリケーション制限権限設定に失敗:`,
                                    error,
                                );
                            }
                        }
                    });
                }

                const member = guild.members.cache.get(user.id);
                if (member && !member.roles.cache.has(restrictRole.id)) {
                    await member.roles.add(restrictRole);

                    let logChannel = guild.channels.cache.find(
                        (channel) =>
                            channel.name === "nightguard-log" &&
                            channel.type === ChannelType.GuildText,
                    );

                    if (logChannel) {
                        await logChannel.send(
                            `🚨 **アプリケーション使用制限**\n` +
                                `ユーザー: ${user.username} (${user.id})\n` +
                                `コマンド: ${interaction.commandName || "unknown"}\n` +
                                `アプリケーション使用制限が有効なため、AppRestrict_NightGuardロールを付与しました。`,
                        );
                    }
                }

                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content:
                            "⚠️ 現在、外部アプリケーションの使用が制限されています。管理者にお問い合わせください。",
                        ephemeral: true,
                    });
                }
                return;
            } catch (error) {
                console.error(
                    "アプリケーション制限ロール付与中にエラーが発生しました:",
                    error,
                );
            }
        }

        let contentToCheck = "";

        if (interaction.commandName) {
            contentToCheck += interaction.commandName + " ";
        }

        if (interaction.options && interaction.options.data) {
            for (const option of interaction.options.data) {
                if (option.value && typeof option.value === "string") {
                    contentToCheck += option.value + " ";
                }
            }
        }

        const containsMaliciousWord = MALICIOUS_APP_WORDS.some((word) =>
            contentToCheck.toLowerCase().includes(word.toLowerCase()),
        );

        if (containsMaliciousWord) {
            try {
                let restrictRole = guild.roles.cache.find(
                    (role) => role.name === "AppRestrict_NightGuard",
                );

                if (!restrictRole) {
                    restrictRole = await guild.roles.create({
                        name: "AppRestrict_NightGuard",
                        color: "#FFA500",
                        reason: "アプリケーション使用制限ロール",
                    });
                }

                const member = guild.members.cache.get(user.id);
                if (member && !member.roles.cache.has(restrictRole.id)) {
                    await member.roles.add(restrictRole);

                    let logChannel = guild.channels.cache.find(
                        (channel) =>
                            channel.name === "nightguard-log" &&
                            channel.type === ChannelType.GuildText,
                    );

                    if (logChannel) {
                        await logChannel.send(
                            `🚨 **アプリケーション使用時の悪意あるワード検知**\n` +
                                `ユーザー: ${user.username} (${user.id})\n` +
                                `検知内容: "${contentToCheck}"\n` +
                                `AppRestrict_NightGuardロールを付与しました。`,
                        );
                    }
                }

                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content:
                            "⚠️ 不適切な内容が検出されました。アプリケーション使用制限ロールが付与されました。",
                        ephemeral: true,
                    });
                }
            } catch (error) {
                console.error(
                    "アプリケーション制限ロール付与中にエラーが発生しました:",
                    error,
                );
            }
        }
    }
});

async function handleNgWords(msg, isEdit = false) {
    const guildId = msg.guild?.id;
    if (!guildId || !ngWordsData[guildId]) return;

    const settings = ngWordsData[guildId];
    if (!settings.checkEdits && isEdit) return;

    const member = msg.guild.members.cache.get(msg.author.id);
    if (!member) return;

    if (hasProfanityExclusion(member, guildId)) {
        return;
    }

    if (settings.exceptionRoles?.some((rid) => member.roles.cache.has(rid)))
        return;

    const text = settings.caseSensitive
        ? msg.content
        : msg.content.toLowerCase();
    const words = settings.caseSensitive
        ? settings.words
        : settings.words.map((w) => w.toLowerCase());

    const hit = words.find((w) => text.includes(w));
    if (!hit) return;

    try {
        await msg.delete();

        if (settings.sendDM) {
            await msg.author.send(
                `⚠️ サーバー「${msg.guild.name}」でNGワード "${hit}" が検出されました。`,
            );
        }

        switch (settings.punishment) {
            case 0:
            case 1:
                break;
            case 2:
                await member.timeout(60_000, "NGワード違反");
                break;
            case 3:
                await member.timeout(5 * 60_000, "NGワード違反");
                break;
            case 4:
                await member.timeout(10 * 60_000, "NGワード違反");
                break;
            case 5:
                await member.timeout(30 * 60_000, "NGワード違反");
                break;
            case 6:
                await member.timeout(60 * 60_000, "NGワード違反");
                break;
            case 7:
                await member.timeout(24 * 60 * 60_000, "NGワード違反");
                break;
            case 8:
                await member.kick("NGワード違反");
                break;
            case 9:
                await member.ban({ reason: "NGワード違反" });
                break;
        }

        const logChannel = msg.guild.channels.cache.find(
            (c) => c.name === "nightguard-log" && c.isTextBased(),
        );
        if (logChannel) {
            await logChannel.send(
                `🚨 **NGワード検知** 🚨\n` +
                    `ユーザー: ${msg.author.tag} (${msg.author.id})\n` +
                    `ワード: "${hit}"\n` +
                    `処罰: ${settings.punishment}`,
            );
        }
    } catch (err) {
        console.error("NGワード処理エラー:", err);
    }
}

async function processNonSpamMessage(msg) {
    const messageContentLower = msg.content.toLowerCase();
    const containsAnyWord = (wordList) =>
        wordList.some((word) =>
            messageContentLower.includes(word.toLowerCase()),
        );
    const guildId = msg.guild?.id;

    if (msg.content === "!ping") {
        msg.reply("Botは応答してるよ!");
    } else if (msg.content.startsWith("!unmute")) {
        if (!msg.member.permissions.has("MANAGE_ROLES")) {
            msg.reply("このコマンドを使用する権限がありません。");
            return;
        }

        const mentionedUser = msg.mentions.users.first();
        if (!mentionedUser) {
            msg.reply(
                "ミュートを解除するユーザーをメンションしてください。\n使用法: `!unmute @ユーザー名`",
            );
            return;
        }

        const member = msg.guild.members.cache.get(mentionedUser.id);
        const muteRole = msg.guild.roles.cache.find(
            (role) => role.name === "Muted_NightGuard",
        );

        if (!member) {
            msg.reply("指定されたユーザーがサーバーに見つかりません。");
            return;
        }

        if (!muteRole) {
            msg.reply("Muted_NightGuardロールが見つかりません。");
            return;
        }

        if (!member.roles.cache.has(muteRole.id)) {
            msg.reply("指定されたユーザーはミュートされていません。");
            return;
        }

        try {
            await member.roles.remove(muteRole);
            msg.reply(`${mentionedUser.username} のミュートを解除しました。`);
        } catch (error) {
            console.error("ミュート解除失敗:", error);
            msg.reply("ミュートの解除に失敗しました。");
        }
    } else if (containsAnyWord(abunai_words)) {
        if (!guildId || !global.insultSettings[guildId]?.enabled) {
            return;
        }

        const member = msg.guild.members.cache.get(msg.author.id);

        if (hasProfanityExclusion(member, msg.guild.id)) {
            return;
        }

        try {
            await msg.reply(
                `危険発言か暴言を検知しました。誠実な会話をしましょう`,
            );
            setTimeout(() => {
                msg.delete().catch((err) =>
                    console.error("元のメッセージの削除に失敗しました:", err),
                );
            }, 100);
        } catch (error) {
            console.error(
                "危険発言を含むメッセージの処理中にエラーが発生しました:",
                error,
            );
        }
    }
}

if (!PORT) {
    console.error("[ERROR] RenderのPORTが定義されていません！");
    process.exit(1);
}

app.get("/", (req, res) => {
    res.send("NightGuardBot Web Server 起動中！");
});

client.on("messageCreate", async (msg) => {
    if (msg.author.bot) return;
    await handleNgWords(msg, false);
});

client.on("messageUpdate", async (oldMsg, newMsg) => {
    if (newMsg.partial || newMsg.author?.bot) return;
    await handleNgWords(newMsg, true);
});

client
    .login(token)
    .then(() => {
        if (!PORT) {
            console.error("[ERROR] RenderのPORTが定義されていません！");
            process.exit(1);
        }

        console.log("[CHECK] app.listen 実行直前");

        app.listen(PORT, () => {
            console.log(`[CHECK] ✅ HTTP server running on port ${PORT}`);
        });
    })
    .catch((error) => {
        console.error("[ERROR] Discordクライアントのログインに失敗:", error);
        process.exit(1);
    });
