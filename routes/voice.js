const express = require('express');
const router = express.Router();
const axios = require('axios');
const WebSocket = require('ws');
const mongoose = require('mongoose');

let Patient;

// Active call sessions
const callSessions = {};

// FAQ Interceptor — zero LLM cost for these
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

// STEP 1: Patient calls — start Media Stream
router.post('/', (req, res) => {
  const callSid = req.body.CallSid;

  callSessions[callSid] = {
    hospitalId: 'H001',
    collected: { name: null, mobile: null, doctor: null },
    conversationHistory: [],
    step: 'greeting'
  };

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/voice/stream" />
  </Connect>
</Response>`;

  res.type('text/xml');
  res.send(twiml);
});

// STEP 2: Handle Media Stream WebSocket
function setupMediaStream(server) {
  Patient = mongoose.model('Patient');
  const wss = new WebSocket.Server({ server, path: '/voice/stream' });
  wss.on('connection', (ws) => {
    let callSid = null;
    let audioBuffer = [];
    let silenceTimer = null;
    let isProcessing = false;

    console.log('Media stream connected');

    ws.on('message', async (message) => {
      const data = JSON.parse(message);

      if (data.event === 'start') {
        callSid = data.start.callSid;
        console.log('Call started:', callSid);

        // Send greeting
        await sendTTSResponse(
          ws,
          'வணக்கம்! இது ஸ்ரீ லட்சுமி மருத்துவமனை. நான் உங்களுக்கு எப்படி உதவ முடியும்?',
          data.start.streamSid
        );
      }

      if (data.event === 'media' && !isProcessing) {
        // Collect audio chunks
        audioBuffer.push(data.media.payload);

        // Reset silence timer
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(async () => {
          if (audioBuffer.length < 5) {
            audioBuffer = [];
            return;
          }

          isProcessing = true;
          const audioData = audioBuffer.join('');
          audioBuffer = [];

          try {
            const session = callSessions[callSid];
            if (!session) return;

            // Send to Sarvam STT
            const sttResponse = await axios.post(
              'https://api.sarvam.ai/speech-to-text',
              {
                model: 'saaras:v2',
                language_code: 'ta-IN',
                audio: audioData,
                encoding: 'MULAW',
                sample_rate: 8000
              },
              {
                headers: {
                  'api-subscription-key': process.env.SARVAM_API_KEY,
                  'Content-Type': 'application/json'
                }
              }
            );

            const patientText = sttResponse.data.transcript || '';
            console.log('Patient said:', patientText);

            if (!patientText.trim()) {
              isProcessing = false;
              return;
            }

            // Check FAQ first — zero LLM cost
            const faqAnswer = checkFAQ(patientText);
            if (faqAnswer) {
              console.log('FAQ match — skipping LLM');
              await sendTTSResponse(ws, faqAnswer, data.media.streamSid);
              isProcessing = false;
              return;
            }

            // Not FAQ — use Sarvam LLM
            session.conversationHistory.push({
              role: 'user',
              content: patientText
            });

            const llmResponse = await axios.post(
              'https://api.sarvam.ai/v1/chat/completions',
              {
                model: 'sarvam-m',
                messages: [
                  {
                    role: 'system',
                    content: `நீங்கள் ஸ்ரீ லட்சுமி மருத்துவமனையின் AI வரவேற்பாளர்.
தமிழில் மட்டுமே பேசுங்கள். குறுகிய பதில்கள் மட்டும் (2 வாக்கியம் max).
Appointment பதிவுக்கு: பெயர், mobile number, doctor தேவை.

தற்போது சேகரித்தது:
பெயர்: ${session.collected.name || 'இல்லை'}
Mobile: ${session.collected.mobile || 'இல்லை'}  
Doctor: ${session.collected.doctor || 'இல்லை'}

Available doctors: Dr. Kumar (Cardiology), Dr. Priya (General Medicine), Dr. Rajan (Orthopedic)

JSON மட்டும் பதில் தாருங்கள்:
{
  "extracted": {"name": null, "mobile": null, "doctor": null},
  "reply": "next Tamil question",
  "complete": false
}`
                  },
                  ...session.conversationHistory
                ],
                max_tokens: 200
              },
              {
                headers: {
                  'Authorization': `Bearer ${process.env.SARVAM_API_KEY}`,
                  'Content-Type': 'application/json'
                }
              }
            );

            const llmText = llmResponse.data.choices[0].message.content;
            let parsed;
            try {
              const jsonMatch = llmText.match(/\{[\s\S]*\}/);
              parsed = JSON.parse(jsonMatch[0]);
            } catch (e) {
              parsed = {
                extracted: {},
                reply: 'மன்னிக்கவும், மீண்டும் சொல்லுங்கள்.',
                complete: false
              };
            }

            // Update session
            if (parsed.extracted?.name) session.collected.name = parsed.extracted.name;
            if (parsed.extracted?.mobile) session.collected.mobile = parsed.extracted.mobile;
            if (parsed.extracted?.doctor) session.collected.doctor = parsed.extracted.doctor;

            session.conversationHistory.push({
              role: 'assistant',
              content: parsed.reply
            });

            // Save booking if complete
            if (parsed.complete && session.collected.name && session.collected.doctor) {
              const count = await Patient.countDocuments({ hospitalId: session.hospitalId });
              const patient = new Patient({
                hospitalId: session.hospitalId,
                name: session.collected.name,
                mobile: session.collected.mobile || 'Not provided',
                doctor: session.collected.doctor,
                tokenNumber: count + 1
              });
              await patient.save();
              console.log('Booking saved:', patient.name);
              delete callSessions[callSid];
            }

            await sendTTSResponse(ws, parsed.reply, data.media.streamSid);

          } catch (error) {
            console.error('Processing error:', error.message);
            await sendTTSResponse(
              ws,
              'மன்னிக்கவும், தொழில்நுட்ப சிக்கல். சிறிது நேரம் கழித்து அழைக்கவும்.',
              data.media.streamSid
            );
          }

          isProcessing = false;
        }, 1500); // 1.5 sec silence = patient finished speaking
      }

      if (data.event === 'stop') {
        console.log('Call ended:', callSid);
        clearTimeout(silenceTimer);
        if (callSid) delete callSessions[callSid];
      }
    });

    ws.on('close', () => {
      console.log('Stream disconnected');
      clearTimeout(silenceTimer);
    });
  });

  return wss;
}

// Send TTS via Sarvam Bulbul
async function sendTTSResponse(ws, text, streamSid) {
  try {
    const ttsResponse = await axios.post(
      'https://api.sarvam.ai/text-to-speech',
      {
        inputs: [text],
        target_language_code: 'ta-IN',
        speaker: 'anushka',
        model: 'bulbul:v1',
        encoding: 'LINEAR16',
        sample_rate: 8000
      },
      {
        headers: {
          'api-subscription-key': process.env.SARVAM_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    const audioBase64 = ttsResponse.data.audios[0];

    // Send audio to Twilio stream
    const mediaMessage = {
      event: 'media',
      streamSid: streamSid,
      media: {
        payload: audioBase64
      }
    };

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(mediaMessage));
    }

  } catch (error) {
    console.error('TTS error:', error.message);
  }
}

module.exports = { router, setupMediaStream };