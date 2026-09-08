import { Circle, CircleDot, CheckCircle2 } from "lucide-react";

// Doctors only ever see these three states in their own flows.
// Kept visually identical to the admin module's StatusChip — if you'd
// rather not duplicate, move this into a shared /components package.
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
  DONE: {
    label: "Done",
    icon: CheckCircle2,
    text: "text-emerald-700",
    bg: "bg-emerald-50",
    ring: "ring-emerald-200",
  },
};

export default function StatusChip({ status, className = "" }) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.AWAITING_SIGN;
  const Icon = config.icon;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${config.bg} ${config.text} ${config.ring} ${className}`}
    >
      <Icon className="h-3.5 w-3.5" />
      {config.label}
    </span>
  );
}
