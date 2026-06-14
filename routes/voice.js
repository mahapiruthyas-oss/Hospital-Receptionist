const express = require('express');
const router = express.Router();
const axios = require('axios');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { SarvamAIClient } = require("sarvamai"); // Added SDK

let Patient;

const callSessions = {};

// [FAQ Section remains unchanged...]
const FAQS = [ /* ... as before ... */ ];
function checkFAQ(text) { /* ... as before ... */ }

// Initialize the client once at the top of your file (outside this function)
const sarvamClient = new SarvamAIClient({ apiSubscriptionKey: process.env.SARVAM_API_KEY });

router.post('/', (req, res) => {
  const callSid = req.body.CallSid || req.body.callSid || 'unknown';
  console.log('✅ Incoming call - CallSid:', callSid);

  // Initialize session immediately
  callSessions[callSid] = { 
    hospitalId: 'H001', 
    collected: { name: null, mobile: null, doctor: null }, 
    conversationHistory: [], 
    step: 'greeting' 
  };

  const host = req.headers.host;
  
  // Respond IMMEDIATELY with TwiML
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
    let callSid = null;
    let streamSid = null;
    let audioChunks = [];
    let silenceTimer = null;
    let isProcessing = false;

    ws.on('message', async (message) => {
      const data = JSON.parse(message);

      if (data.event === 'start') {
        callSid = data.start.callSid;
        streamSid = data.start.streamSid;
        console.log('Call started:', callSid);
        await sendTTSResponse(ws, 'வணக்கம்! இது ஸ்ரீ லட்சுமி மருத்துவமனை.', streamSid);
        return;
      }
        
        silenceTimer = setTimeout(async () => {
          if (audioBuffer.length < 5) { audioBuffer = []; return; }
          isProcessing = true;
          
          const audioData = Buffer.from(audioBuffer.join(''), 'base64'); // Prepare Buffer for SDK
          audioBuffer = [];

          try {
            console.log('Looking for session:', callSid);
            const session = callSessions[callSid];
            
            if (!session) {
              console.log('SESSION MISSING');
              isProcessing = false;
              return;
            }

            // STT using Official Sarvam SDK
           // Perform STT using the corrected decoder function
console.log('=== STT START (Decoded PCM) ===');
const patientText = await transcribeAudio(mulawBuffer);
console.log('Patient said:', patientText);

            // ... LLM logic remains same ...
            // [Ensure you use 'streamSid' for sendTTSResponse here]

          } catch (error) {
            console.error('FULL ERROR', error);
          }
          isProcessing = false;
   }, 500);
}, 500); 
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
            console.log('✅ TTS audio sent');
        }
    } catch (error) { 
        console.error('❌ TTS error:', error.message); 
    }
}
// [sendTTSResponse and other helpers remain same...]
module.exports = { router, setupMediaStream };
