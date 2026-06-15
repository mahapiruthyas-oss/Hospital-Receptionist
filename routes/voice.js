const express = require('express');
const router = express.Router();
const axios = require('axios');
const WebSocket = require('ws');
const FormData = require('form-data');

const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
const TWILIO_SAMPLE_RATE = 8000;
const SARVAM_STT_SAMPLE_RATE = 16000;
const TWILIO_FRAME_MS = 20;
const FRAMES_PER_STT_CHUNK = 150; // About 3 seconds of caller audio.
const MIN_FRAMES_FOR_STT = 45; // About 900 ms; skips tiny noises.

function getSarvamHeaders() {
  return { 'api-subscription-key': SARVAM_API_KEY };
}

function assertSarvamKey() {
  if (!SARVAM_API_KEY) {
    throw new Error('SARVAM_API_KEY is not set');
  }
}

function mulawToPcm16(buffer) {
  const pcm = Buffer.alloc(buffer.length * 2);

  for (let i = 0; i < buffer.length; i += 1) {
    const uLaw = ~buffer[i] & 0xff;
    const sign = uLaw & 0x80;
    const exponent = (uLaw >> 4) & 0x07;
    const mantissa = uLaw & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;

    if (sign) sample = -sample;
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }

  return pcm;
}

function calculateRmsPcm16Le(pcm) {
  if (!pcm.length) return 0;

  let sumSquares = 0;
  const samples = pcm.length / 2;

  for (let i = 0; i < pcm.length; i += 2) {
    const sample = pcm.readInt16LE(i);
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / samples);
}

function upsamplePcm16LeBy2(pcm8k) {
  const pcm16k = Buffer.alloc(pcm8k.length * 2);
  const sampleCount = pcm8k.length / 2;

  for (let i = 0; i < sampleCount; i += 1) {
    const current = pcm8k.readInt16LE(i * 2);
    const next = i + 1 < sampleCount ? pcm8k.readInt16LE((i + 1) * 2) : current;
    const midpoint = Math.round((current + next) / 2);
    const outputOffset = i * 4;

    pcm16k.writeInt16LE(current, outputOffset);
    pcm16k.writeInt16LE(midpoint, outputOffset + 2);
  }

  return pcm16k;
}

function pcm16LeToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

async function transcribeAudio(mulawBuffer) {
  assertSarvamKey();

  const pcm8k = mulawToPcm16(mulawBuffer);
  const rms = calculateRmsPcm16Le(pcm8k);

  console.log('Sending caller audio to Sarvam STT:', {
    bytes: mulawBuffer.length,
    seconds: Number((mulawBuffer.length / TWILIO_SAMPLE_RATE).toFixed(2)),
    rms: Math.round(rms)
  });

  if (rms < 120) {
    console.log('Skipping STT chunk because it looks like silence. RMS:', Math.round(rms));
    return '';
  }

  const pcm16k = upsamplePcm16LeBy2(pcm8k);
  const wavBuffer = pcm16LeToWav(pcm16k, SARVAM_STT_SAMPLE_RATE);

  const formData = new FormData();
  formData.append('file', wavBuffer, {
    filename: 'twilio-audio.wav',
    contentType: 'audio/wav'
  });
  formData.append('model', 'saaras:v3');
  formData.append('language_code', 'ta-IN');
  formData.append('mode', 'transcribe');

  const res = await axios.post('https://api.sarvam.ai/speech-to-text', formData, {
    headers: {
      ...getSarvamHeaders(),
      ...formData.getHeaders()
    },
    maxBodyLength: Infinity
  });

  return res.data.transcript || '';
}

