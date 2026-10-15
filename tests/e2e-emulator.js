#!/usr/bin/env node
/*
E2E emulator test for Chore-app (security-hardening branch)

Requires:
- Firebase Emulator Suite running: firebase emulators:start --only functions,firestore,auth,hosting
- Node 18+ (global fetch available)
- Environment variable: PROJECT_ID (Firebase project id used in emulators)

This script will:
1. Create a test user via Admin SDK
2. Create a profile doc and a chore doc with status 'pending_approval'
3. Mint a custom token for the user and exchange it for an ID token via the Auth emulator
4. Call the functions emulator endpoint /create-approval-token to get a signed token
5. Call /approve-chore with the signed token
6. Verify the chore was deleted and profile points updated
7. Cleanup

Run:
  PROJECT_ID=your-project node tests/e2e-emulator.js

Note: adjust EMULATOR_HOSTS if your emulators use non-default ports.
*/

import admin from 'firebase-admin';
import fs from 'fs';

const PROJECT_ID = process.env.PROJECT_ID || process.env.FIREBASE_PROJECT || '';
if (!PROJECT_ID) {
  console.error('PROJECT_ID environment variable is required.');
  process.exit(2);
}

// Use emulator hosts if provided or defaults
const AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || 'http://localhost:9099';
const FUNCTIONS_EMULATOR_HOST = process.env.FIREBASE_FUNCTIONS_EMULATOR_HOST || 'http://localhost:5001';
const FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_FIRESTORE_EMULATOR_HOST || 'localhost:8080';

console.log('Using PROJECT_ID=', PROJECT_ID);
console.log('AUTH_EMULATOR_HOST=', AUTH_EMULATOR_HOST);
console.log('FUNCTIONS_EMULATOR_HOST=', FUNCTIONS_EMULATOR_HOST);
console.log('FIRESTORE_EMULATOR_HOST=', FIRESTORE_EMULATOR_HOST);

// Initialize Admin SDK to talk to emulators
admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();
const auth = admin.auth();

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  let user;
  let choreId;
  try {
    console.log('Creating test user...');
    user = await auth.createUser({ displayName: 'E2E Tester' });
    console.log('Created user:', user.uid);

    const appId = process.env.APP_ID || 'kaching-default-app';

    // Create profile
    const profileRef = db.collection('artifacts').doc(appId).collection('users').doc(user.uid).collection('profile').doc('data');
    await profileRef.set({ points: 0 });

    // Create chore
    choreId = 'e2e-chore-' + Date.now();
    const choreRef = db.collection('artifacts').doc(appId).collection('users').doc(user.uid).collection('chores').doc(choreId);
    const points = 42;
    await choreRef.set({ title: 'E2E Test Chore', points, status: 'pending_approval', timestamp: Date.now() });
    console.log('Created chore', choreId);

    // Mint custom token
    console.log('Creating custom token...');
    const customToken = await auth.createCustomToken(user.uid);

    // Exchange custom token for ID token with Auth emulator
    console.log('Exchanging custom token for ID token...');
    const signInUrl = `${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=any`;
    const res1 = await fetch(signInUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true })
    });
    if (!res1.ok) {
      const text = await res1.text();
      throw new Error('Failed to exchange custom token: ' + text);
    }
    const signInData = await res1.json();
    const idToken = signInData.idToken;
    console.log('Obtained ID token for user.');

    // Call create-approval-token endpoint on functions emulator
    const functionsBase = `${FUNCTIONS_EMULATOR_HOST}/${PROJECT_ID}/us-central1/api`;
    console.log('Functions base:', functionsBase);

    console.log('Calling create-approval-token...');
    const createResp = await fetch(`${functionsBase}/create-approval-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
      body: JSON.stringify({ choreId, points, parentEmail: 'parent@example.com', choreTitle: 'E2E Test Chore', childDisplayName: 'E2E Tester' })
    });
    const createJson = await createResp.json();
    if (!createResp.ok) {
      throw new Error('create-approval-token failed: ' + JSON.stringify(createJson));
    }
    console.log('create-approval-token response:', createJson);
    const token = createJson.token;
    if (!token) throw new Error('No token returned');

    // Call approve-chore with the token
    console.log('Calling approve-chore...');
    const approveResp = await fetch(`${functionsBase}/approve-chore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const approveJson = await approveResp.json();
    if (!approveResp.ok) {
      throw new Error('approve-chore failed: ' + JSON.stringify(approveJson));
    }
    console.log('approve-chore response:', approveJson);

    // Verify chore deleted and profile points updated
    await sleep(1000);
    const choreSnap = await choreRef.get();
    if (choreSnap.exists) {
      throw new Error('Chore still exists after approval');
    }
    const profileSnap = await profileRef.get();
    const newPoints = profileSnap.exists ? (profileSnap.data().points || 0) : null;
    if (newPoints !== points) {
      throw new Error(`Profile points expected ${points} but got ${newPoints}`);
    }

    console.log('E2E emulator test SUCCESS: points awarded and chore removed.');

  } catch (err) {
    console.error('E2E test FAILED:', err);
    process.exitCode = 1;
  } finally {
    try {
      if (user && user.uid) {
        console.log('Cleaning up: deleting user', user.uid);
        await auth.deleteUser(user.uid).catch(() => {});
        // remove any remaining docs
        const appId = process.env.APP_ID || 'kaching-default-app';
        const userRoot = db.collection('artifacts').doc(appId).collection('users').doc(user.uid);
        // delete subcollections (profile, chores)
        const choresCol = userRoot.collection('chores');
        const chores = await choresCol.listDocuments();
        for (const d of chores) await d.delete().catch(() => {});
        const profileDoc = userRoot.collection('profile').doc('data');
        await profileDoc.delete().catch(() => {});
      }
    } catch (cleanupErr) {
      console.error('Cleanup error:', cleanupErr);
    }
  }
}

main();
