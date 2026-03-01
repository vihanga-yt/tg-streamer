import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const apiId = parseInt(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const stringSession = new StringSession(process.env.TELEGRAM_SESSION);

export default async function handler(req, res) {
    const { url } = req.query;

    if (!url) return res.status(400).send("Missing URL");

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
        return res.status(400).send("Invalid URL");
    }

    try {
        const client = new TelegramClient(stringSession, apiId, apiHash, {
            connectionRetries: 1,
            useWSS: false, 
        });
        await client.connect();

        const peer = /^-?\d+$/.test(chat_id) ? BigInt(chat_id) : chat_id;
        const messages = await client.getMessages(peer, { ids: [message_id] });
        
        if (!messages.length || !messages[0].media || !messages[0].media.document) {
            return res.status(404).send("Video not found");
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
        // Vercel crashes if we send > 4.5MB. We strictly limit max chunks to 4MB.
        const maxChunkSize = 4 * 1024 * 1024; 
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        
        // Determine the end byte, but FORCE it to never exceed our 4MB limit
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

        const stream = client.iterDownload({
            file: media,
            offset: start,
            limit: chunkSize,
            requestSize: 1024 * 1024 
        });

        for await (const chunk of stream) {
            res.write(chunk);
        }
        res.end();

    } catch (error) {
        console.error("Streaming error:", error);
        res.status(500).send("Stream error");
    }
}
