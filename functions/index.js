const functions = require('firebase-functions');
const admin = require('firebase-admin');
const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

admin.initializeApp();

const app = express();
app.use(express.json());

const DEFAULT_APP_ID = 'kaching-default-app';
const APPROVAL_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_APPROVALS_PER_HOUR_PER_UID = 20;
const perUidHits = new Map();

function getApprovalSecret() {
  return process.env.APP_SECRET || functions.config().app?.secret || 'development-secret-change-me';
}

function checkPerUidLimit(uid, windowMs = 60 * 1000, max = 6) {
  const now = Date.now();
  const entry = perUidHits.get(uid) || { count: 0, start: now };
  if (now - entry.start > windowMs) {
    entry.count = 1;
    entry.start = now;
    perUidHits.set(uid, entry);
    return true;
  }
  if (entry.count >= max) return false;
  entry.count += 1;
  perUidHits.set(uid, entry);
  return true;
}

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

const secretClient = new SecretManagerServiceClient();
let cachedApiKey = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getGenerativeApiKey() {
  const secretResource = process.env.GENERATIVE_SECRET_NAME || functions.config().generative?.secret_name;
  if (!secretResource) throw new Error('GENERATIVE_SECRET_NAME not set');

  if (cachedApiKey && Date.now() - cachedAt < CACHE_TTL_MS) return cachedApiKey;

  const [accessResponse] = await secretClient.accessSecretVersion({ name: secretResource });
  const payload = accessResponse.payload && accessResponse.payload.data ? accessResponse.payload.data.toString('utf8') : null;
  if (!payload) throw new Error('Secret payload empty');
  cachedApiKey = payload.trim();
  cachedAt = Date.now();
  return cachedApiKey;
}

async function verifyIdToken(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    throw new functions.https.HttpsError('unauthenticated', 'Missing or invalid Authorization header');
  }
  const idToken = auth.split('Bearer ')[1];
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    return decoded.uid;
  } catch (err) {
    throw new functions.https.HttpsError('unauthenticated', 'Invalid ID token');
  }
}

function signApprovalToken(payload) {
  const header = { alg: 'HS256', typ: 'approval' };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', getApprovalSecret()).update(`${encodedHeader}.${encodedPayload}`).digest('hex');
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function verifyApprovalToken(token) {
  if (!token || typeof token !== 'string') throw new functions.https.HttpsError('invalid-argument', 'Missing approval token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new functions.https.HttpsError('invalid-argument', 'Malformed approval token');
  const [encodedHeader, encodedPayload, signature] = parts;
  const expectedSignature = crypto.createHmac('sha256', getApprovalSecret()).update(`${encodedHeader}.${encodedPayload}`).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    throw new functions.https.HttpsError('permission-denied', 'Invalid approval token signature');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch (err) {
    throw new functions.https.HttpsError('invalid-argument', 'Approval token payload corrupt');
  }
  if (!payload.uid || !payload.choreId || !payload.points || !payload.expiresAt) {
    throw new functions.https.HttpsError('invalid-argument', 'Approval token missing fields');
  }
  if (Date.now() > payload.expiresAt) {
    throw new functions.https.HttpsError('permission-denied', 'Approval token expired');
  }
  return payload;
}

async function callGenerativeAPI(apiKey, payload) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Generative API error ${res.status}: ${text}`);
  }
  return res.json();
}

app.post('/generate-chores', async (req, res) => {
  try {
    const uid = await verifyIdToken(req);
    if (!checkPerUidLimit(uid)) return res.status(429).json({ error: 'Too many requests' });

    const theme = (req.body && typeof req.body.theme === 'string') ? req.body.theme.substring(0, 100) : null;
    const prompt = theme
      ? `Suggest 3 fun, safe household chores for kids around the theme "${theme}". Return ONLY a JSON array of objects with "title" and numeric "points". Example: [{ "title": "Example", "points": 30 }]`
      : `Suggest 3 fun, safe household chores for kids. Return ONLY a JSON array of objects with "title" and numeric "points". Example: [{ "title": "Example", "points": 30 }]`;

    const apiKey = await getGenerativeApiKey();
    const apiResponse = await callGenerativeAPI(apiKey, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' }
    });

    const textContent = apiResponse?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textContent) throw new Error('No content returned from model');

    const cleaned = textContent.replace(/```(?:json)?\n?/g, '').replace(/```/g, '').trim();

    let suggestions = [];
    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) suggestions = parsed;
    } catch (e) {
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
      return res.json({
        suggestions: [
          { title: 'Toy Sorting Challenge', points: 40 },
          { title: 'Window Wipe & Decorate', points: 30 },
          { title: 'Treasure Item Collection', points: 50 }
        ]
      });
    }

    return res.json({ suggestions: normalized });
  } catch (err) {
    console.error('generate-chores error:', err);
    if (err instanceof functions.https.HttpsError) return res.status(401).json({ error: err.message });
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
});

app.post('/create-approval-token', async (req, res) => {
  try {
    const uid = await verifyIdToken(req);
    const { choreId, points, appId } = req.body || {};

    if (!choreId || !points || Number(points) <= 0) {
      return res.status(400).json({ error: 'Missing choreId or points' });
    }

    const targetUid = req.body.uid || uid;
    if (targetUid !== uid) {
      return res.status(403).json({ error: 'You can only create approval tokens for your own chores' });
    }

    const expiresAt = Date.now() + APPROVAL_TOKEN_TTL_MS;
    const payload = { uid: targetUid, choreId, points: Number(points), appId: appId || DEFAULT_APP_ID, expiresAt };
    const token = signApprovalToken(payload);

    return res.json({ token, expiresAt, appId: payload.appId });
  } catch (err) {
    console.error('create-approval-token error:', err);
    if (err instanceof functions.https.HttpsError) return res.status(401).json({ error: err.message });
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
});

app.post('/approve-chore', async (req, res) => {
  try {
    const token = req.body && req.body.token; 
    const payload = verifyApprovalToken(token);

    const appId = payload.appId || req.body.appId || DEFAULT_APP_ID;
    const db = admin.firestore();
    const choreRef = db.collection('artifacts').doc(appId).collection('users').doc(payload.uid).collection('chores').doc(payload.choreId);
    const profileRef = db.collection('artifacts').doc(appId).collection('users').doc(payload.uid).collection('profile').doc('data');

    await db.runTransaction(async (transaction) => {
      const choreSnap = await transaction.get(choreRef);
      if (!choreSnap.exists || choreSnap.data().status !== 'pending_approval') {
        throw new functions.https.HttpsError('failed-precondition', 'Chore not pending approval');
      }
      const profileSnap = await transaction.get(profileRef);
      const currentPoints = profileSnap.exists ? (profileSnap.data().points || 0) : 0;
      transaction.delete(choreRef);
      transaction.set(profileRef, { points: currentPoints + Number(payload.points) }, { merge: true });
    });

    return res.json({ ok: true, points: Number(payload.points), uid: payload.uid, choreId: payload.choreId });
  } catch (err) {
    console.error('approve-chore error:', err);
    if (err instanceof functions.https.HttpsError) return res.status(401).json({ error: err.message });
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
});

exports.api = functions.https.onRequest(app);
