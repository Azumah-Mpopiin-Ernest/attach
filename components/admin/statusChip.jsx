import { Circle, CircleDot, Loader2, CheckCircle2 } from "lucide-react";

// Status is always shown as plain-language text + a distinct icon shape,
// never color alone — see UX principle #2 (status must never be inferred).
const STATUS_CONFIG = {
  AWAITING_SIGN: {
    label: "Awaiting signature",
    icon: Circle,
    text: "text-amber-700",
    bg: "bg-amber-50",
    ring: "ring-amber-200",
  },
  READY_TO_ASSIGN: {
    label: "Ready to assign",
    icon: CircleDot,
    text: "text-sky-700",
    bg: "bg-sky-50",
    ring: "ring-sky-200",
  },
  ASSIGNED: {
    label: "Assigned",
    icon: Loader2,
    text: "text-teal-700",
    bg: "bg-teal-50",
    ring: "ring-teal-200",
    spin: true,
  },
  DONE: {
    label: "Done",
    icon: CheckCircle2,
    text: "text-emerald-700",
    bg: "bg-emerald-50",
    ring: "ring-emerald-200",
  },
};

export default function StatusChip({ status, officerName, className = "" }) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.AWAITING_SIGN;
  const Icon = config.icon;
  const label =
    status === "ASSIGNED" && officerName
      ? `Assigned — ${officerName}`
      : config.label;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${config.bg} ${config.text} ${config.ring} ${className}`}
    >
      <Icon className={`h-3.5 w-3.5 ${config.spin ? "animate-spin" : ""}`} />
      {label}
    </span>
  );
}