const FAQS = [
  { keywords: ['நேரம்', 'time', 'timing', 'open', 'திற'], answer: 'OPD நேரம் காலை 8 மணி முதல் மதியம் 1 மணி வரை, மாலை 4 மணி முதல் இரவு 8 மணி வரை.' },
  { keywords: ['கட்டணம்', 'fee', 'fees', 'charge', 'cost', 'விலை', 'பணம்'], answer: 'Consultation fee ரூபாய் 300 மட்டும்.' },
  { keywords: ['எங்கே', 'where', 'location', 'address', 'வழி'], answer: 'நாங்கள் Anna Nagar, Chennai-வில் இருக்கிறோம். அருகில் உள்ள bus stop Anna Nagar Tower.' },
  { keywords: ['emergency', 'urgent', 'அவசரம்'], answer: 'Emergency: 044-12345678. 24 மணி நேரமும் கிடைக்கும்.' },
  { keywords: ['ஞாயிறு', 'sunday', 'holiday', 'விடுமுறை'], answer: 'ஞாயிற்றுக்கிழமை OPD இல்லை. திங்கள் முதல் சனி வரை மட்டும்.' },
  { keywords: ['doctor', 'டாக்டர்', 'யார்'], answer: 'எங்களிடம் Dr. Kumar Cardiology, Dr. Priya General Medicine, Dr. Rajan Orthopedic உள்ளனர்.' },
  { keywords: ['parking', 'பார்க்கிங்'], answer: 'மருத்துவமனை முன்பே free parking கிடைக்கும்.' }
];

function checkFAQ(text) {
  const lower = text.toLowerCase();

  for (const faq of FAQS) {
    if (faq.keywords.some((keyword) => lower.includes(keyword.toLowerCase()))) {
      return faq.answer;
    }
  }

  return null;
}

function buildSystemPrompt(session) {
  return `நீங்கள் ஸ்ரீ லட்சுமி மருத்துவமனையின் (Sri Lakshmi Hospital) AI வரவேற்பு உதவியாளர்.

கிடைக்கும் டாக்டர்கள்: "Dr. Kumar" (Cardiology), "Dr. Priya" (General Medicine), "Dr. Rajan" (Orthopedic).
OPD நேரம்: காலை 8-1 மணி, மாலை 4-8 மணி. ஞாயிறு விடுமுறை. Consultation fee ரூபாய் 300.

உங்கள் வேலை appointment booking மட்டும். நோயாளியிடம் பெயர், மொபைல் நம்பர், எந்த டாக்டரிடம் appointment வேண்டும் என்பதை மட்டும் கேட்டு சேகரிக்கவும். ஒரு நேரத்தில் ஒரே ஒரு கேள்வி மட்டும் கேளுங்கள்.

இப்போது வரை சேகரிக்கப்பட்டது: ${JSON.stringify(session.collected)}

உங்கள் பதில் STRICT JSON ஆக மட்டும் இருக்க வேண்டும், markdown backticks சேர்க்க வேண்டாம்:
{"extracted":{"name":null அல்லது "string","mobile":null அல்லது "string","doctor":null அல்லது "Dr. Kumar" அல்லது "Dr. Priya" அல்லது "Dr. Rajan"},"reply":"தமிழில் சுருக்கமான பதில்","complete":true அல்லது false}

name, mobile, doctor மூன்றும் கிடைத்தவுடன் complete:true ஆக்கி, appointment confirm செய்த பதிலை reply-ல் கொடுங்கள்.`;
}

