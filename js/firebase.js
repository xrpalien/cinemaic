// Firebase initialisation
// Note: this config is intentionally public — Firebase API keys identify the project,
// they do not grant admin access. Security is enforced by Firestore Security Rules + Auth.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.2.0/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey:            'AIzaSyAeECX2B0iSINL2noml2n1Tp7AEVay_hd4',
  authDomain:        'cinemaic.firebaseapp.com',
  projectId:         'cinemaic',
  storageBucket:     'cinemaic.firebasestorage.app',
  messagingSenderId: '740198513845',
  appId:             '1:740198513845:web:16a00d7011136a89d012fc',
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db   = getFirestore(app);

const googleProvider = new GoogleAuthProvider();

export function signIn()       { return signInWithPopup(auth, googleProvider); }
export function signOutUser()  { return signOut(auth); }
export { onAuthStateChanged };
