const functions = require('firebase-functions');
const admin = require('firebase-admin');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

// Initialize Firebase Admin
admin.initializeApp();

const app = express();
app.use(express.json());

// Simple in-memory per-UID rate limiter (lightweight). For production, use a persistent store.
const perUidHits = new Map();
const PER_UID_WINDOW_MS = 60 * 1000; // 1 minute
const PER_UID_MAX = 6; // max 6 calls per uid per window

function checkPerUidLimit(uid) {
  const now = Date.now();
  const entry = perUidHits.get(uid) || { count: 0, start: now };
  if (now - entry.start > PER_UID_WINDOW_MS) {
    entry.count = 1;
    entry.start = now;
    perUidHits.set(uid, entry);
    return true;
  }
  if (entry.count >= PER_UID_MAX) return false;
  entry.count += 1;
  perUidHits.set(uid, entry);
  return true;
}

// Basic IP rate limiter
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // max 60 requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

const secretClient = new SecretManagerServiceClient();
let cachedApiKey = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getGenerativeApiKey() {
  // Prefer explicit env var name for Secret Manager resource
  const secretResource = process.env.GENERATIVE_SECRET_NAME || functions.config().generative?.secret_name;
  if (!secretResource) throw new Error('GENERATIVE_SECRET_NAME not set and functions.config generative.secret_name not configured');

  // return cached if fresh
  if (cachedApiKey && Date.now() - cachedAt < CACHE_TTL_MS) return cachedApiKey;

  const [accessResponse] = await secretClient.accessSecretVersion({ name: secretResource });
  const payload = accessResponse.payload && accessResponse.payload.data ? accessResponse.payload.data.toString('utf8') : null;
  if (!payload) throw new Error('Secret payload empty');
  cachedApiKey = payload.trim();
  cachedAt = Date.now();
  return cachedApiKey;
}

// Helper: verify Firebase ID token from Authorization header
async function verifyIdToken(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    const err = new functions.https.HttpsError('unauthenticated', 'Missing or invalid Authorization header');
    throw err;
  }
  const idToken = auth.split('Bearer ')[1];
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    return decoded.uid;
  } catch (err) {
    const e = new functions.https.HttpsError('unauthenticated', 'Invalid ID token');
    throw e;
  }
}

// Helper: call Generative API
async function callGenerativeAPI(apiKey, payload) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Generative API error ${res.status}: ${text}`);
  }
  return res.json();
}

app.post('/generate-chores', async (req, res) => {
  try {
    const uid = await verifyIdToken(req);

    // per-UID rate limit
    if (!checkPerUidLimit(uid)) return res.status(429).json({ error: 'Too many requests' });

    const theme = (req.body && typeof req.body.theme === 'string') ? req.body.theme.substring(0, 100) : null;
    const prompt = theme
      ? `Suggest 3 fun, safe household chores for kids around the theme "${theme}". Return ONLY a JSON array of objects with \"title\" and numeric \"points\". Example: [{ "title": "Example", "points": 30 }]`
      : `Suggest 3 fun, safe household chores for kids. Return ONLY a JSON array of objects with \"title\" and numeric \"points\". Example: [{ \"title\": \"Example\", \"points\": 30 }]`;

    const payload = {
      contents: [ { parts: [ { text: prompt } ] } ],
      generationConfig: { responseMimeType: 'application/json' }
    };

    const apiKey = await getGenerativeApiKey();
    const apiResponse = await callGenerativeAPI(apiKey, payload);

    const textContent = apiResponse?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textContent) throw new Error('No content returned from model');

    const cleaned = textContent.replace(/```(?:json)?\n?/g, '').replace(/```/g, '').trim();

    let suggestions = [];
    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) suggestions = parsed;
    } catch (e) {
      // fallback: try to parse simple lines
      const lines = cleaned.split(/\r?\n/).filter(Boolean).slice(0, 6);
      for (const line of lines) {
        const m = line.match(/(.+?)[-–—:]\s*(\d+)/);
        if (m) suggestions.push({ title: m[1].trim().replace(/^[0-9]+\.\s*/, ''), points: parseInt(m[2], 10) });
      }
    }

    const normalized = suggestions.map(s => {
      const title = (s.title || '').toString().trim().slice(0, 200);
      let points = parseInt(s.points, 10);
      if (isNaN(points) || points <= 0) points = 30;
      points = Math.max(5, Math.min(1000, points));
      return { title, points };
    }).slice(0, 5);

    if (!normalized.length) {
      return res.json({ suggestions: [
        { title: 'Toy Sorting Challenge', points: 40 },
        { title: 'Window Wipe & Decorate', points: 30 },
        { title: 'Treasure Item Collection', points: 50 }
      ]});
    }

    return res.json({ suggestions: normalized });
  } catch (err) {
    console.error('generate-chores error:', err);
    if (err instanceof functions.https.HttpsError) return res.status(401).json({ error: err.message });
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
});

// Export as a single HTTP function
exports.api = functions.https.onRequest(app);