async function getAssistantReply(session, transcript) {
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
      ...getSarvamHeaders(),
      'Content-Type': 'application/json'
    }
  });

  let raw = llmRes.data.choices?.[0]?.message?.content || '{}';
  raw = raw.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('LLM JSON parse failed, raw was:', raw);
    return {
      extracted: {},
      reply: 'மன்னிக்கவும், மீண்டும் சொல்ல முடியுமா?',
      complete: false
    };
  }
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
    let isProcessing = false;
    let streamSid = null;
    let inboundFrameCount = 0;
    let skippedOpeningFrames = 0;
    let isBotSpeaking = false;

    const session = {
      collected: { name: null, mobile: null, doctor: null },
      conversationHistory: []
    };

    async function processCallerAudio(reason) {
      if (isProcessing || audioChunks.length < MIN_FRAMES_FOR_STT) return;

      isProcessing = true;
      const chunksToProcess = audioChunks;
      audioChunks = [];

      console.log(`Processing caller audio because ${reason}:`, {
        frames: chunksToProcess.length,
        approxSeconds: Number(((chunksToProcess.length * TWILIO_FRAME_MS) / 1000).toFixed(2))
      });

      try {
        const mulawBuffer = Buffer.concat(chunksToProcess);
        const transcript = await transcribeAudio(mulawBuffer);
        const cleanedTranscript = transcript.trim();

        if (!cleanedTranscript) {
          console.log('Sarvam STT returned empty transcript.');
          return;
        }

        console.log('Transcript:', cleanedTranscript);

        const faqAnswer = checkFAQ(cleanedTranscript);
        if (faqAnswer) {
          await sendTTSResponse(ws, faqAnswer, streamSid, () => {
            isBotSpeaking = true;
          });
          return;
        }

        const parsed = await getAssistantReply(session, cleanedTranscript);
        const extracted = parsed.extracted || {};

        if (extracted.name) session.collected.name = extracted.name;
        if (extracted.mobile) session.collected.mobile = extracted.mobile;
        if (extracted.doctor) session.collected.doctor = extracted.doctor;

        session.conversationHistory.push({ role: 'assistant', content: parsed.reply || '' });
        session.conversationHistory = session.conversationHistory.slice(-10);

        await sendTTSResponse(ws, parsed.reply || 'மன்னிக்கவும், மீண்டும் சொல்லுங்கள்.', streamSid, () => {
          isBotSpeaking = true;
        });

        if (parsed.complete) {
          console.log('Booking complete:', session.collected);
        }
      } catch (err) {
        console.error('Processing error:', err.response?.data || err.message);
      } finally {
        isProcessing = false;
      }
    }

    ws.on('message', async (message) => {
      let data;
      try {
        data = JSON.parse(message);
      } catch (err) {
        console.error('Invalid Twilio websocket message:', err.message);
        return;
      }

      if (data.event === 'start') {
        streamSid = data.start.streamSid;
        console.log('Call started, streamSid:', streamSid);
        await sendTTSResponse(ws, 'வணக்கம்! இது ஸ்ரீ லட்சுமி மருத்துவமனை. நான் உங்களுக்கு எப்படி உதவ முடியும்?', streamSid, () => {
          isBotSpeaking = true;
        });
        return;
      }

      if (data.event === 'mark') {
        console.log('Twilio finished playing:', data.mark?.name);
        isBotSpeaking = false;
        return;
      }

      if (data.event === 'media') {
        inboundFrameCount += 1;

        if (inboundFrameCount === 1 || inboundFrameCount % 100 === 0) {
          console.log('Receiving caller media from Twilio:', {
            frames: inboundFrameCount,
            track: data.media.track,
            payloadBytes: Buffer.from(data.media.payload, 'base64').length
          });
        }

        if (isBotSpeaking) {
          return;
        }

        if (skippedOpeningFrames < 5) {
          skippedOpeningFrames += 1;
          return;
        }

        audioChunks.push(Buffer.from(data.media.payload, 'base64'));

        if (audioChunks.length >= FRAMES_PER_STT_CHUNK) {
          await processCallerAudio('audio chunk is ready');
        }
      }

      if (data.event === 'stop') {
        console.log('Call ended');
        await processCallerAudio('call ended');
      }
    });

    ws.on('close', async () => {
      await processCallerAudio('stream closed');
      console.log('Stream disconnected');
    });
  });

  return wss;
}

async function sendTTSResponse(ws, text, streamSid, beforeSend) {
  try {
    assertSarvamKey();
    console.log('TTS Text:', text.substring(0, 80));

    const response = await axios.post('https://api.sarvam.ai/text-to-speech', {
      text,
      target_language_code: 'ta-IN',
      speaker: 'anushka',
      model: 'bulbul:v2',
      speech_sample_rate: String(TWILIO_SAMPLE_RATE),
      output_audio_codec: 'mulaw',
      enable_preprocessing: true
    }, {
      headers: {
        ...getSarvamHeaders(),
        'Content-Type': 'application/json'
      }
    });

    const audioBase64 = response.data.audios?.[0];
    if (!audioBase64) {
      console.error('TTS returned no audio. Full response:', JSON.stringify(response.data));
      return;
    }

    if (ws.readyState === WebSocket.OPEN) {
      const markName = `tts-${Date.now()}`;
      if (beforeSend) beforeSend();
      ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: audioBase64 } }));
      ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: markName } }));
      console.log('TTS audio sent, streamSid:', streamSid, 'mark:', markName);
    } else {
      console.error('TTS not sent. WebSocket not open. readyState:', ws.readyState);
    }
  } catch (err) {
    console.error('TTS API Error:', err.response?.data || err.message);
  }
}

module.exports = { router, setupMediaStream };
