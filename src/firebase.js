import { getApps, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const hasFirebaseConfig = Object.values(firebaseConfig).every(Boolean);

export const firebaseApp =
  getApps()[0] ?? (hasFirebaseConfig ? initializeApp(firebaseConfig) : null);

// Persistent (IndexedDB-backed) local cache: officer reads keep working from
// cache after a reload while offline, and writes (e.g. markDone) queue
// locally and replay automatically once the LAN/internet comes back.
// `persistentMultipleTabManager` lets it work across multiple open tabs
// instead of only the first one to claim the cache.
//
// Falls back to the default in-memory Firestore if persistence can't be set
// up — e.g. Vite HMR re-running this module and hitting "Firestore already
// initialized", or a browser/context (private browsing in some browsers)
// without IndexedDB support. Falling back keeps the app usable online even
// though offline durability is lost in that fallback case.
function initDb(app) {
  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    });
  } catch {
    return getFirestore(app);
  }
}

export const auth = firebaseApp ? getAuth(firebaseApp) : null;
export const db = firebaseApp ? initDb(firebaseApp) : null;
