import express from "express";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import bigInt from "big-integer";

const app = express();
const PORT = process.env.PORT || 8000; // Koyeb defaults to port 8000

const apiId = parseInt(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const stringSession = new StringSession(process.env.TELEGRAM_SESSION);

// Global Telegram Client
let client;

app.get('/stream', async (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).send("Missing URL parameter");
    }

    let chat_id, message_id;

    // 1. Parse the Telegram URL
    try {
        const parsedUrl = new URL(url);
        const pathParts = parsedUrl.pathname.split('/').filter(Boolean);

        if (pathParts[0] === 'c') {
            chat_id = `-100${pathParts[1]}`;
            message_id = parseInt(pathParts[2], 10);
        } else {
            chat_id = pathParts[0];
            message_id = parseInt(pathParts[1], 10);
        }
    } catch (e) {
        return res.status(400).send("Invalid Telegram URL");
    }

    try {
        // 2. Fetch the message
        const peer = /^-?\d+$/.test(chat_id) ? BigInt(chat_id) : chat_id;
        const messages = await client.getMessages(peer, { ids: [message_id] });
        
        if (!messages.length || !messages[0].media || !messages[0].media.document) {
            return res.status(404).send("Video not found");
        }

        const media = messages[0].media;
        const fileSize = media.document.size;

        // 3. Handle Range Requests (No 4MB limits needed for Koyeb!)
        const range = req.headers.range;
        if (!range) {
            res.writeHead(200, {
                'Accept-Ranges': 'bytes',
                'Content-Length': fileSize,
                'Content-Type': media.document.mimeType || 'video/mp4',
            });
            return res.end();
        }

        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = (end - start) + 1;

        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': media.document.mimeType || 'video/mp4',
        });

        // 4. Stream directly from Telegram to the Browser
        const stream = client.iterDownload({
            file: media,
            offset: bigInt(start),
            limit: chunkSize,
            requestSize: 1024 * 1024 // 1MB chunks from Telegram
        });

        for await (const chunk of stream) {
            // If the user closes the video, stop downloading
            if (res.destroyed) break; 
            res.write(chunk);
        }
        res.end();

    } catch (error) {
        console.error("Streaming error:", error);
        if (!res.headersSent) res.status(500).send("Stream error");
        else res.end();
    }
});

// Boot Sequence: Connect to Telegram FIRST, then start the web server
async function startServer() {
    console.log("Logging into Telegram...");
    client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
    });
    
    await client.connect();
    console.log("✅ Successfully connected to Telegram!");

    app.listen(PORT, () => {
        console.log(`🚀 Streaming server is running on port ${PORT}`);
    });
}

startServer();
