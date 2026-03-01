import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import bigInt from "big-integer"; // <-- FIX 1: Imported big-integer

const apiId = parseInt(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const stringSession = new StringSession(process.env.TELEGRAM_SESSION);

export default async function handler(req, res) {
    const { url } = req.query;

    if (!url) {
        if (!res.headersSent) return res.status(400).send("Missing URL");
        return;
    }

    let chat_id, message_id;

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
        if (!res.headersSent) return res.status(400).send("Invalid URL");
        return;
    }

    try {
        const client = new TelegramClient(stringSession, apiId, apiHash, {
            connectionRetries: 1,
            useWSS: false, 
        });
        await client.connect();

        // Convert large private chat IDs to native BigInt so Telegram finds the chat
        const peer = /^-?\d+$/.test(chat_id) ? BigInt(chat_id) : chat_id;
        const messages = await client.getMessages(peer, { ids: [message_id] });
        
        if (!messages.length || !messages[0].media || !messages[0].media.document) {
            if (!res.headersSent) return res.status(404).send("Video not found");
            return;
        }

        const media = messages[0].media;
        const fileSize = media.document.size;

        const range = req.headers.range;
        if (!range) {
            res.writeHead(200, {
                'Accept-Ranges': 'bytes',
                'Content-Length': fileSize,
                'Content-Type': media.document.mimeType || 'video/mp4',
            });
            return res.end();
        }

        // --- THE 4MB HACK ---
        const maxChunkSize = 4 * 1024 * 1024; 
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        
        let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        if (end - start + 1 > maxChunkSize) {
            end = start + maxChunkSize - 1;
        }
        
        const chunkSize = (end - start) + 1;

        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': media.document.mimeType || 'video/mp4',
        });

        // Tell Telegram to download ONLY that specific byte range
        const stream = client.iterDownload({
            file: media,
            offset: bigInt(start), // <-- FIX 2: Wrapped the start byte in bigInt()
            limit: chunkSize,
            requestSize: 1024 * 1024 
        });

        for await (const chunk of stream) {
            res.write(chunk);
        }
        res.end();

    } catch (error) {
        console.error("Streaming error:", error);
        
        // <-- FIX 3: Prevent the header crash
        if (!res.headersSent) {
            res.status(500).send("Stream error");
        } else {
            res.end(); // If it crashes mid-stream, just end the connection gracefully
        }
    }
}
