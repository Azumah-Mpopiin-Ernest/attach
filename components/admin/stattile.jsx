export default function StatTile({ value, label, onClick }) {
  const Tag = onClick ? "button" : "div";

  return (
    <Tag
      onClick={onClick}
      className={`flex flex-col items-start rounded-md border border-slate-200 bg-white px-5 py-4 text-left ${
        onClick
          ? "transition-colors hover:border-[#2F6F62]/40 hover:bg-[#2F6F62]/[0.03] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2F6F62]"
          : ""
      }`}
    >
      <span className="font-mono text-2xl font-semibold text-slate-900">
        {value}
      </span>
      <span className="mt-1 text-sm text-slate-500">{label}</span>
    </Tag>
  );
}