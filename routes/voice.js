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
const SILENCE_FRAMES_TO_END_UTTERANCE = 25; // About 500 ms for faster replies.
const MIN_SPEECH_FRAMES_FOR_STT = 18; // About 360 ms of actual voice.
const LANGUAGE_MIN_SPEECH_FRAMES_FOR_STT = 6; // "Tamil" or "English" may be brief.
const MOBILE_SILENCE_FRAMES_TO_END_UTTERANCE = 40; // About 800 ms between spoken digits.
const MOBILE_MIN_SPEECH_FRAMES_FOR_STT = 4; // Short spoken digits must still reach STT.

const DOCTORS = [
  { name: 'Dr. Kumar', spokenName: 'டாக்டர் குமார்', department: 'Cardiology', spokenDepartment: 'இதய மருத்துவர்', aliases: ['kumar', 'குமார்', 'குமாரு', 'cardiology', 'கார்டியாலஜி', 'heart', 'இதயம்'] },
  { name: 'Dr. Priya', spokenName: 'டாக்டர் பிரியா', department: 'General Medicine', spokenDepartment: 'பொது மருத்துவர்', aliases: ['priya', 'பிரியா', 'general medicine', 'ஜெனரல்', 'medicine', 'மெடிசின்'] },
  { name: 'Dr. Rajan', spokenName: 'டாக்டர் ராஜன்', department: 'Orthopedic', spokenDepartment: 'எலும்பு மருத்துவர்', aliases: ['rajan', 'ராஜன்', 'ராஜா', 'orthopedic', 'ortho', 'ஆர்த்தோ', 'எலும்பு'] }
];

const LANGUAGE_SELECTION_PROMPT_TAMIL = 'வணக்கம். இது ஸ்ரீ லட்சுமி மருத்துவமனை. நீங்கள் தமிழ் அல்லது ஆங்கிலம், எந்த மொழியில் பேச விரும்புகிறீர்கள்?';
const LANGUAGE_SELECTION_PROMPT_ENGLISH = 'Hello. This is Sri Lakshmi Hospital. Would you like to speak in Tamil, or English?';
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

async function saveAppointmentWithDetails(collected) {
  const payload = buildAppointmentPayload(collected);

  if (externalAppointmentSaver) {
    const savedPatient = await externalAppointmentSaver(payload);
    console.log('Appointment saved using injected saver:', savedPatient || payload);
    return {
      saved: true,
      tokenNumber: savedPatient?.tokenNumber ?? savedPatient?.token ?? null
    };
  }

  if (process.env.APPOINTMENT_WEBHOOK_URL) {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.APPOINTMENT_WEBHOOK_TOKEN) {
      headers.Authorization = `Bearer ${process.env.APPOINTMENT_WEBHOOK_TOKEN}`;
    }

    const response = await axios.post(process.env.APPOINTMENT_WEBHOOK_URL, payload, { headers });
    console.log('Appointment saved using APPOINTMENT_WEBHOOK_URL:', response.data || payload);
    return {
      saved: true,
      tokenNumber: response.data?.tokenNumber ?? response.data?.token ?? null
    };
  }

  if (mongoose.connection.readyState !== 1) {
    console.warn('MongoDB is not connected, so appointment cannot be saved from voice route.', {
      readyState: mongoose.connection.readyState,
      payload
    });
    return { saved: false, tokenNumber: null };
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
  return { saved: true, tokenNumber: patient.tokenNumber ?? null };
}

