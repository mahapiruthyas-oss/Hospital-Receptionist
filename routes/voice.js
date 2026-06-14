const express = require('express');
const router = express.Router();
const axios = require('axios');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { SarvamAIClient } = require("sarvamai");

let Patient;
const callSessions = {};

const sarvamClient = new SarvamAIClient({ apiSubscriptionKey: process.env.SARVAM_API_KEY });

router.post('/', (req, res) => {
  const callSid = (req.body && req.body.CallSid) || (req.body && req.body.callSid) || 'unknown';
  console.log('✅ Incoming call - CallSid:', callSid);

  callSessions[callSid] = { 
    hospitalId: 'H001', 
    collected: { name: null, mobile: null, doctor: null }, 
    conversationHistory: [], 
    step: 'greeting' 
  };

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
                const streamSid = data.start.streamSid;
                await sendTTSResponse(ws, 'வணக்கம்! இது ஸ்ரீ லட்சுமி மருத்துவமனை.', streamSid);
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
                    } catch (error) { console.error('FULL ERROR', error); }
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
            ws.send(JSON.stringify({ 
                event: 'media', 
                streamSid, 
                media: { payload: ttsResponse.data.audios[0] } 
            }));
        }
    } catch (error) { 
        console.error('❌ TTS error:', error.message); 
    }
}

module.exports = { router, setupMediaStream };
