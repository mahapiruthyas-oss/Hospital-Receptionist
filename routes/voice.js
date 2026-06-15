const express = require('express');
const router = express.Router();
const axios = require('axios');
const WebSocket = require('ws');
const FormData = require('form-data');
const mongoose = require('mongoose');

const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
const TWILIO_SAMPLE_RATE = 8000;
const SARVAM_STT_SAMPLE_RATE = 16000;
const TWILIO_FRAME_MS = 20;
const SPEECH_RMS_THRESHOLD = 450;
const SILENCE_FRAMES_TO_END_UTTERANCE = 35; // About 700 ms.
const MIN_SPEECH_FRAMES_FOR_STT = 18; // About 360 ms of actual voice.

const DOCTORS = [
  { name: 'Dr. Kumar', spokenName: 'டாக்டர் குமார்', department: 'Cardiology', spokenDepartment: 'இதய மருத்துவர்', aliases: ['kumar', 'குமார்', 'குமாரு', 'cardiology', 'கார்டியாலஜி', 'heart', 'இதயம்'] },
  { name: 'Dr. Priya', spokenName: 'டாக்டர் பிரியா', department: 'General Medicine', spokenDepartment: 'ஜெனரல் மெடிசின்', aliases: ['priya', 'பிரியா', 'general medicine', 'ஜெனரல்', 'medicine', 'மெடிசின்'] },
  { name: 'Dr. Rajan', spokenName: 'டாக்டர் ராஜன்', department: 'Orthopedic', spokenDepartment: 'எலும்பு மருத்துவர்', aliases: ['rajan', 'ராஜன்', 'ராஜா', 'orthopedic', 'ortho', 'ஆர்த்தோ', 'எலும்பு'] }
];

const DOCTOR_LIST_REPLY = 'நம்ம கிட்ட டாக்டர் குமார், இதய மருத்துவர். டாக்டர் பிரியா, ஜெனரல் மெடிசின். டாக்டர் ராஜன், எலும்பு மருத்துவர் இருக்காங்க. யார்கிட்ட appointment வேணும்?';
let externalAppointmentSaver = null;
let socketIo = null;

function getSarvamHeaders() {
  return { 'api-subscription-key': SARVAM_API_KEY };
}

function assertSarvamKey() {
  if (!SARVAM_API_KEY) {
    throw new Error('SARVAM_API_KEY is not set');
  }
}

function setAppointmentSaver(saveFn) {
  externalAppointmentSaver = saveFn;
}

function setSocketIo(io) {
  socketIo = io;
}

function buildAppointmentPayload(collected) {
  return {
    hospitalId: 'H001',
    name: collected.name,
    mobile: collected.mobile,
    doctor: collected.doctor,
    status: 'waiting',
    source: 'voice'
  };
}

function getPatientModel() {
  if (mongoose.models.Patient) return mongoose.models.Patient;

  const patientSchema = new mongoose.Schema({
    hospitalId: { type: String, default: 'H001' },
    name: String,
    mobile: String,
    doctor: String,
    tokenNumber: Number,
    status: { type: String, default: 'waiting' },
    createdAt: { type: Date, default: Date.now }
  });

  return mongoose.model('Patient', patientSchema);
}

async function saveAppointment(collected) {
  const payload = buildAppointmentPayload(collected);

  if (externalAppointmentSaver) {
    const savedPatient = await externalAppointmentSaver(payload);
    console.log('Appointment saved using injected saver:', savedPatient || payload);
    return true;
  }

  if (process.env.APPOINTMENT_WEBHOOK_URL) {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.APPOINTMENT_WEBHOOK_TOKEN) {
      headers.Authorization = `Bearer ${process.env.APPOINTMENT_WEBHOOK_TOKEN}`;
    }

    const response = await axios.post(process.env.APPOINTMENT_WEBHOOK_URL, payload, { headers });
    console.log('Appointment saved using APPOINTMENT_WEBHOOK_URL:', response.data || payload);
    return true;
  }

  if (mongoose.connection.readyState !== 1) {
    console.warn('MongoDB is not connected, so appointment cannot be saved from voice route.', {
      readyState: mongoose.connection.readyState,
      payload
    });
    return false;
  }

  const Patient = getPatientModel();
  const count = await Patient.countDocuments();
  const patient = new Patient({
    ...payload,
    tokenNumber: count + 1
  });

  await patient.save();

  if (socketIo) {
    socketIo.emit('patientAdded', patient);
  } else {
    console.log('Appointment saved to MongoDB. Dashboard may need refresh because socket io was not passed to setupMediaStream.');
  }

  console.log('Appointment saved to MongoDB:', patient);
  return true;
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
  { keywords: ['நேரம்', 'time', 'timing', 'open', 'திற'], answer: 'OPD timing காலை 8 to 1, மாலை 4 to 8.' },
  { keywords: ['கட்டணம்', 'fee', 'fees', 'charge', 'cost', 'விலை', 'பணம்'], answer: 'Consultation fee 300 ரூபாய் தான்.' },
  { keywords: ['எங்கே', 'where', 'location', 'address', 'வழி'], answer: 'Hospital Anna Nagar Chennai ல இருக்கு. Anna Nagar Tower bus stop பக்கம்.' },
  { keywords: ['emergency', 'urgent', 'அவசரம்'], answer: 'Emergency க்கு 044-12345678 call பண்ணுங்க. 24 hours available.' },
  { keywords: ['ஞாயிறு', 'sunday', 'holiday', 'விடுமுறை'], answer: 'Sunday OPD இல்ல. Monday to Saturday மட்டும்.' },
  { keywords: ['parking', 'பார்க்கிங்'], answer: 'Hospital முன்னாடி free parking இருக்கு.' }
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

