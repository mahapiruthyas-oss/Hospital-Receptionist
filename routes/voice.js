const express = require('express');
const router = express.Router();
const axios = require('axios');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const FormData = require('form-data');
const { Readable } = require('stream');

// Helper: Convert Telephony mu-law (8kHz) to Linear PCM (16-bit)
function mulawToPcm(buffer) {
    const pcm = Buffer.alloc(buffer.length * 2);
    for (let i = 0; i < buffer.length; i++) {
        let u = buffer[i] ^ 0xff;
        let s = (u & 0x0f) << 4;
        let e = (u & 0x70) >> 4;
        let b = (s + 0x84) << e;
        let v = (u & 0x80) ? (0x84 - b) : (b - 0x84);
        pcm.writeInt16LE(v, i * 2);
    }
    return pcm;
}

// Fixed STT: Using official multipart pattern
async function transcribeAudio(mulawBuffer) {
    const pcmBuffer = mulawToPcm(mulawBuffer);
    const formData = new FormData();
    
    // Convert buffer to readable stream for robust API streaming
    const audioStream = Readable.from(pcmBuffer);
    
    formData.append('file', audioStream, { 
        filename: 'audio.pcm', 
        contentType: 'audio/pcm' 
    });
    formData.append('model', 'saaras:v3');
    formData.append('language_code', 'ta-IN');
    formData.append('mode', 'transcribe');
    formData.append('input_audio_codec', 'pcm_s16le');
    
    const res = await axios.post('https://api.sarvam.ai/speech-to-text', formData, {
        headers: { 
            'api-subscription-key': process.env.SARVAM_API_KEY, 
            ...formData.getHeaders() 
        }
    });
    return res.data.transcript || '';
}

router.post('/', (req, res) => {
    const host = req.headers.host;
    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://${host}/voice/stream" /></Connect></Response>`);
});

function setupMediaStream(server) {
    const wss = new WebSocket.Server({ server, path: '/voice/stream' });
    wss.on('connection', (ws) => {
        let audioChunks = [];
        let silenceTimer = null;
        let isProcessing = false;

        ws.on('message', async (message) => {
            const data = JSON.parse(message);
            if (data.event === 'start') {
                await sendTTSResponse(ws, 'வணக்கம்! இது ஸ்ரீ லட்சுமி மருத்துவமனை.', data.start.streamSid);
                return;
            }
            if (data.event === 'media' && !isProcessing) {
                audioChunks.push(Buffer.from(data.media.payload, 'base64'));
                clearTimeout(silenceTimer);
                silenceTimer = setTimeout(async () => {
                    if (audioChunks.length < 10) { audioChunks = []; return; }
                    isProcessing = true;
                    const mulawBuffer = Buffer.concat(audioChunks);
                    audioChunks = [];
                    try {
                        const transcript = await transcribeAudio(mulawBuffer);
                        if (transcript) console.log('Transcript:', transcript);
                    } catch (err) { console.error('STT API Error:', err.message); }
                    isProcessing = false;
                }, 500);
            }
        });
    });
    return wss;
}

async function sendTTSResponse(ws, text, streamSid) {
    try {
        const response = await axios.post('https://api.sarvam.ai/text-to-speech', {
            inputs: [text], target_language_code: 'ta-IN', speaker: 'anushka', model: 'bulbul:v2', encoding: 'MULAW', sample_rate: 8000
        }, { headers: { 'api-subscription-key': process.env.SARVAM_API_KEY, 'Content-Type': 'application/json' } });
        
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: response.data.audios[0] } }));
        }
    } catch (err) { console.error('TTS API Error:', err.message); }
}

module.exports = { router, setupMediaStream };
