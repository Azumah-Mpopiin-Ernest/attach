# React + Vite App

## Start developing

```bash
npm install
npm run dev
```

The app uses React Router. Add pages in `src/App.jsx` or split route components into a `src/pages` directory as the project grows.

## Firebase setup

1. Create a Firebase web app in the Firebase console.
2. Copy `.env.example` to `.env`.
3. Fill in the Firebase web configuration values.

Firebase is initialized from `src/firebase.js`. The app can start without Firebase configuration, so you can add the environment values when your Firebase project is ready.

## Available scripts

- `npm run dev` starts the Vite development server.
- `npm run build` creates a production build.
- `npm run lint` checks the source with Oxlint.