function isThanksOrGoodbye(text) {
  const lower = text.toLowerCase();
  return ['thank', 'thanks', 'thank you', 'nandri', 'நன்றி', 'ok', 'okay', 'seri', 'சரி', 'bye'].some((word) => lower.includes(word));
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
    return 'Appointment க்கு எந்த doctor வேணும்? டாக்டர் குமார், இதய மருத்துவர். டாக்டர் பிரியா, ஜெனரல் மெடிசின். டாக்டர் ராஜன், எலும்பு மருத்துவர்.';
  }

  if (!session.collected.name) {
    session.lastAsked = 'name';
    return `Seri, ${session.collected.doctor} appointment. Unga name enna?`;
  }

  if (!session.collected.mobile) {
    session.lastAsked = 'mobile';
    return 'Thanks. உங்க mobile number சொல்லுங்க.';
  }

  session.lastAsked = null;
  return `Thank you ${session.collected.name}. ${session.collected.doctor} kitta unga appointment booked. We will call this number: ${session.collected.mobile}.`;
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
  return `You are Sri Lakshmi Hospital receptionist. Speak in natural Chennai-style spoken Tamil, with common English words when useful. Use Tamil script, not romanized Tanglish. Keep it simple and friendly, not literary Tamil.

Available doctors: டாக்டர் குமார் - இதய மருத்துவர். டாக்டர் பிரியா - ஜெனரல் மெடிசின். டாக்டர் ராஜன் - எலும்பு மருத்துவர். Do not read department as part of the doctor name.
OPD timing: காலை 8 to 1, மாலை 4 to 8. Sunday closed. Consultation fee 300 rupees.

Your main job is appointment booking. Collect only doctor, patient name, and mobile number. Ask one question at a time.

Collected so far: ${JSON.stringify(session.collected)}

Return strict JSON only:
{"extracted":{"name":null or "string","mobile":null or "string","doctor":null or "Dr. Kumar" or "Dr. Priya" or "Dr. Rajan"},"reply":"short natural spoken Tamil reply with common English words","complete":true or false}`;
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
      reply: 'Sorry, இன்னொரு தடவை சொல்லுங்க.',
      complete: false
    };
  }
}

router.post('/', (req, res) => {
  const host = req.headers.host;
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://${host}/voice/stream" /></Connect></Response>`);
});

function setupMediaStream(server, io) {
  if (io) setSocketIo(io);
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
      lastAsked: null,
      completed: false,
      closeAfterPlayback: false,
      saved: false
    };

    function resetCallerAudio() {
      audioChunks = [];
      silenceFrameCount = 0;
      speechFrameCount = 0;
      heardSpeech = false;
    }

    function endCallAfterPlayback() {
      session.closeAfterPlayback = true;
    }

    async function completeBookingAndReply(replyText) {
      if (!session.saved) {
        session.saved = await saveAppointment(session.collected);
      }

      session.completed = true;
      endCallAfterPlayback();
      await sendTTSResponse(ws, `${replyText} Call ah close panren. Thank you.`, streamSid, startBotSpeakingWindow);
      console.log('Booking complete:', session.collected, 'saved:', session.saved);
    }

    async function processCallerAudio(reason) {
      if (session.completed) {
        resetCallerAudio();
        return;
      }

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

        if (session.completed && isThanksOrGoodbye(cleanedTranscript)) {
          endCallAfterPlayback();
          return;
        }

        if (userIsAskingForDoctorList(cleanedTranscript)) {
          await sendTTSResponse(ws, DOCTOR_LIST_REPLY, streamSid, startBotSpeakingWindow);
          session.lastAsked = 'doctor';
          return;
        }

        const bookingUpdate = applyDeterministicBooking(session, cleanedTranscript);
        if (bookingUpdate.handled) {
          if (bookingUpdate.complete) {
            await completeBookingAndReply(bookingUpdate.reply);
          } else {
            await sendTTSResponse(ws, bookingUpdate.reply, streamSid, startBotSpeakingWindow);
          }
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

        if (parsed.complete && session.collected.name && session.collected.mobile && session.collected.doctor) {
          await completeBookingAndReply(parsed.reply || nextBookingQuestion(session));
        } else {
          await sendTTSResponse(ws, parsed.reply || 'Sorry, இன்னொரு தடவை சொல்லுங்க.', streamSid, startBotSpeakingWindow);
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
          if (session.closeAfterPlayback && ws.readyState === WebSocket.OPEN) {
            console.log('Closing Twilio stream after booking confirmation.');
            ws.close(1000, 'booking complete');
          }
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
        await sendTTSResponse(ws, 'வணக்கம், Sri Lakshmi Hospital. Appointment book பண்ண எந்த doctor வேணும்?', streamSid, startBotSpeakingWindow);
        return;
      }

      if (data.event === 'mark') {
        console.log('Twilio finished playing:', data.mark?.name);
        clearTimeout(botSpeakingFallbackTimer);
        isBotSpeaking = false;

        if (session.closeAfterPlayback && ws.readyState === WebSocket.OPEN) {
          console.log('Closing Twilio stream after booking confirmation.');
          ws.close(1000, 'booking complete');
        }
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

        if (isBotSpeaking || session.completed) {
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
    console.log('TTS Text:', text.substring(0, 120));

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

module.exports = { router, setupMediaStream, setAppointmentSaver, setSocketIo, saveAppointment };



