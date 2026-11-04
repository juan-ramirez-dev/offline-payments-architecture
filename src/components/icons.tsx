type P = { size?: number }

const svg = (size: number, children: React.ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
)

export const WifiIcon = ({ size = 14 }: P) =>
  svg(size, <><path d="M5 12.55a11 11 0 0 1 14.08 0" /><path d="M1.42 9a16 16 0 0 1 21.16 0" /><path d="M8.53 16.11a6 6 0 0 1 6.95 0" /><circle cx="12" cy="20" r="1" fill="currentColor" /></>)

export const WifiOffIcon = ({ size = 14 }: P) =>
  svg(size, <><path d="m2 2 20 20" /><path d="M8.5 16.5a5 5 0 0 1 7 0" /><path d="M2 8.82a15 15 0 0 1 4.17-2.65" /><path d="M10.66 5c4.01-.36 8.14.9 11.34 3.76" /><path d="M16.85 11.25a10 10 0 0 1 2.22 1.68" /><path d="M5 13a10 10 0 0 1 5.24-2.76" /><circle cx="12" cy="20" r="1" fill="currentColor" /></>)

export const QrIcon = ({ size = 20 }: P) =>
  svg(size, <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3" /></>)

export const ScanIcon = ({ size = 20 }: P) =>
  svg(size, <><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M7 12h10" /></>)

export const CheckIcon = ({ size = 20 }: P) => svg(size, <path d="M20 6 9 17l-5-5" />)

export const XIcon = ({ size = 20 }: P) => svg(size, <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>)

export const BackIcon = ({ size = 20 }: P) => svg(size, <path d="m15 18-6-6 6-6" />)

export const ShieldIcon = ({ size = 18 }: P) =>
  svg(size, <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></>)

export const EyeIcon = ({ size = 18 }: P) =>
  svg(size, <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>)

export const ClockIcon = ({ size = 14 }: P) => svg(size, <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>)

export const DeleteIcon = ({ size = 22 }: P) =>
  svg(size, <><path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z" /><path d="m18 9-6 6M12 9l6 6" /></>)

export const SyncIcon = ({ size = 18 }: P) =>
  svg(size, <><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" /><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" /><path d="M21 3v5h-5M3 21v-5h5" /></>)

export const StoreIcon = ({ size = 18 }: P) =>
  svg(size, <><path d="M3 9 4.5 4h15L21 9" /><path d="M3 9h18v2a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z" /><path d="M5 13v7h14v-7" /></>)