async function saveAppointment(collected) {
  const result = await saveAppointmentWithDetails(collected);
  return result.saved;
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

async function transcribeAudio(mulawBuffer, languageCode = 'ta-IN') {
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
  formData.append('language_code', languageCode);
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
  {
    keywords: ['நேரம்', 'time', 'timing', 'open', 'திற'],
    tamil: 'புறநோயாளிகள் பிரிவு காலை எட்டு மணி முதல் ஒரு மணி வரையும், மாலை நான்கு மணி முதல் எட்டு மணி வரையும் செயல்படும்.',
    english: 'The outpatient department is open from 8 AM to 1 PM and from 4 PM to 8 PM.'
  },
  {
    keywords: ['கட்டணம்', 'fee', 'fees', 'charge', 'cost', 'விலை', 'பணம்'],
    tamil: 'மருத்துவர் ஆலோசனைக் கட்டணம் முந்நூறு ரூபாய்.',
    english: 'The consultation fee is 300 rupees.'
  },
  {
    keywords: ['எங்கே', 'where', 'location', 'address', 'வழி'],
    tamil: 'மருத்துவமனை சென்னை அண்ணா நகரில், அண்ணா நகர் கோபுரப் பேருந்து நிறுத்தத்திற்கு அருகில் உள்ளது.',
    english: 'The hospital is in Anna Nagar, Chennai, near the Anna Nagar Tower bus stop.'
  },
  {
    keywords: ['emergency', 'urgent', 'அவசரம்'],
    tamil: 'அவசர உதவிக்கு பூஜ்ஜியம் நான்கு நான்கு, ஒன்று இரண்டு மூன்று நான்கு ஐந்து ஆறு ஏழு எட்டு என்ற எண்ணை அழைக்கவும்.',
    english: 'For emergency assistance, please call zero four four, one two three four five six seven eight.'
  },
  {
    keywords: ['ஞாயிறு', 'sunday', 'holiday', 'விடுமுறை'],
    tamil: 'ஞாயிற்றுக்கிழமை புறநோயாளிகள் பிரிவு செயல்படாது. திங்கள் முதல் சனிக்கிழமை வரை செயல்படும்.',
    english: 'The outpatient department is closed on Sunday and open from Monday through Saturday.'
  },
  {
    keywords: ['parking', 'பார்க்கிங்', 'வாகனம்'],
    tamil: 'மருத்துவமனைக்கு முன்பாக இலவச வாகன நிறுத்துமிடம் உள்ளது.',
    english: 'Free parking is available in front of the hospital.'
  }
];

function checkFAQ(text, language) {
  const lower = text.toLowerCase();

  for (const faq of FAQS) {
    if (faq.keywords.some((keyword) => lower.includes(keyword.toLowerCase()))) {
      return language === 'en-IN' ? faq.english : faq.tamil;
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

function hasNoMoreQueries(text) {
  const lower = text.toLowerCase().replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim();
  return isThanksOrGoodbye(lower) || [
    'no', 'no queries', 'no query', 'nothing', 'nothing else', 'thats all', "that's all",
    'no thank you', 'no thanks', 'வேண்டாம்', 'வேறு எதுவும் இல்லை', 'ஒன்றும் இல்லை', 'அவ்வளவுதான்'
  ].some((phrase) => lower === phrase || lower.includes(phrase));
}

function isTokenNumberQuestion(text) {
  const lower = text.toLowerCase();
  return ['token', 'token number', 'டோக்கன்', 'வரிசை எண்', 'எனது எண்'].some((phrase) => lower.includes(phrase));
}

function getPostBookingQuestion(language) {
  return language === 'en-IN'
    ? 'Do you have any other questions? You can also ask for your token number.'
    : 'வேறு ஏதேனும் கேள்விகள் உள்ளனவா? உங்கள் வரிசை எண்ணையும் கேட்கலாம்.';
}

function getTokenReply(session) {
  if (session.tokenNumber !== null && session.tokenNumber !== undefined) {
    return session.language === 'en-IN'
      ? `Your token number is ${session.tokenNumber}.`
      : `உங்கள் வரிசை எண் ${session.tokenNumber}.`;
  }

  return session.language === 'en-IN'
    ? 'Your appointment is registered, but the token number is not available yet.'
    : 'உங்கள் சந்திப்பு பதிவு செய்யப்பட்டுள்ளது. வரிசை எண் இன்னும் கிடைக்கவில்லை.';
}

function getCallClosingReply(language) {
  return language === 'en-IN'
    ? 'Thank you for calling Sri Lakshmi Hospital. Have a good day.'
    : 'ஸ்ரீ லட்சுமி மருத்துவமனையை அழைத்ததற்கு நன்றி. உங்கள் நாள் இனிதாக அமையட்டும்.';
}

function detectLanguagePreference(text) {
  const lower = text.toLowerCase();
  if (['english', 'ஆங்கிலம்', 'ஆங்கில', 'இங்கிலீஷ்'].some((word) => lower.includes(word))) return 'en-IN';
  if (['tamil', 'தமிழ்', 'தமிழில்'].some((word) => lower.includes(word))) return 'ta-IN';
  return null;
}

function getDoctorListReply(language) {
  if (language === 'en-IN') {
    return 'We have Doctor Kumar for Cardiology. Doctor Priya for General Medicine. And Doctor Rajan for Orthopedics. Which doctor would you like to see?';
  }
  return 'எங்களிடம் இதய மருத்துவர் டாக்டர் குமார், பொது மருத்துவர் டாக்டர் பிரியா, எலும்பு மருத்துவர் டாக்டர் ராஜன் உள்ளனர். எந்த மருத்துவரைச் சந்திக்க விரும்புகிறீர்கள்?';
}

function getDoctorSpokenName(doctorName, language) {
  const doctor = DOCTORS.find((item) => item.name === doctorName);
  if (!doctor) return doctorName;
  return language === 'en-IN' ? doctor.name.replace(/^Dr\./, 'Doctor') : doctor.spokenName;
}

function getRetryReply(session) {
  return session.language === 'en-IN'
    ? 'Sorry, please say that again.'
    : 'மன்னிக்கவும், மீண்டும் ஒருமுறை கூறுங்கள்.';
}

function isNameClarificationRequest(text) {
  const normalized = text
    .toLowerCase()
    .replace(/[.,!?;:()[\]{}"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return true;

  const exactPhrases = [
    'what', 'what sorry', 'sorry', 'sorry what', 'pardon', 'excuse me',
    'come again', 'say again', 'repeat', 'please repeat', 'can you repeat',
    'could you repeat', 'i did not understand', 'i didnt understand',
    'i don t understand', 'not clear', 'hello', 'yes', 'no', 'okay', 'ok',
    'என்ன', 'மன்னிக்கவும்', 'மீண்டும் சொல்லுங்கள்', 'புரியவில்லை', 'கேட்கவில்லை'
  ];

  if (exactPhrases.includes(normalized)) return true;

  return [
    'what did you say',
    'what are you asking',
    'did not hear',
    'didnt hear',
    'do not understand',
    'don t understand',
    'repeat the question'
  ].some((phrase) => normalized.includes(phrase));
}

function isPlausiblePatientName(text) {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned || isNameClarificationRequest(cleaned)) return false;
  if (extractDoctor(cleaned) || extractMobile(cleaned)) return false;
  if (cleaned.length < 2 || cleaned.length > 40) return false;

  const words = cleaned.split(' ').filter(Boolean);
  if (words.length > 4) return false;
  if (!words.every((word) => /^[A-Za-z\u0B80-\u0BFF.-]+$/.test(word))) return false;

  return true;
}

function getNameQuestionReply(session, misunderstood = false) {
  if (session.language === 'en-IN') {
    return misunderstood
      ? 'I am asking for your name. Please tell me your full name.'
      : 'Please tell me your name.';
  }

  return misunderstood
    ? 'உங்கள் பெயரைக் கேட்டேன். உங்கள் முழுப் பெயரைக் கூறுங்கள்.'
    : 'உங்கள் பெயரைக் கூறுங்கள்.';
}

function normalizeNumberWordToken(token) {
  const cleaned = token.toLowerCase().replace(/[.,!?;:()\[\]{}"']/g, '').trim();
  const map = {
    '0': '0', 'zero': '0', 'oh': '0', 'o': '0', 'ஜீரோ': '0', 'சீரோ': '0', 'பூஜ்ஜியம்': '0', 'சுழியம்': '0',
    '1': '1', 'one': '1', 'ஒன்': '1', 'ஒன்று': '1', 'ஒன்னு': '1', 'ஒரு': '1',
    '2': '2', 'two': '2', 'டூ': '2', 'டு': '2', 'இரண்டு': '2', 'ரெண்டு': '2', 'ரண்டு': '2',
    '3': '3', 'three': '3', 'tree': '3', 'த்ரீ': '3', 'மூன்று': '3', 'மூணு': '3', 'முனு': '3',
    '4': '4', 'four': '4', 'for': '4', 'ஃபோர்': '4', 'போர்': '4', 'நான்கு': '4', 'நாலு': '4',
    '5': '5', 'five': '5', 'ஃபைவ்': '5', 'பைவ்': '5', 'ஐந்து': '5', 'அஞ்சு': '5',
    '6': '6', 'six': '6', 'சிக்ஸ்': '6', 'ஆறு': '6', 'ஆரு': '6',
    '7': '7', 'seven': '7', 'செவன்': '7', 'ஏழு': '7', 'எழு': '7',
    '8': '8', 'eight': '8', 'ate': '8', 'எய்ட்': '8', 'எட்டு': '8',
    '9': '9', 'nine': '9', 'நைன்': '9', 'ஒன்பது': '9', 'ஒம்பது': '9', 'ஒன்பது': '9'
  };
  return map[cleaned] || null;
}

function extractMobile(text) {
  const tamilDigits = { '௦': '0', '௧': '1', '௨': '2', '௩': '3', '௪': '4', '௫': '5', '௬': '6', '௭': '7', '௮': '8', '௯': '9' };
  const normalizedText = text.replace(/[௦-௯]/g, (digit) => tamilDigits[digit] || digit);
  const directDigits = normalizedText.replace(/\D/g, '');
  const directMatch = directDigits.match(/[6-9]\d{9}/);
  if (directMatch) return directMatch[0];

  const tokens = normalizedText.split(/\s+/).filter(Boolean);
  const parsedDigits = [];
  let repeatNext = 1;

  for (const token of tokens) {
    const cleaned = token.toLowerCase().replace(/[.,!?;:()\[\]{}"']/g, '').trim();
    if (['double', 'டபுள்', 'ரெட்டை'].includes(cleaned)) {
      repeatNext = 2;
      continue;
    }
    if (['triple', 'டிரிபுள்'].includes(cleaned)) {
      repeatNext = 3;
      continue;
    }

    const digit = normalizeNumberWordToken(cleaned);
    if (digit !== null) {
      for (let i = 0; i < repeatNext; i += 1) parsedDigits.push(digit);
      repeatNext = 1;
    }
  }

  const numberFromWords = parsedDigits.join('');
  const wordMatch = numberFromWords.match(/[6-9]\d{9}/);
  if (wordMatch) return wordMatch[0];

  console.log('Mobile not captured from transcript:', { transcript: text, parsedDigits: numberFromWords });
  return null;
}

function extractSpokenDigits(text) {
  const tamilDigits = { '௦': '0', '௧': '1', '௨': '2', '௩': '3', '௪': '4', '௫': '5', '௬': '6', '௭': '7', '௮': '8', '௯': '9' };
  const normalizedText = text.replace(/[௦-௯]/g, (digit) => tamilDigits[digit] || digit);
  const tokens = normalizedText.split(/\s+/).filter(Boolean);
  const parsedDigits = [];
  let repeatNext = 1;

  for (const token of tokens) {
    const cleaned = token.toLowerCase().replace(/[.,!?;:()\[\]{}"']/g, '').trim();
    if (['double', 'டபுள்', 'இரட்டை'].includes(cleaned)) {
      repeatNext = 2;
      continue;
    }
    if (['triple', 'டிரிபுள்', 'மும்முறை'].includes(cleaned)) {
      repeatNext = 3;
      continue;
    }

    if (/^\+?\d+$/.test(cleaned)) {
      const digits = cleaned.replace(/\D/g, '');
      for (const digit of digits) parsedDigits.push(digit);
      repeatNext = 1;
      continue;
    }

    const digit = normalizeNumberWordToken(cleaned);
    if (digit !== null) {
      for (let i = 0; i < repeatNext; i += 1) parsedDigits.push(digit);
      repeatNext = 1;
    }
  }

  return parsedDigits.join('');
}

function handleMobileNumberInput(session, transcript) {
  const spokenDigits = extractSpokenDigits(transcript);
  const language = session.language;

  if (!spokenDigits) {
    return {
      complete: false,
      reply: language === 'en-IN'
        ? 'I am ready only for your mobile number now. Please say all ten digits, one digit at a time.'
        : 'இப்போது உங்கள் கைபேசி எண்ணை மட்டும் கூறுங்கள். பத்து இலக்கங்களையும் ஒவ்வொன்றாகக் கூறுங்கள்.'
    };
  }

  if (spokenDigits.length >= 10) {
    session.mobileDigits = spokenDigits;
  } else {
    session.mobileDigits += spokenDigits;
  }

  if (session.mobileDigits.length === 12 && session.mobileDigits.startsWith('91')) {
    session.mobileDigits = session.mobileDigits.slice(2);
  }

  const validMobile = session.mobileDigits.match(/[6-9]\d{9}/)?.[0] || null;
  if (validMobile && session.mobileDigits.length === 10) {
    session.collected.mobile = validMobile;
    session.mobileDigits = '';
    console.log('Mobile captured in dedicated number mode:', validMobile);
    const reply = nextBookingQuestion(session);
    return {
      complete: Boolean(session.collected.name && session.collected.mobile && session.collected.doctor),
      reply
    };
  }

  if (session.mobileDigits.length > 10) {
    console.log('Rejecting invalid mobile digit sequence:', session.mobileDigits);
    session.mobileDigits = '';
    return {
      complete: false,
      reply: language === 'en-IN'
        ? 'That was not a valid ten-digit mobile number. Please say the ten digits again from the beginning.'
        : 'அது சரியான பத்து இலக்கக் கைபேசி எண் அல்ல. தொடக்கத்திலிருந்து பத்து இலக்கங்களையும் மீண்டும் கூறுங்கள்.'
    };
  }

  const remaining = 10 - session.mobileDigits.length;
  return {
    complete: false,
    reply: language === 'en-IN'
      ? `I received ${session.mobileDigits.length} digits. Please say the remaining ${remaining} digits.`
      : `${session.mobileDigits.length} இலக்கங்கள் பதிவாகியுள்ளன. மீதமுள்ள ${remaining} இலக்கங்களைக் கூறுங்கள்.`
  };
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

  if (!isPlausiblePatientName(cleaned)) return null;
  return cleaned;
}

function nextBookingQuestion(session) {
  const english = session.language === 'en-IN';
  const doctorName = getDoctorSpokenName(session.collected.doctor, session.language);

  if (!session.collected.doctor) {
    session.lastAsked = 'doctor';
    return english
      ? 'Which doctor would you like to book an appointment with? We have Dr. Kumar, Dr. Priya, and Dr. Rajan.'
      : 'எந்த மருத்துவரைச் சந்திக்க விரும்புகிறீர்கள்? டாக்டர் குமார், டாக்டர் பிரியா, டாக்டர் ராஜன் ஆகியோர் உள்ளனர்.';
  }

  if (!session.collected.name) {
    session.lastAsked = 'name';
    return english
      ? `${doctorName} is selected. Please tell me your name.`
      : `${doctorName} அவர்களைச் சந்திக்கத் தேர்வு செய்துள்ளீர்கள். உங்கள் பெயர் என்ன?`;
  }

  if (!session.collected.mobile) {
    session.lastAsked = 'mobile';
    session.mobileDigits = '';
    return english
      ? 'Please say your ten-digit mobile number, one digit at a time. I will listen only for the number now.'
      : 'உங்கள் பத்து இலக்கக் கைபேசி எண்ணை ஒவ்வொரு இலக்கமாகக் கூறுங்கள். இப்போது எண்ணை மட்டும் கேட்கிறேன்.';
  }

  session.lastAsked = null;
  return english
    ? `Thank you, ${session.collected.name}. Your appointment with ${doctorName} has been booked. Your registered mobile number is ${session.collected.mobile}.`
    : `நன்றி, ${session.collected.name}. ${doctorName} அவர்களுடனான சந்திப்பு பதிவு செய்யப்பட்டுள்ளது. பதிவு செய்யப்பட்ட கைபேசி எண் ${session.collected.mobile}.`;
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
  const languageInstruction = session.language === 'en-IN'
    ? 'Speak only in clear, polite English. Do not use Tamil or Tanglish.'
    : 'Speak only in clear, polite Tamil using Tamil script. Do not use English or Tanglish. Use standard, easily understood Tamil rather than colloquial Tamil.';

  return `You are Sri Lakshmi Hospital receptionist. ${languageInstruction}

Available doctors: Dr. Kumar - Cardiology. Dr. Priya - General Medicine. Dr. Rajan - Orthopedics.
OPD timing: காலை 8 to 1, மாலை 4 to 8. Sunday closed. Consultation fee 300 rupees.

Your main job is appointment booking. Collect only doctor, patient name, and mobile number. Ask one question at a time.
Never try to extract or discuss anything except digits while the requested field is mobile.
When the requested field is name, words such as "what", "sorry", "pardon", "repeat", "hello", "yes", "no", and questions are not names. Do not extract them. Repeat the name question instead.

Collected so far: ${JSON.stringify(session.collected)}
Requested field: ${session.lastAsked || 'none'}

Return strict JSON only:
{"extracted":{"name":null or "string","mobile":null or "string","doctor":null or "Dr. Kumar" or "Dr. Priya" or "Dr. Rajan"},"reply":"short reply in the selected language only","complete":true or false}`;
}

async function getAssistantReply(session, transcript) {
  session.conversationHistory.push({ role: 'user', content: transcript });

  const llmRes = await axios.post('https://api.sarvam.ai/v1/chat/completions', {
    model: 'sarvam-30b',
    messages: [
      { role: 'system', content: buildSystemPrompt(session) },
      ...session.conversationHistory
    ],
    max_tokens: 180,
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
      reply: getRetryReply(session),
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
      saved: false,
      language: null,
      mobileDigits: '',
      bookingComplete: false,
      tokenNumber: null
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
        const saveResult = await saveAppointmentWithDetails(session.collected);
        session.saved = saveResult.saved;
        session.tokenNumber = saveResult.tokenNumber;
      }

      session.bookingComplete = true;
      session.lastAsked = 'post_booking';
      await sendTTSResponse(
        ws,
        `${replyText} ${getPostBookingQuestion(session.language)}`,
        streamSid,
        startBotSpeakingWindow,
        session.language
      );
      console.log('Booking complete:', session.collected, 'saved:', session.saved);
    }

    async function processCallerAudio(reason) {
      if (session.completed) {
        resetCallerAudio();
        return;
      }

      if (isProcessing || audioChunks.length === 0) return;

      let minimumSpeechFrames = MIN_SPEECH_FRAMES_FOR_STT;
      if (session.lastAsked === 'language') minimumSpeechFrames = LANGUAGE_MIN_SPEECH_FRAMES_FOR_STT;
      if (session.lastAsked === 'mobile') minimumSpeechFrames = MOBILE_MIN_SPEECH_FRAMES_FOR_STT;

      if (speechFrameCount < minimumSpeechFrames) {
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
        const transcript = await transcribeAudio(mulawBuffer, session.language || 'ta-IN');
        const cleanedTranscript = transcript.trim();

        if (!cleanedTranscript) {
          console.log('Sarvam STT returned empty transcript. This usually means silence/noise reached STT, not clear speech.');
          return;
        }

        console.log('Transcript:', cleanedTranscript);

        if (!session.language) {
          const selectedLanguage = detectLanguagePreference(cleanedTranscript);
          if (!selectedLanguage) {
            await sendBilingualTTSResponse(ws, LANGUAGE_SELECTION_PROMPT_TAMIL, LANGUAGE_SELECTION_PROMPT_ENGLISH, streamSid, startBotSpeakingWindow);
            return;
          }

          session.language = selectedLanguage;
          session.lastAsked = 'doctor';
          session.conversationHistory = [];
          const welcome = selectedLanguage === 'en-IN'
            ? 'Thank you. We will continue in English. Which doctor would you like to see?'
            : 'நன்றி. தமிழில் தொடரலாம். எந்த மருத்துவரைச் சந்திக்க விரும்புகிறீர்கள்?';
          await sendTTSResponse(ws, welcome, streamSid, startBotSpeakingWindow, selectedLanguage);
          return;
        }

        if (session.bookingComplete) {
          if (hasNoMoreQueries(cleanedTranscript)) {
            session.completed = true;
            endCallAfterPlayback();
            await sendTTSResponse(
              ws,
              getCallClosingReply(session.language),
              streamSid,
              startBotSpeakingWindow,
              session.language
            );
            return;
          }

          if (isTokenNumberQuestion(cleanedTranscript)) {
            await sendTTSResponse(
              ws,
              `${getTokenReply(session)} ${getPostBookingQuestion(session.language)}`,
              streamSid,
              startBotSpeakingWindow,
              session.language
            );
            return;
          }

          const postBookingFaq = checkFAQ(cleanedTranscript, session.language);
          if (postBookingFaq) {
            await sendTTSResponse(
              ws,
              `${postBookingFaq} ${getPostBookingQuestion(session.language)}`,
              streamSid,
              startBotSpeakingWindow,
              session.language
            );
            return;
          }

          await sendTTSResponse(
            ws,
            getPostBookingQuestion(session.language),
            streamSid,
            startBotSpeakingWindow,
            session.language
          );
          return;
        }

        if (session.lastAsked === 'mobile' && !session.collected.mobile) {
          const mobileUpdate = handleMobileNumberInput(session, cleanedTranscript);
          if (mobileUpdate.complete) {
            await completeBookingAndReply(mobileUpdate.reply);
          } else {
            await sendTTSResponse(ws, mobileUpdate.reply, streamSid, startBotSpeakingWindow, session.language);
          }
          return;
        }

        if (session.lastAsked === 'name' && !session.collected.name && isNameClarificationRequest(cleanedTranscript)) {
          console.log('Caller asked for the name question to be repeated:', cleanedTranscript);
          await sendTTSResponse(
            ws,
            getNameQuestionReply(session, true),
            streamSid,
            startBotSpeakingWindow,
            session.language
          );
          return;
        }

        if (userIsAskingForDoctorList(cleanedTranscript)) {
          await sendTTSResponse(ws, getDoctorListReply(session.language), streamSid, startBotSpeakingWindow, session.language);
          session.lastAsked = 'doctor';
          return;
        }

        const bookingUpdate = applyDeterministicBooking(session, cleanedTranscript);
        if (bookingUpdate.handled) {
          if (bookingUpdate.complete) {
            await completeBookingAndReply(bookingUpdate.reply);
          } else {
            await sendTTSResponse(ws, bookingUpdate.reply, streamSid, startBotSpeakingWindow, session.language);
          }
          return;
        }

        const faqAnswer = checkFAQ(cleanedTranscript, session.language);
        if (faqAnswer) {
          await sendTTSResponse(ws, faqAnswer, streamSid, startBotSpeakingWindow, session.language);
          return;
        }

        const parsed = await getAssistantReply(session, cleanedTranscript);
        const extracted = parsed.extracted || {};

        if (extracted.name && isPlausiblePatientName(extracted.name)) {
          session.collected.name = extracted.name.trim();
        } else if (extracted.name) {
          console.log('Rejected invalid name returned by assistant:', extracted.name);
          extracted.name = null;
        }
        if (extracted.mobile) session.collected.mobile = extracted.mobile;
        if (extracted.doctor) session.collected.doctor = extracted.doctor;

        session.conversationHistory.push({ role: 'assistant', content: parsed.reply || '' });
        session.conversationHistory = session.conversationHistory.slice(-10);

        if (session.lastAsked === 'name' && !session.collected.name) {
          await sendTTSResponse(
            ws,
            getNameQuestionReply(session, isNameClarificationRequest(cleanedTranscript)),
            streamSid,
            startBotSpeakingWindow,
            session.language
          );
        } else if (parsed.complete && session.collected.name && session.collected.mobile && session.collected.doctor) {
          await completeBookingAndReply(parsed.reply || nextBookingQuestion(session));
        } else {
          await sendTTSResponse(ws, parsed.reply || getRetryReply(session), streamSid, startBotSpeakingWindow, session.language);
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
        session.lastAsked = 'language';
        await sendBilingualTTSResponse(ws, LANGUAGE_SELECTION_PROMPT_TAMIL, LANGUAGE_SELECTION_PROMPT_ENGLISH, streamSid, startBotSpeakingWindow);
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

        const silenceFramesNeeded = session.lastAsked === 'mobile'
          ? MOBILE_SILENCE_FRAMES_TO_END_UTTERANCE
          : SILENCE_FRAMES_TO_END_UTTERANCE;

        if (heardSpeech && silenceFrameCount >= silenceFramesNeeded) {
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

async function synthesizeTTS(text, targetLanguageCode) {
  assertSarvamKey();
  const response = await axios.post('https://api.sarvam.ai/text-to-speech', {
    text,
    target_language_code: targetLanguageCode,
    speaker: 'neha',
    model: 'bulbul:v3',
    pace: 1.05,
    temperature: 0.4,
    speech_sample_rate: String(TWILIO_SAMPLE_RATE),
    output_audio_codec: 'mulaw'
  }, {
    headers: {
      ...getSarvamHeaders(),
      'Content-Type': 'application/json'
    }
  });

  return response.data.audios?.[0] || null;
}

function sendAudioToTwilio(ws, audioBase64, streamSid, beforeSend) {
  if (ws.readyState !== WebSocket.OPEN) {
    console.error('TTS not sent. WebSocket not open. readyState:', ws.readyState);
    return;
  }

  const markName = `tts-${Date.now()}`;
  const audioBytes = Buffer.from(audioBase64, 'base64').length;
  const estimatedDurationMs = Math.ceil((audioBytes / TWILIO_SAMPLE_RATE) * 1000);

  if (beforeSend) beforeSend(estimatedDurationMs);

  ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: audioBase64 } }));
  ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: markName } }));
  console.log('TTS audio sent, streamSid:', streamSid, 'mark:', markName, 'estimatedMs:', estimatedDurationMs);
}

async function sendBilingualTTSResponse(ws, tamilText, englishText, streamSid, beforeSend) {
  try {
    console.log('Bilingual TTS Text:', `${tamilText} ${englishText}`.substring(0, 160));
    const [tamilAudio, englishAudio] = await Promise.all([
      synthesizeTTS(tamilText, 'ta-IN'),
      synthesizeTTS(englishText, 'en-IN')
    ]);

    if (!tamilAudio || !englishAudio) {
      console.error('Bilingual TTS returned no audio.');
      return;
    }

    const combinedAudio = Buffer.concat([
      Buffer.from(tamilAudio, 'base64'),
      Buffer.from(englishAudio, 'base64')
    ]).toString('base64');

    sendAudioToTwilio(ws, combinedAudio, streamSid, beforeSend);
  } catch (err) {
    console.error('Bilingual TTS API Error:', err.response?.data || err.message);
  }
}

async function sendTTSResponse(ws, text, streamSid, beforeSend, targetLanguageCode = 'ta-IN') {
  try {
    assertSarvamKey();
    console.log('TTS Text:', text.substring(0, 120));

    const audioBase64 = await synthesizeTTS(text, targetLanguageCode);
    if (!audioBase64) {
      console.error('TTS returned no audio.');
      return;
    }

    sendAudioToTwilio(ws, audioBase64, streamSid, beforeSend);
  } catch (err) {
    console.error('TTS API Error:', err.response?.data || err.message);
  }
}

module.exports = { router, setupMediaStream, setAppointmentSaver, setSocketIo, saveAppointment };




