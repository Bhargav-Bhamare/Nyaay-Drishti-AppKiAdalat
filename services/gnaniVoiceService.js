'use strict';

require('dotenv').config();
const axios = require('axios');

function normalizeLanguage(language = 'en') {
  const lang = String(language || 'en').toLowerCase();
  return ['en', 'hi', 'ta'].includes(lang) ? lang : 'en';
}

function buildMockReply(transcript, language = 'en') {
  const text = String(transcript || '').trim().toLowerCase();
  const replies = {
    en: {
      default: '“Your matter is listed today at 2:30 PM. The next hearing is scheduled for 2:30 PM.”',
      hearing: '“Your next hearing is on 14 July 2026 at 10:30 AM.”',
      update: '“The matter has progressed today. The registrar accepted the reply documents this morning.”',
    },
    hi: {
      default: '“आपका मामला आज दोपहर 2:30 बजे सूचीबद्ध है। अगली सुनवाई 2:30 PM पर तय की गई है।”',
      hearing: '“आपकी अगली सुनवाई 14 जुलाई 2026 को सुबह 10:30 बजे होगी।”',
      update: '“मामला आज आगे बढ़ा है। रजिस्ट्रार ने आज सुबह जवाबी दस्तावेज स्वीकार कर लिए हैं।”',
    },
    ta: {
      default: '“உங்கள் வழக்கு இன்று மதியம் 2:30 மணிக்கு பட்டியலிடப்பட்டுள்ளது. அடுத்த விசாரணை 2:30 PM இல் திட்டமிடப்பட்டுள்ளது.”',
      hearing: '“உங்கள் அடுத்த விசாரணை 14 ஜூலை 2026 காலை 10:30 மணிக்கு இருக்கும்.”',
      update: '“இந்த வழக்கு இன்று முன்னேறியுள்ளது. பதிவாளர் இன்று காலை பதிலளிப்பு ஆவணங்களை ஏற்றுக்கொண்டார்.”',
    },
  };

  if (text.includes('hearing') || text.includes('सुनवाई') || text.includes('விசாரணை')) {
    return replies[language].hearing || replies.en.hearing;
  }
  if (text.includes('update') || text.includes('अपडेट') || text.includes('புதுப்பிப்பு')) {
    return replies[language].update || replies.en.update;
  }
  return replies[language].default || replies.en.default;
}

function buildMockTranscript(transcript, language = 'en') {
  const labels = {
    en: 'You said',
    hi: 'आपने कहा',
    ta: 'நீங்கள் சொன்னது',
  };
  const label = labels[language] || labels.en;
  return `${label}: ${transcript || 'I would like an update on my case.'}`;
}

function isConfigured() {
  return Boolean(process.env.GNANI_API_KEY);
}

async function processVoiceAssistant(textInput, targetVoice = null) {
  const mockFallback = {
    success: true,
    textResponse: textInput || '',
    audioBuffer: null,
    isMock: true,
  };

  if (!process.env.GNANI_API_KEY) {
    console.warn('[gnaniVoiceService] GNANI_API_KEY missing. Returning local mock fallback.');
    return mockFallback;
  }

  const baseUrl = String(process.env.GNANI_BASE_URL || 'https://api.vachana.ai').replace(/\/+$/, '');
  const payload = {
    model: 'vachana-voice-v3',
    text: textInput,
    voice: targetVoice || 'Karan',
    audio_config: {
      container: 'mp3',
      bitrate: '192k',
      encoding: 'linear_pcm',
      sample_rate: 44100,
      num_channels: 1,
      sample_width: 2,
    },
  };

  try {
    const response = await axios.post(`${baseUrl}/api/v1/tts/inference`, payload, {
      headers: {
        'X-API-Key-ID': process.env.GNANI_API_KEY,
        'Content-Type': 'application/json',
      },
      responseType: 'arraybuffer',
    });

    return {
      success: true,
      textResponse: textInput,
      audioBuffer: response.data,
      isMock: false,
    };
  } catch (error) {
    const message = error?.message || String(error);
    console.warn(`[gnaniVoiceService] GNANI TTS request failed: ${message}`);
    return {
      success: false,
      textResponse: 'Voice engine throttled. Operating on local text-to-speech fallback framework.',
      audioBuffer: null,
      isMock: true,
    };
  }
}

async function getVoiceReply({ transcript = '', language = 'en' } = {}) {
  const normalizedLang = normalizeLanguage(language);
  const mockTranscript = buildMockTranscript(transcript, normalizedLang);
  const mockReply = buildMockReply(transcript, normalizedLang);

  const fallbackPayload = {
    source: 'mock',
    reply: mockReply,
    transcript: mockTranscript,
    configured: false,
    provider: 'mock',
  };

  if (!isConfigured()) {
    return fallbackPayload;
  }

  try {
    const ttsResult = await processVoiceAssistant(mockReply || transcript, null);
    return {
      source: 'gnani',
      reply: ttsResult.textResponse || mockReply,
      transcript: mockTranscript,
      configured: !ttsResult.isMock,
      provider: ttsResult.isMock ? 'mock-fallback' : 'gnani',
      audioBuffer: ttsResult.audioBuffer,
      success: ttsResult.success,
    };
  } catch (err) {
    console.warn('[gnaniVoiceService] Gnani request failed, using fallback:', err.message);
    return {
      ...fallbackPayload,
      configured: true,
      provider: 'mock-fallback',
      error: err.message,
    };
  }
}

module.exports = {
  getVoiceReply,
  processVoiceAssistant,
  isConfigured,
  buildMockReply,
  buildMockTranscript,
};
