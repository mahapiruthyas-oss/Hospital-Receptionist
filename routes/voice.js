const express = require('express');
const router = express.Router();
const axios = require('axios');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const FormData = require('form-data');

let Patient;
const callSessions = {};

// Decoder: mu-law to PCM
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

// Fixed STT: Uses correct multipart boundaries
async function transcribeAudio(mulawBuffer) {
    const pcmBuffer = mulawToPcm(mulawBuffer);
    const formData = new FormData();
    
    formData.append('file', pcmBuffer, { filename: 'audio.pcm', contentType: 'audio/pcm' });
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
    const callSid = (req.body && req.body.CallSid) || (req.body && req.body.callSid) || 'unknown';
    callSessions[callSid] = { hospitalId: 'H001', collected: { name: null, mobile: null, doctor: null }, conversationHistory: [], step: 'greeting' };
    const host = req.headers.host;
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/voice/stream" />
  </Connect>
</Response>`;
    res.type('text/xml');
    res.send(twiml);
});

function setupMediaStream(server, io) {
    Patient = mongoose.model('Patient');
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
                        const patientText = await transcribeAudio(mulawBuffer);
                        console.log('Patient said:', patientText);
                    } catch (error) { console.error('STT Error:', error.message); }
                    isProcessing = false;
                }, 500);
            }
        });
    });
    return wss;
}

async function sendTTSResponse(ws, text, streamSid) {
    try {
        const ttsResponse = await axios.post('https://api.sarvam.ai/text-to-speech', {
            inputs: [text], 
            target_language_code: 'ta-IN', 
            speaker: 'anushka', 
            model: 'bulbul:v2', 
            encoding: 'MULAW', 
            sample_rate: 8000
        }, { 
            headers: { 'api-subscription-key': process.env.SARVAM_API_KEY, 'Content-Type': 'application/json' } 
        });
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: ttsResponse.data.audios[0] } }));
        }
    } catch (error) { console.error('TTS error:', error.message); }
}

module.exports = { router, setupMediaStream };
