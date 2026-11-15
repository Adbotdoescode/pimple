// Inline icons (lucide-react is not a dependency of this project).
type P = { size?: number; strokeWidth?: number; className?: string };

const base = (size: number, strokeWidth: number, className?: string) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  className,
  "aria-hidden": true,
});

export function CheckIcon({ size = 13, strokeWidth = 2.6, className }: P) {
  return (
    <svg {...base(size, strokeWidth, className)}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function RefreshIcon({ size = 14, strokeWidth = 2.2, className }: P) {
  return (
    <svg {...base(size, strokeWidth, className)}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

export function WarningIcon({ size = 16, strokeWidth = 2.2, className }: P) {
  return (
    <svg {...base(size, strokeWidth, className)}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

export function PlayIcon({ size = 13 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5.6v12.8a1 1 0 0 0 1.53.85l10.1-6.4a1 1 0 0 0 0-1.7L9.53 4.75A1 1 0 0 0 8 5.6z" />
    </svg>
  );
}

export function PauseIcon({ size = 13 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="5" width="4.2" height="14" rx="1.4" />
      <rect x="13.8" y="5" width="4.2" height="14" rx="1.4" />
    </svg>
  );
}
