import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import "./firebase";
import "./index.css";
import { registerServiceWorker } from "./registerServiceWorker";

const root = createRoot(document.getElementById("root"));

root.render(
  <HashRouter>
    <App />
  </HashRouter>,
);

registerServiceWorker();
