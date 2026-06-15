const express = require('express');
const router = express.Router();
const axios = require('axios');
const WebSocket = require('ws');
const FormData = require('form-data');

const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
const TWILIO_SAMPLE_RATE = 8000;
const SARVAM_STT_SAMPLE_RATE = 16000;
const TWILIO_FRAME_MS = 20;
const SPEECH_RMS_THRESHOLD = 450;
const SILENCE_FRAMES_TO_END_UTTERANCE = 35; // About 700 ms.
const MIN_SPEECH_FRAMES_FOR_STT = 18; // About 360 ms of actual voice.

const DOCTORS = [
  { name: 'Dr. Kumar', department: 'Cardiology', aliases: ['kumar', 'குமார்', 'குமாரு', 'cardiology', 'கார்டியாலஜி', 'heart', 'இதயம்'] },
  { name: 'Dr. Priya', department: 'General Medicine', aliases: ['priya', 'பிரியா', 'general medicine', 'ஜெனரல்', 'medicine', 'மெடிசின்'] },
  { name: 'Dr. Rajan', department: 'Orthopedic', aliases: ['rajan', 'ராஜன்', 'ராஜா', 'orthopedic', 'ortho', 'ஆர்த்தோ', 'எலும்பு'] }
];

const DOCTOR_LIST_REPLY = 'எங்களிடம் Dr. Kumar, இதய மருத்துவம். Dr. Priya, பொது மருத்துவம். Dr. Rajan, எலும்பு மருத்துவம். யாரிடம் appointment வேண்டும்?';

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

  console.log('Sarvam STT response:', {
    transcript: res.data.transcript || '',
    language_code: res.data.language_code || null,
    language_probability: res.data.language_probability ?? null
  });

  return res.data.transcript || '';
}

