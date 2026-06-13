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

router.post('/', (req, res) => { /* ... as before ... */ });

function setupMediaStream(server) {
  Patient = mongoose.model('Patient');
  const wss = new WebSocket.Server({ server, path: '/voice/stream' });
  
  // Initialize Sarvam Client
  const sarvamClient = new SarvamAIClient({
    apiSubscriptionKey: process.env.SARVAM_API_KEY
  });

  wss.on('connection', (ws) => {
    let callSid = null;
    let streamSid = null;
    let audioBuffer = [];
    let silenceTimer = null;
    let isProcessing = false;

    ws.on('message', async (message) => {
      const data = JSON.parse(message);

      if (data.event === 'start') {
        callSid = data.start.callSid;
        streamSid = data.start.streamSid;
        await sendTTSResponse(ws, 'வணக்கம்! இது ஸ்ரீ லட்சுமி மருத்துவமனை.', streamSid);
      }

      if (data.event === 'media' && !isProcessing) {
        audioBuffer.push(data.media.payload);
        clearTimeout(silenceTimer);
        
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
            console.log('=== STT START (SDK) ===');
            
            // Writing buffer to temp file as SDK expects a stream or file
            const tempAudio = path.join('/tmp', `input_${Date.now()}.wav`);
            fs.writeFileSync(tempAudio, audioData);
            const audioReadStream = fs.createReadStream(tempAudio);

            const sttResponse = await sarvamClient.speechToText.transcribe({
              file: audioReadStream,
              model: "saaras:v3",
              mode: "transcribe"
            });

            console.log('=== STT DONE ===', sttResponse);
            const patientText = sttResponse.transcript || '';
            fs.unlinkSync(tempAudio); // Cleanup

            // ... LLM logic remains same ...
            // [Ensure you use 'streamSid' for sendTTSResponse here]

          } catch (error) {
            console.error('FULL ERROR', error);
          }
          isProcessing = false;
        }, 500);
      }
    });
  });
  return wss;
}

// [sendTTSResponse and other helpers remain same...]
module.exports = { router, setupMediaStream };