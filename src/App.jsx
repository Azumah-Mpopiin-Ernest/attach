import { Navigate, Route, Routes } from "react-router-dom";
import AuthPage from "./authPage";


export default function App() {
  return (
    <Routes>
      <Route path="/" element={<AuthPage />} />
      <Route path="/auth" element={<AuthPage />} />
      <Route path="/admin/*" element={<AuthPage requiredRole="admin" />} />
      <Route path="/doctor/*" element={<AuthPage requiredRole="doctor" />} />
      <Route path="/officer/*" element={<AuthPage requiredRole="officer" />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