const FAQS = [
  { keywords: ['நேரம்', 'time', 'timing', 'open', 'திற'], answer: 'OPD நேரம் காலை 8 மணி முதல் மதியம் 1 மணி வரை, மாலை 4 மணி முதல் இரவு 8 மணி வரை.' },
  { keywords: ['கட்டணம்', 'fee', 'fees', 'charge', 'cost', 'விலை', 'பணம்'], answer: 'Consultation fee ரூபாய் 300 மட்டும்.' },
  { keywords: ['எங்கே', 'where', 'location', 'address', 'வழி'], answer: 'நாங்கள் Anna Nagar, Chennai-வில் இருக்கிறோம். அருகில் உள்ள bus stop Anna Nagar Tower.' },
  { keywords: ['emergency', 'urgent', 'அவசரம்'], answer: 'Emergency: 044-12345678. 24 மணி நேரமும் கிடைக்கும்.' },
  { keywords: ['ஞாயிறு', 'sunday', 'holiday', 'விடுமுறை'], answer: 'ஞாயிற்றுக்கிழமை OPD இல்லை. திங்கள் முதல் சனி வரை மட்டும்.' },
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

function extractDoctor(text) {
  const lower = text.toLowerCase();
  return DOCTORS.find((doctor) => doctor.aliases.some((alias) => lower.includes(alias.toLowerCase()))) || null;
}

function userIsAskingForDoctorList(text) {
  const lower = text.toLowerCase();
  const asksForDoctor = ['doctor', 'doctors', 'டாக்டர்', 'டாக்டர்கள்', 'யார்', 'available', 'list'].some((word) => lower.includes(word));
  return asksForDoctor && !extractDoctor(text);
}

function extractMobile(text) {
  const digits = text.replace(/\D/g, '');
  const match = digits.match(/[6-9]\d{9}/);
  return match ? match[0] : null;
}

function maybeExtractNameFromAnswer(session, text) {
  if (session.lastAsked !== 'name' || session.collected.name) return null;

  const cleaned = text
    .replace(/my name is/ig, '')
    .replace(/name is/ig, '')
    .replace(/என் பெயர்/g, '')
    .replace(/பெயர்/g, '')
    .replace(/[.,!?]/g, '')
    .trim();

  if (!cleaned || extractDoctor(cleaned) || extractMobile(cleaned)) return null;
  if (cleaned.length > 40) return null;
  return cleaned;
}

function nextBookingQuestion(session) {
  if (!session.collected.doctor) {
    session.lastAsked = 'doctor';
    return 'எந்த டாக்டரிடம் appointment வேண்டும்? Dr. Kumar, இதய மருத்துவம். Dr. Priya, பொது மருத்துவம். Dr. Rajan, எலும்பு மருத்துவம்.';
  }

  if (!session.collected.name) {
    session.lastAsked = 'name';
    return `சரி, ${session.collected.doctor} appointment. உங்கள் பெயர் என்ன?`;
  }

  if (!session.collected.mobile) {
    session.lastAsked = 'mobile';
    return 'நன்றி. உங்கள் mobile number சொல்லுங்கள்.';
  }

  session.lastAsked = null;
  return `நன்றி ${session.collected.name}. ${session.collected.doctor} அவர்களிடம் உங்கள் appointment பதிவு செய்யப்பட்டது. உங்கள் mobile number ${session.collected.mobile}.`;
}

function applyDeterministicBooking(session, transcript) {
  const doctor = extractDoctor(transcript);
  if (doctor) {
    session.collected.doctor = doctor.name;
    console.log('Doctor selected:', doctor.name, 'department:', doctor.department);
  }

  const mobile = extractMobile(transcript);
  if (mobile) {
    session.collected.mobile = mobile;
    console.log('Mobile captured:', mobile);
  }

  const possibleName = maybeExtractNameFromAnswer(session, transcript);
  if (possibleName) {
    session.collected.name = possibleName;
    console.log('Name captured:', possibleName);
  }

  if (doctor || mobile || possibleName) {
    const reply = nextBookingQuestion(session);
    return {
      handled: true,
      reply,
      complete: Boolean(session.collected.name && session.collected.mobile && session.collected.doctor)
    };
  }

  return { handled: false };
}

function buildSystemPrompt(session) {
  return `நீங்கள் ஸ்ரீ லட்சுமி மருத்துவமனையின் (Sri Lakshmi Hospital) AI வரவேற்பு உதவியாளர்.

கிடைக்கும் டாக்டர்கள்: "Dr. Kumar" - இதய மருத்துவம், "Dr. Priya" - பொது மருத்துவம், "Dr. Rajan" - எலும்பு மருத்துவம். Department பெயரை doctor பெயருடன் சேர்த்து முழு பெயர் போல சொல்ல வேண்டாம்.
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
    model: 'sarvam-30b',
    messages: [
      { role: 'system', content: buildSystemPrompt(session) },
      ...session.conversationHistory
    ],
    max_tokens: 300,
    temperature: 0.2,
    response_format: { type: 'json_object' }
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
    let botSpeakingFallbackTimer = null;
    let silenceFrameCount = 0;
    let speechFrameCount = 0;
    let heardSpeech = false;

    const session = {
      collected: { name: null, mobile: null, doctor: null },
      conversationHistory: [],
      lastAsked: null
    };

    function resetCallerAudio() {
      audioChunks = [];
      silenceFrameCount = 0;
      speechFrameCount = 0;
      heardSpeech = false;
    }

    async function processCallerAudio(reason) {
      if (isProcessing || audioChunks.length === 0) return;

      if (speechFrameCount < MIN_SPEECH_FRAMES_FOR_STT) {
        console.log('Dropping caller audio because not enough speech was detected:', {
          reason,
          frames: audioChunks.length,
          speechFrames: speechFrameCount
        });
        resetCallerAudio();
        return;
      }

      isProcessing = true;
      const chunksToProcess = audioChunks;
      const speechFramesToProcess = speechFrameCount;
      resetCallerAudio();

      console.log(`Processing caller speech because ${reason}:`, {
        frames: chunksToProcess.length,
        speechFrames: speechFramesToProcess,
        approxSeconds: Number(((chunksToProcess.length * TWILIO_FRAME_MS) / 1000).toFixed(2))
      });

      try {
        const mulawBuffer = Buffer.concat(chunksToProcess);
        const transcript = await transcribeAudio(mulawBuffer);
        const cleanedTranscript = transcript.trim();

        if (!cleanedTranscript) {
          console.log('Sarvam STT returned empty transcript. This usually means silence/noise reached STT, not clear speech.');
          return;
        }

        console.log('Transcript:', cleanedTranscript);

        if (userIsAskingForDoctorList(cleanedTranscript)) {
          await sendTTSResponse(ws, DOCTOR_LIST_REPLY, streamSid, startBotSpeakingWindow);
          session.lastAsked = 'doctor';
          return;
        }

        const bookingUpdate = applyDeterministicBooking(session, cleanedTranscript);
        if (bookingUpdate.handled) {
          await sendTTSResponse(ws, bookingUpdate.reply, streamSid, startBotSpeakingWindow);
          if (bookingUpdate.complete) console.log('Booking complete:', session.collected);
          return;
        }

        const faqAnswer = checkFAQ(cleanedTranscript);
        if (faqAnswer) {
          await sendTTSResponse(ws, faqAnswer, streamSid, startBotSpeakingWindow);
          return;
        }

        const parsed = await getAssistantReply(session, cleanedTranscript);
        const extracted = parsed.extracted || {};

        if (extracted.name) session.collected.name = extracted.name;
        if (extracted.mobile) session.collected.mobile = extracted.mobile;
        if (extracted.doctor) session.collected.doctor = extracted.doctor;

        session.conversationHistory.push({ role: 'assistant', content: parsed.reply || '' });
        session.conversationHistory = session.conversationHistory.slice(-10);

        await sendTTSResponse(ws, parsed.reply || 'மன்னிக்கவும், மீண்டும் சொல்லுங்கள்.', streamSid, startBotSpeakingWindow);

        if (parsed.complete) {
          console.log('Booking complete:', session.collected);
        }
      } catch (err) {
        console.error('Processing error:', err.response?.data || err.message);
      } finally {
        isProcessing = false;
      }
    }

    function startBotSpeakingWindow(durationMs) {
      isBotSpeaking = true;
      clearTimeout(botSpeakingFallbackTimer);
      botSpeakingFallbackTimer = setTimeout(() => {
        if (isBotSpeaking) {
          console.log('Bot speaking fallback ended; listening for caller now.');
          isBotSpeaking = false;
        }
      }, Math.max(1200, durationMs + 700));
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
        session.lastAsked = 'doctor';
        await sendTTSResponse(ws, 'வணக்கம்! இது ஸ்ரீ லட்சுமி மருத்துவமனை. Appointment பதிவு செய்ய எந்த டாக்டரிடம் பார்க்க வேண்டும்?', streamSid, startBotSpeakingWindow);
        return;
      }

      if (data.event === 'mark') {
        console.log('Twilio finished playing:', data.mark?.name);
        clearTimeout(botSpeakingFallbackTimer);
        isBotSpeaking = false;
        return;
      }

      if (data.event === 'media') {
        inboundFrameCount += 1;
        const frame = Buffer.from(data.media.payload, 'base64');

        if (inboundFrameCount === 1 || inboundFrameCount % 100 === 0) {
          console.log('Receiving caller media from Twilio:', {
            frames: inboundFrameCount,
            track: data.media.track,
            payloadBytes: frame.length
          });
        }

        if (isBotSpeaking) {
          return;
        }

        if (skippedOpeningFrames < 5) {
          skippedOpeningFrames += 1;
          return;
        }

        const frameRms = calculateRmsPcm16Le(mulawToPcm16(frame));

        if (frameRms >= SPEECH_RMS_THRESHOLD) {
          heardSpeech = true;
          speechFrameCount += 1;
          silenceFrameCount = 0;
          audioChunks.push(frame);
        } else if (heardSpeech) {
          silenceFrameCount += 1;
          audioChunks.push(frame);
        }

        if (inboundFrameCount % 100 === 0) {
          console.log('Caller audio level:', {
            rms: Math.round(frameRms),
            heardSpeech,
            speechFrames: speechFrameCount,
            bufferedFrames: audioChunks.length
          });
        }

        if (heardSpeech && silenceFrameCount >= SILENCE_FRAMES_TO_END_UTTERANCE) {
          await processCallerAudio('caller paused');
        }
      }

      if (data.event === 'stop') {
        console.log('Call ended');
        await processCallerAudio('call ended');
      }
    });

    ws.on('close', async () => {
      await processCallerAudio('stream closed');
      clearTimeout(botSpeakingFallbackTimer);
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
      const audioBytes = Buffer.from(audioBase64, 'base64').length;
      const estimatedDurationMs = Math.ceil((audioBytes / TWILIO_SAMPLE_RATE) * 1000);

      if (beforeSend) beforeSend(estimatedDurationMs);

      ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: audioBase64 } }));
      ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: markName } }));
      console.log('TTS audio sent, streamSid:', streamSid, 'mark:', markName, 'estimatedMs:', estimatedDurationMs);
    } else {
      console.error('TTS not sent. WebSocket not open. readyState:', ws.readyState);
    }
  } catch (err) {
    console.error('TTS API Error:', err.response?.data || err.message);
  }
}

module.exports = { router, setupMediaStream };

