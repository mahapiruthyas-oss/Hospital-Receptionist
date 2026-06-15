const express = require('express');
const router = express.Router();
const axios = require('axios');
const WebSocket = require('ws');
const FormData = require('form-data');
const { Readable } = require('stream');

// Finalized Decoder: Clamps values to strictly valid 16-bit range
function mulawToPcm(buffer) {
  const pcm = Buffer.alloc(buffer.length * 2);
  for (let i = 0; i < buffer.length; i++) {
    let u = buffer[i] ^ 0xff;
    let s = (u & 0x0f) << 4;
    let e = (u & 0x70) >> 4;
    let b = (s + 0x84) << e;
    let v = (u & 0x80) ? (0x84 - b) : (b - 0x84);

    // Strict clamping prevents the "out of range" error and clipping noise
    const clampedV = Math.max(-32768, Math.min(32767, v));
    pcm.writeInt16LE(clampedV, i * 2);
  }
  return pcm;
}

async function transcribeAudio(mulawBuffer) {
  const pcmBuffer = mulawToPcm(mulawBuffer);
  const formData = new FormData();
  formData.append('file', Readable.from(pcmBuffer), {
    filename: 'audio.pcm',
    contentType: 'audio/pcm_s16le'
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

// FAQ Interceptor — zero LLM cost
const FAQS = [
  { keywords: ['நேரம்', 'time', 'timing', 'open', 'திற'], answer: 'OPD நேரம் காலை 8 மணி முதல் மதியம் 1 மணி வரை, மாலை 4 மணி முதல் இரவு 8 மணி வரை.' },
  { keywords: ['கட்டணம்', 'fee', 'fees', 'charge', 'cost', 'விலை', 'பணம்'], answer: 'Consultation fee ₹300 மட்டுமே.' },
  { keywords: ['எங்கே', 'where', 'location', 'address', 'வழி'], answer: 'நாங்கள் Anna Nagar, Chennai-வில் இருக்கிறோம். அருகில் உள்ள bus stop Anna Nagar Tower.' },
  { keywords: ['emergency', 'urgent', 'அவசரம்'], answer: 'Emergency: 044-12345678. 24 மணி நேரமும் கிடைக்கும்.' },
  { keywords: ['ஞாயிறு', 'sunday', 'holiday', 'விடுமுறை'], answer: 'ஞாயிற்றுக்கிழமை OPD இல்லை. திங்கள் முதல் சனி வரை மட்டுமே.' },
  { keywords: ['doctor', 'டாக்டர்', 'யார்'], answer: 'எங்களிடம் Dr. Kumar (Cardiology), Dr. Priya (General Medicine), Dr. Rajan (Orthopedic) உள்ளனர்.' },
  { keywords: ['parking', 'பார்க்கிங்'], answer: 'மருத்துவமனை முன்பே free parking கிடைக்கும்.' },
];

function checkFAQ(text) {
  const lower = text.toLowerCase();
  for (const faq of FAQS) {
    for (const keyword of faq.keywords) {
      if (lower.includes(keyword.toLowerCase())) {
        return faq.answer;
      }
    }
  }
  return null;
}

// System prompt for the booking LLM, rebuilt each turn with current state
function buildSystemPrompt(session) {
  return `நீங்கள் ஸ்ரீ லட்சுமி மருத்துவமனையின் (Sri Lakshmi Hospital) AI வரவேற்பு உதவியாளர்.

கிடைக்கும் டாக்டர்கள்: "Dr. Kumar" (Cardiology), "Dr. Priya" (General Medicine), "Dr. Rajan" (Orthopedic).
OPD நேரம்: காலை 8-1 மணி, மாலை 4-8 மணி. ஞாயிறு விடுமுறை. Consultation fee ₹300.

உங்கள் வேலை appointment booking மட்டும். நோயாளியிடம் பெயர், மொபைல் நம்பர், எந்த டாக்டரிடம் appointment வேண்டும் என்பதை மட்டும் கேட்டு சேகரிக்கவும். ஒரு நேரத்தில் ஒரே ஒரு கேள்வி மட்டும் கேளுங்கள்.

இப்போது வரை சேகரிக்கப்பட்டது: ${JSON.stringify(session.collected)}

உங்கள் பதில் STRICT JSON ஆக மட்டும் இருக்க வேண்டும், வேறு எந்த உரையும், markdown backticks-ம் சேர்க்க வேண்டாம்:
{"extracted": {"name": null அல்லது "string", "mobile": null அல்லது "string", "doctor": null அல்லது "Dr. Kumar" அல்லது "Dr. Priya" அல்லது "Dr. Rajan"}, "reply": "தமிழில் சுருக்கமான பதில்", "complete": true அல்லது false}

name, mobile, doctor மூன்றும் கிடைத்தவுடன் complete:true ஆக்கி, appointment confirm செய்த பதிலை reply-ல் கொடுங்கள்.`;
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
    let framesReceived = 0;
    let streamSid = null;

    // Per-call booking state — lives for the lifetime of this WS connection
    let session = {
      collected: { name: null, mobile: null, doctor: null },
      conversationHistory: []
    };

    ws.on('message', async (message) => {
      const data = JSON.parse(message);

      if (data.event === 'start') {
        streamSid = data.start.streamSid;
        console.log('Call started, streamSid:', streamSid);
        await sendTTSResponse(ws, 'வணக்கம்! இது ஸ்ரீ லட்சுமி மருத்துவமனை. நான் உங்களுக்கு எப்படி உதவ முடியும்?', streamSid);
        return;
      }

      if (data.event === 'media') {
        // Ignore the first 20 frames to eliminate initialization "bang"
        if (framesReceived < 20) { framesReceived++; return; }

        if (!isProcessing) {
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

              if (transcript && transcript.trim()) {
                // FAQ check first — zero LLM cost
                const faqAnswer = checkFAQ(transcript);
                if (faqAnswer) {
                  await sendTTSResponse(ws, faqAnswer, streamSid);
                } else {
                  session.conversationHistory.push({ role: 'user', content: transcript });

                  const llmRes = await axios.post('https://api.sarvam.ai/v1/chat/completions', {
                    model: 'sarvam-m',
                    messages: [
                      { role: 'system', content: buildSystemPrompt(session) },
                      ...session.conversationHistory
                    ],
                    max_tokens: 300
                  }, {
                    headers: {
                      'api-subscription-key': process.env.SARVAM_API_KEY,
                      'Content-Type': 'application/json'
                    }
                  });

                  let raw = llmRes.data.choices?.[0]?.message?.content || '{}';
                  raw = raw.replace(/```json|```/g, '').trim();

                  let parsed;
                  try {
                    parsed = JSON.parse(raw);
                  } catch (e) {
                    console.error('LLM JSON parse failed, raw was:', raw);
                    parsed = { extracted: {}, reply: 'மன்னிக்கவும், மீண்டும் சொல்ல முடியுமா?', complete: false };
                  }

                  const extracted = parsed.extracted || {};
                  if (extracted.name) session.collected.name = extracted.name;
                  if (extracted.mobile) session.collected.mobile = extracted.mobile;
                  if (extracted.doctor) session.collected.doctor = extracted.doctor;

                  session.conversationHistory.push({ role: 'assistant', content: parsed.reply || '' });
                  if (session.conversationHistory.length > 10) {
                    session.conversationHistory = session.conversationHistory.slice(-10);
                  }

                  await sendTTSResponse(ws, parsed.reply || 'மன்னிக்கவும், மீண்டும் சொல்லுங்கள்.', streamSid);

                  if (parsed.complete) {
                    console.log('✅ Booking complete:', session.collected);
                    // TODO: save to MongoDB once Patient model is wired back into this file
                  }
                }
              }
            } catch (err) {
              console.error('Processing error:', err.response?.data || err.message);
            }

            isProcessing = false;
          }, 500);
        }
      }

      if (data.event === 'stop') {
        console.log('Call ended');
        clearTimeout(silenceTimer);
      }
    });

    ws.on('close', () => console.log('Stream disconnected'));
  });

  return wss;
}

async function sendTTSResponse(ws, text, streamSid) {
  try {
    console.log('🎤 TTS Text:', text.substring(0, 80));

    const response = await axios.post('https://api.sarvam.ai/text-to-speech', {
      inputs: [text],
      target_language_code: 'ta-IN',
      speaker: 'anushka',
      model: 'bulbul:v2',
      encoding: 'MULAW',
      sample_rate: 8000
    }, {
      headers: {
        'api-subscription-key': process.env.SARVAM_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    const audioBase64 = response.data.audios?.[0];
    if (!audioBase64) {
      console.error('❌ TTS returned no audio. Full response:', JSON.stringify(response.data));
      return;
    }

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: audioBase64 } }));
      console.log('✅ TTS audio sent, streamSid:', streamSid);
    } else {
      console.error('❌ TTS not sent — WebSocket not open. readyState:', ws.readyState);
    }
  } catch (err) {
    console.error('❌ TTS API Error:', err.response?.data || err.message);
  }
}

module.exports = { router, setupMediaStream };
