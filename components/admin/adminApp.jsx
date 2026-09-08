import { useState } from "react";
import AdminLayout from "./adminLayout";
import AdminDashboard from "./adminDashboard";
import AdminIntake from "./adminIntake";
import AdminUsers from "./adminUsers";
import AdminKeys from "./adminKeys";
import AdminExplorer from "./adminExplorer";

// Drop-in root for the Admin role. If the wider app already uses a router
// (e.g., react-router), swap `activePage` state for real routes — the nav
// keys in AdminLayout ("dashboard", "intake", "users", "keys", "explorer",
// map 1:1 to whatever paths you choose.
export default function AdminApp({ adminName, onSignOut }) {
  const [activePage, setActivePage] = useState("dashboard");
  const [explorerStatusFilter, setExplorerStatusFilter] = useState("");

  const goToExplorer = (statusFilter) => {
    setExplorerStatusFilter(statusFilter ?? "");
    setActivePage("explorer");
  };

  return (
    <AdminLayout
      activePage={activePage}
      onNavigate={setActivePage}
      adminName={adminName}
      onSignOut={onSignOut}
    >
      {activePage === "dashboard" && (
        <AdminDashboard onNavigateToExplorer={goToExplorer} />
      )}
      {activePage === "intake" && <AdminIntake />}
      {activePage === "users" && <AdminUsers />}
      {activePage === "keys" && <AdminKeys />}
      {activePage === "explorer" && (
        <AdminExplorer initialStatusFilter={explorerStatusFilter} />
      )}
    </AdminLayout>
  );
}
