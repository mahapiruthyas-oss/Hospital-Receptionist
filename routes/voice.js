const express = require('express');
const router = express.Router();
const axios = require('axios');
const mongoose = require('mongoose');

// Session storage for ongoing calls
const callSessions = {};

// Patient model
const Patient = mongoose.model('Patient');

// STEP 1: Twilio calls this when patient calls our number
router.post('/', (req, res) => {
  const callSid = req.body.CallSid;
  
  // Start fresh session for this call
  callSessions[callSid] = {
    hospitalId: 'H001',
    collected: {
      name: null,
      mobile: null,
      doctor: null
    },
    step: 'greeting'
  };

  // Tell Twilio: greet and record patient
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ta-IN" voice="Polly.Aditi">
    வணக்கம்! இது ஸ்ரீ ராமச்சந்திரா மருத்துவமனை. உங்கள் பெயர் மற்றும் எந்த டாக்டரை சந்திக்க விரும்புகிறீர்கள் என்று சொல்லுங்கள்.
  </Say>
  <Gather input="speech" language="ta-IN" action="/voice/process" method="POST" speechTimeout="3" timeout="10">
  </Gather>
</Response>`;

  res.type('text/xml');
  res.send(twiml);
});

// STEP 2: Patient spoke — process what they said
router.post('/process', async (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult || '';
  const session = callSessions[callSid] || { 
    hospitalId: 'H001', 
    collected: { name: null, mobile: null, doctor: null },
    step: 'collecting'
  };

  try {
    // Send to Sarvam LLM to extract info and get reply
    const llmResponse = await axios.post(
      'https://api.sarvam.ai/v1/chat/completions',
      {
        model: 'sarvam-m',
        messages: [
          {
            role: 'system',
            content: `நீங்கள் ஸ்ரீ ராமச்சந்திரா மருத்துவமனையின் AI வரவேற்பாளர். 
            உங்கள் வேலை appointment பதிவு செய்வது மட்டுமே.
            தேவையான தகவல்கள்: பெயர், mobile number, doctor பெயர்.
            
            தற்போது சேகரிக்கப்பட்ட தகவல்கள்:
            பெயர்: ${session.collected.name || 'இல்லை'}
            Mobile: ${session.collected.mobile || 'இல்லை'}
            Doctor: ${session.collected.doctor || 'இல்லை'}
            
            நோயாளி சொன்னது: "${speechResult}"
            
            JSON format மட்டும் பதில் தாருங்கள்:
            {
              "extracted": {
                "name": "found name or null",
                "mobile": "found mobile or null", 
                "doctor": "found doctor or null"
              },
              "reply": "next question in Tamil to get missing info, or booking confirmation",
              "complete": true or false
            }`
          }
        ],
        max_tokens: 300
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.SARVAM_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Parse LLM response
    const llmText = llmResponse.data.choices[0].message.content;
    let parsed;
    try {
      const jsonMatch = llmText.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch[0]);
    } catch(e) {
      parsed = { 
        extracted: {}, 
        reply: 'மன்னிக்கவும், மீண்டும் சொல்லுங்கள்.',
        complete: false 
      };
    }

    // Update session with extracted info
    if (parsed.extracted.name) session.collected.name = parsed.extracted.name;
    if (parsed.extracted.mobile) session.collected.mobile = parsed.extracted.mobile;
    if (parsed.extracted.doctor) session.collected.doctor = parsed.extracted.doctor;
    callSessions[callSid] = session;

    // If booking complete — save to DB
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

      // Notify dashboard via socket
      const io = req.app.get('io');
      if (io) io.emit('patientAdded', patient);

      delete callSessions[callSid];

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ta-IN" voice="Polly.Aditi">${parsed.reply}</Say>
  <Hangup/>
</Response>`;
      res.type('text/xml');
      return res.send(twiml);
    }

    // Continue conversation
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ta-IN" voice="Polly.Aditi">${parsed.reply}</Say>
  <Gather input="speech" language="ta-IN" action="/voice/process" method="POST" speechTimeout="3" timeout="10">
  </Gather>
</Response>`;

    res.type('text/xml');
    res.send(twiml);

  } catch(error) {
    console.error('Voice error:', error.message);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ta-IN" voice="Polly.Aditi">மன்னிக்கவும், தொழில்நுட்ப சிக்கல். பின்னர் அழைக்கவும்.</Say>
  <Hangup/>
</Response>`;
    res.type('text/xml');
    res.send(twiml);
  }
});

module.exports = router;