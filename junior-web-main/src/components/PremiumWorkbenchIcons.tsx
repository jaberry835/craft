import { useId } from 'react';

export type PremiumIconProps = {
  size?: number;
  className?: string;
  title?: string;
  decorative?: boolean;
};

type IconShellProps = PremiumIconProps & {
  children: React.ReactNode;
  defs: React.ReactNode;
};

type SharedIconIds = {
  panelGradient: string;
  panelStrokeGradient: string;
  accentGradient: string;
  accentAltGradient: string;
  softGlowGradient: string;
  brightGlowGradient: string;
  chromeGradient: string;
  warmHighlightGradient: string;
  shadowFilter: string;
  softBlurFilter: string;
};

function useSharedIconIds(prefix: string): SharedIconIds {
  const id = useId().replace(/:/g, '');

  return {
    panelGradient: `${prefix}-panel-${id}`,
    panelStrokeGradient: `${prefix}-panel-stroke-${id}`,
    accentGradient: `${prefix}-accent-${id}`,
    accentAltGradient: `${prefix}-accent-alt-${id}`,
    softGlowGradient: `${prefix}-soft-glow-${id}`,
    brightGlowGradient: `${prefix}-bright-glow-${id}`,
    chromeGradient: `${prefix}-chrome-${id}`,
    warmHighlightGradient: `${prefix}-warm-${id}`,
    shadowFilter: `${prefix}-shadow-${id}`,
    softBlurFilter: `${prefix}-blur-${id}`
  };
}

function SharedIconDefs({ ids }: { ids: SharedIconIds }) {
  return (
    <defs>
      <linearGradient id={ids.panelGradient} x1="8" y1="6" x2="56" y2="58" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="var(--premium-icon-panel-start, #31408d)" />
        <stop offset="1" stopColor="var(--premium-icon-panel-end, #1a214f)" />
      </linearGradient>
      <linearGradient id={ids.panelStrokeGradient} x1="10" y1="8" x2="54" y2="58" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="var(--premium-icon-edge-start, #7a8dff)" />
        <stop offset="1" stopColor="var(--premium-icon-edge-end, #4d58b9)" />
      </linearGradient>
      <linearGradient id={ids.accentGradient} x1="14" y1="10" x2="52" y2="48" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="var(--premium-icon-accent-start, #8bf0ff)" />
        <stop offset="1" stopColor="var(--premium-icon-accent-end, #7a68ff)" />
      </linearGradient>
      <linearGradient id={ids.accentAltGradient} x1="12" y1="8" x2="52" y2="54" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="var(--premium-icon-accent-alt-start, #d4d8ff)" />
        <stop offset="1" stopColor="var(--premium-icon-accent-alt-end, #7f92ff)" />
      </linearGradient>
      <linearGradient id={ids.chromeGradient} x1="12" y1="12" x2="50" y2="44" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="var(--premium-icon-chrome-start, #f4f7ff)" />
        <stop offset="1" stopColor="var(--premium-icon-chrome-end, #93a7ff)" />
      </linearGradient>
      <linearGradient id={ids.warmHighlightGradient} x1="26" y1="12" x2="40" y2="30" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="var(--premium-icon-highlight, #ffffff)" />
        <stop offset="1" stopColor="var(--premium-icon-highlight-soft, rgba(255,255,255,0))" />
      </linearGradient>
      <radialGradient id={ids.softGlowGradient} cx="50%" cy="50%" r="50%">
        <stop offset="0" stopColor="var(--premium-icon-glow, rgba(121, 230, 255, 0.55))" />
        <stop offset="1" stopColor="transparent" />
      </radialGradient>
      <radialGradient id={ids.brightGlowGradient} cx="50%" cy="50%" r="50%">
        <stop offset="0" stopColor="var(--premium-icon-glow-strong, rgba(155, 123, 255, 0.7))" />
        <stop offset="1" stopColor="transparent" />
      </radialGradient>
      <filter id={ids.shadowFilter} x="-40%" y="-40%" width="180%" height="180%">
        <feDropShadow dx="0" dy="6" stdDeviation="5" floodColor="var(--premium-icon-shadow, rgba(13, 18, 48, 0.42))" />
      </filter>
      <filter id={ids.softBlurFilter} x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="3.2" />
      </filter>
    </defs>
  );
}

function IconShell({ size = 64, className = '', title, decorative = true, defs, children }: IconShellProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      fill="none"
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : title}
    >
      {!decorative && title ? <title>{title}</title> : null}
      {defs}
      {children}
    </svg>
  );
}

function CornerSpark({ x, y, r, glowId, fillId }: { x: number; y: number; r: number; glowId: string; fillId: string }) {
  return (
    <>
      <circle cx={x} cy={y} r={r * 1.8} fill={`url(#${glowId})`} opacity="0.85" />
      <circle cx={x} cy={y} r={r} fill={`url(#${fillId})`} />
    </>
  );
}

export function PremiumJuniorWorkbenchIcon(props: PremiumIconProps) {
  const ids = useSharedIconIds('premium-workbench');

  return (
    <IconShell {...props} defs={<SharedIconDefs ids={ids} />}>
      <rect x="9" y="8" width="46" height="46" rx="12" fill={`url(#${ids.panelGradient})`} stroke={`url(#${ids.panelStrokeGradient})`} strokeWidth="1.75" filter={`url(#${ids.shadowFilter})`} />
      <circle cx="24" cy="18" r="12" fill={`url(#${ids.softGlowGradient})`} opacity="0.35" />
      <circle cx="39" cy="20" r="10" fill={`url(#${ids.brightGlowGradient})`} opacity="0.38" />
      <path d="M18 45H46" stroke={`url(#${ids.chromeGradient})`} strokeWidth="2.2" strokeLinecap="round" opacity="0.55" />
      <path d="M15 42H49" stroke={`url(#${ids.accentAltGradient})`} strokeWidth="2.4" strokeLinecap="round" opacity="0.85" />
      <path d="M20 42L18 49" stroke={`url(#${ids.accentAltGradient})`} strokeWidth="3" strokeLinecap="round" />
      <path d="M44 42L46 49" stroke={`url(#${ids.accentAltGradient})`} strokeWidth="3" strokeLinecap="round" />
      <path d="M20 49H44" stroke={`url(#${ids.accentAltGradient})`} strokeWidth="2.8" strokeLinecap="round" />
      <rect x="21" y="21" width="22" height="16" rx="2.6" fill="var(--premium-icon-screen, rgba(18, 23, 60, 0.72))" stroke={`url(#${ids.accentAltGradient})`} strokeWidth="1.8" />
      <path d="M27 26L31 29L27 32" stroke={`url(#${ids.chromeGradient})`} strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M34 32H38" stroke={`url(#${ids.chromeGradient})`} strokeWidth="2.3" strokeLinecap="round" />
      <path d="M14 37V29" stroke={`url(#${ids.panelStrokeGradient})`} strokeWidth="4" strokeLinecap="round" opacity="0.85" />
      <path d="M50 37V29" stroke={`url(#${ids.panelStrokeGradient})`} strokeWidth="4" strokeLinecap="round" opacity="0.85" />
      <path d="M23 16L29 20L35 17L40 21" stroke={`url(#${ids.accentGradient})`} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M35 17L39 15L45 18" stroke={`url(#${ids.chromeGradient})`} strokeWidth="1.7" strokeLinecap="round" />
      <CornerSpark x={24} y={18} r={1.8} glowId={ids.softGlowGradient} fillId={ids.chromeGradient} />
      <CornerSpark x={31} y={20} r={1.6} glowId={ids.brightGlowGradient} fillId={ids.accentGradient} />
      <CornerSpark x={39} y={15} r={1.7} glowId={ids.softGlowGradient} fillId={ids.accentAltGradient} />
      <CornerSpark x={45} y={18} r={1.6} glowId={ids.brightGlowGradient} fillId={ids.chromeGradient} />
      <circle cx="32" cy="11" r="1.5" fill={`url(#${ids.chromeGradient})`} />
      <path d="M32 12.5V14.2" stroke={`url(#${ids.chromeGradient})`} strokeWidth="1.4" strokeLinecap="round" />
    </IconShell>
  );
}

export function PremiumAIAssistantIcon(props: PremiumIconProps) {
  const ids = useSharedIconIds('premium-ai');

  return (
    <IconShell {...props} defs={<SharedIconDefs ids={ids} />}>
      <circle cx="32" cy="36" r="15" fill={`url(#${ids.brightGlowGradient})`} opacity="0.28" />
      <path d="M18 37C18 24.8 24.4 17 32 17C39.6 17 46 24.8 46 37V40C42.6 44 37.8 46.4 32 46.4C26.2 46.4 21.4 44 18 40V37Z" fill={`url(#${ids.panelGradient})`} stroke={`url(#${ids.panelStrokeGradient})`} strokeWidth="1.6" filter={`url(#${ids.shadowFilter})`} />
      <path d="M22 24C24.8 20.8 28.2 19 32 19C35.8 19 39.2 20.8 42 24V31H22V24Z" fill={`url(#${ids.accentAltGradient})`} opacity="0.95" />
      <rect x="22" y="24" width="20" height="16" rx="7" fill="var(--premium-icon-face, rgba(24, 33, 82, 0.95))" stroke={`url(#${ids.chromeGradient})`} strokeWidth="1.6" />
      <circle cx="28" cy="31" r="2.3" fill={`url(#${ids.accentGradient})`} />
      <circle cx="36" cy="31" r="2.3" fill={`url(#${ids.accentGradient})`} />
      <circle cx="28" cy="31" r="5.2" fill={`url(#${ids.softGlowGradient})`} opacity="0.65" />
      <circle cx="36" cy="31" r="5.2" fill={`url(#${ids.softGlowGradient})`} opacity="0.65" />
      <path d="M28 37C30.1 38.2 33.9 38.2 36 37" stroke={`url(#${ids.chromeGradient})`} strokeWidth="1.8" strokeLinecap="round" />
      <path d="M25 42L32 46.4L39 42" stroke={`url(#${ids.panelStrokeGradient})`} strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="16" y="25" width="4" height="11" rx="2" fill={`url(#${ids.accentGradient})`} />
      <rect x="44" y="25" width="4" height="11" rx="2" fill={`url(#${ids.accentGradient})`} />
      <circle cx="18" cy="30" r="5" fill={`url(#${ids.softGlowGradient})`} opacity="0.7" />
      <circle cx="46" cy="30" r="5" fill={`url(#${ids.softGlowGradient})`} opacity="0.7" />
      <path d="M18 45L26 41" stroke={`url(#${ids.accentGradient})`} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M46 45L38 41" stroke={`url(#${ids.accentGradient})`} strokeWidth="1.6" strokeLinecap="round" />
      <CornerSpark x={14} y={47} r={1.5} glowId={ids.brightGlowGradient} fillId={ids.accentAltGradient} />
      <CornerSpark x={50} y={47} r={1.5} glowId={ids.softGlowGradient} fillId={ids.accentGradient} />
      <CornerSpark x={22} y={49} r={1.6} glowId={ids.softGlowGradient} fillId={ids.accentGradient} />
      <CornerSpark x={42} y={49} r={1.6} glowId={ids.brightGlowGradient} fillId={ids.accentAltGradient} />
    </IconShell>
  );
}

export function PremiumCodeGenerationIcon(props: PremiumIconProps) {
  const ids = useSharedIconIds('premium-code');

  return (
    <IconShell {...props} defs={<SharedIconDefs ids={ids} />}>
      <circle cx="32" cy="32" r="21" fill={`url(#${ids.softGlowGradient})`} opacity="0.16" />
      <path d="M17 21L11 32L17 43" stroke={`url(#${ids.accentAltGradient})`} strokeWidth="3.8" strokeLinecap="round" strokeLinejoin="round" filter={`url(#${ids.shadowFilter})`} />
      <path d="M47 21L53 32L47 43" stroke={`url(#${ids.accentAltGradient})`} strokeWidth="3.8" strokeLinecap="round" strokeLinejoin="round" filter={`url(#${ids.shadowFilter})`} />
      <path d="M28 46L39 18" stroke={`url(#${ids.panelStrokeGradient})`} strokeWidth="2.2" strokeLinecap="round" opacity="0.28" />
      <path d="M34 21L40 27" stroke={`url(#${ids.chromeGradient})`} strokeWidth="1.6" strokeLinecap="round" opacity="0.85" />
      <path d="M40 27L34 44" stroke={`url(#${ids.panelStrokeGradient})`} strokeWidth="5.2" strokeLinecap="round" filter={`url(#${ids.shadowFilter})`} />
      <rect x="37.2" y="24.2" width="9.5" height="4.5" rx="2.2" transform="rotate(45 37.2 24.2)" fill={`url(#${ids.accentGradient})`} />
      <path d="M43.5 18.8L45.2 17.1" stroke={`url(#${ids.chromeGradient})`} strokeWidth="2" strokeLinecap="round" />
      <path d="M46.6 21.2H49" stroke={`url(#${ids.chromeGradient})`} strokeWidth="2" strokeLinecap="round" />
      <path d="M43.8 24.7L45.5 26.5" stroke={`url(#${ids.chromeGradient})`} strokeWidth="2" strokeLinecap="round" />
      <path d="M50 19L51 17" stroke={`url(#${ids.chromeGradient})`} strokeWidth="1.4" strokeLinecap="round" />
      <path d="M30 44L34.5 39.5L38.5 43.5L34 48" fill={`url(#${ids.accentGradient})`} opacity="0.9" />
      <path d="M34.5 39.5L38.5 43.5" stroke={`url(#${ids.chromeGradient})`} strokeWidth="1.5" strokeLinecap="round" />
      <CornerSpark x={49} y={29} r={1.5} glowId={ids.brightGlowGradient} fillId={ids.chromeGradient} />
      <CornerSpark x={53} y={24} r={1.2} glowId={ids.softGlowGradient} fillId={ids.accentGradient} />
      <CornerSpark x={46} y={16} r={1.3} glowId={ids.softGlowGradient} fillId={ids.chromeGradient} />
    </IconShell>
  );
}

export function PremiumWorkflowIcon(props: PremiumIconProps) {
  const ids = useSharedIconIds('premium-workflow');

  return (
    <IconShell {...props} defs={<SharedIconDefs ids={ids} />}>
      <circle cx="18" cy="17" r="7.5" fill={`url(#${ids.softGlowGradient})`} opacity="0.3" />
      <circle cx="46" cy="17" r="7.5" fill={`url(#${ids.brightGlowGradient})`} opacity="0.28" />
      <circle cx="32" cy="43" r="8.5" fill={`url(#${ids.softGlowGradient})`} opacity="0.32" />
      <circle cx="18" cy="17" r="5.4" fill="var(--premium-icon-node-fill, rgba(31, 42, 101, 0.92))" stroke={`url(#${ids.accentGradient})`} strokeWidth="2" />
      <circle cx="46" cy="17" r="5.4" fill="var(--premium-icon-node-fill, rgba(31, 42, 101, 0.92))" stroke={`url(#${ids.accentGradient})`} strokeWidth="2" />
      <circle cx="32" cy="43" r="6" fill="var(--premium-icon-node-fill, rgba(31, 42, 101, 0.92))" stroke={`url(#${ids.accentAltGradient})`} strokeWidth="2" />
      <path d="M22 20L28.8 34.2" stroke={`url(#${ids.accentAltGradient})`} strokeWidth="2.4" strokeLinecap="round" />
      <path d="M42 20L35.2 34.2" stroke={`url(#${ids.accentAltGradient})`} strokeWidth="2.4" strokeLinecap="round" />
      <path d="M25 17H38" stroke={`url(#${ids.chromeGradient})`} strokeWidth="1.7" strokeLinecap="round" opacity="0.85" />
      <path d="M37 17L40 14" stroke={`url(#${ids.chromeGradient})`} strokeWidth="1.7" strokeLinecap="round" />
      <path d="M37 17L40 20" stroke={`url(#${ids.chromeGradient})`} strokeWidth="1.7" strokeLinecap="round" />
      <path d="M25.2 31.2L28.3 33" stroke={`url(#${ids.chromeGradient})`} strokeWidth="1.5" strokeLinecap="round" />
      <path d="M38.8 31.2L35.7 33" stroke={`url(#${ids.chromeGradient})`} strokeWidth="1.5" strokeLinecap="round" />
      <CornerSpark x={12} y={23} r={1.3} glowId={ids.softGlowGradient} fillId={ids.accentGradient} />
      <CornerSpark x={52} y={12} r={1.4} glowId={ids.brightGlowGradient} fillId={ids.accentAltGradient} />
      <CornerSpark x={38} y={48} r={1.3} glowId={ids.softGlowGradient} fillId={ids.chromeGradient} />
    </IconShell>
  );
}

export function PremiumSearchRAGIcon(props: PremiumIconProps) {
  const ids = useSharedIconIds('premium-search');

  return (
    <IconShell {...props} defs={<SharedIconDefs ids={ids} />}>
      <path d="M16 18H34C35.7 18 37 19.3 37 21V41C37 42.7 35.7 44 34 44H16C14.3 44 13 42.7 13 41V21C13 19.3 14.3 18 16 18Z" fill={`url(#${ids.panelGradient})`} stroke={`url(#${ids.panelStrokeGradient})`} strokeWidth="1.8" filter={`url(#${ids.shadowFilter})`} />
      <path d="M20 25H30" stroke={`url(#${ids.chromeGradient})`} strokeWidth="2.1" strokeLinecap="round" />
      <path d="M20 31H31" stroke={`url(#${ids.accentAltGradient})`} strokeWidth="2" strokeLinecap="round" opacity="0.9" />
      <path d="M20 37H27" stroke={`url(#${ids.accentAltGradient})`} strokeWidth="2" strokeLinecap="round" opacity="0.75" />
      <path d="M19 15H37C38.7 15 40 16.3 40 18V38" stroke={`url(#${ids.accentAltGradient})`} strokeWidth="1.8" strokeLinecap="round" opacity="0.75" />
      <circle cx="38" cy="34" r="11" fill={`url(#${ids.softGlowGradient})`} opacity="0.3" />
      <circle cx="38" cy="34" r="8.2" fill="var(--premium-icon-lens-fill, rgba(20, 28, 72, 0.65))" stroke={`url(#${ids.chromeGradient})`} strokeWidth="2.3" />
      <path d="M43.7 39.7L49.5 45.5" stroke={`url(#${ids.accentGradient})`} strokeWidth="4" strokeLinecap="round" />
      <path d="M48.2 41.2C49.7 40.6 51.5 41 52.6 42.2C53.9 43.5 53.9 45.7 52.6 47C51.3 48.3 49.1 48.3 47.8 47" stroke={`url(#${ids.accentGradient})`} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
      <path d="M34 34H42" stroke={`url(#${ids.chromeGradient})`} strokeWidth="1.9" strokeLinecap="round" />
      <CornerSpark x={51} y={45} r={1.6} glowId={ids.brightGlowGradient} fillId={ids.accentGradient} />
    </IconShell>
  );
}

export function PremiumSecureModeIcon(props: PremiumIconProps) {
  const ids = useSharedIconIds('premium-secure');

  return (
    <IconShell {...props} defs={<SharedIconDefs ids={ids} />}>
      <path d="M17 16H24" stroke={`url(#${ids.accentAltGradient})`} strokeWidth="2.3" strokeLinecap="round" />
      <path d="M17 16V23" stroke={`url(#${ids.accentAltGradient})`} strokeWidth="2.3" strokeLinecap="round" />
      <path d="M47 16H40" stroke={`url(#${ids.accentAltGradient})`} strokeWidth="2.3" strokeLinecap="round" />
      <path d="M47 16V23" stroke={`url(#${ids.accentAltGradient})`} strokeWidth="2.3" strokeLinecap="round" />
      <path d="M17 48H24" stroke={`url(#${ids.accentAltGradient})`} strokeWidth="2.3" strokeLinecap="round" />
      <path d="M17 48V41" stroke={`url(#${ids.accentAltGradient})`} strokeWidth="2.3" strokeLinecap="round" />
      <path d="M47 48H40" stroke={`url(#${ids.accentAltGradient})`} strokeWidth="2.3" strokeLinecap="round" />
      <path d="M47 48V41" stroke={`url(#${ids.accentAltGradient})`} strokeWidth="2.3" strokeLinecap="round" />
      <path d="M32 16L44 21V31.5C44 39 39.3 44 32 47C24.7 44 20 39 20 31.5V21L32 16Z" fill={`url(#${ids.panelGradient})`} stroke={`url(#${ids.chromeGradient})`} strokeWidth="1.8" filter={`url(#${ids.shadowFilter})`} />
      <path d="M32 19.7L40.4 23.2V31C40.4 36.5 37.4 40.5 32 42.9C26.6 40.5 23.6 36.5 23.6 31V23.2L32 19.7Z" fill={`url(#${ids.accentAltGradient})`} opacity="0.22" />
      <rect x="27" y="29.2" width="10" height="8.5" rx="2.1" fill="var(--premium-icon-lock-body, rgba(29, 39, 94, 0.96))" stroke={`url(#${ids.chromeGradient})`} strokeWidth="1.6" />
      <path d="M29.4 29V26.8C29.4 25.3 30.6 24.1 32.1 24.1C33.6 24.1 34.8 25.3 34.8 26.8V29" stroke={`url(#${ids.chromeGradient})`} strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="45.5" cy="31.5" r="4.8" fill={`url(#${ids.softGlowGradient})`} opacity="0.8" />
      <circle cx="45.5" cy="31.5" r="1.8" fill={`url(#${ids.chromeGradient})`} />
    </IconShell>
  );
}

export function PremiumRunExecutionIcon(props: PremiumIconProps) {
  const ids = useSharedIconIds('premium-run');

  return (
    <IconShell {...props} defs={<SharedIconDefs ids={ids} />}>
      <rect x="10" y="20" width="40" height="22" rx="5" fill={`url(#${ids.panelGradient})`} stroke={`url(#${ids.panelStrokeGradient})`} strokeWidth="1.8" filter={`url(#${ids.shadowFilter})`} />
      <path d="M22 26L31 31L22 36V26Z" fill={`url(#${ids.chromeGradient})`} />
      <path d="M35.2 27.2L39 31L35.2 34.8" stroke={`url(#${ids.accentAltGradient})`} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M42.8 27.2L46.6 31L42.8 34.8" stroke={`url(#${ids.accentAltGradient})`} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M49.5 35.5L52.5 29.4L46.5 29.6L49.3 24L39.8 34H45L42.6 40.1L49.5 35.5Z" fill={`url(#${ids.accentGradient})`} />
      <rect x="50" y="25" width="3.5" height="12" rx="1.2" fill={`url(#${ids.chromeGradient})`} />
      <path d="M54 27H58.5C60.4 27 62 28.6 62 30.5V31.5C62 33.4 60.4 35 58.5 35H54" stroke={`url(#${ids.accentAltGradient})`} strokeWidth="2" strokeLinecap="round" />
      <path d="M58.2 31H61.2" stroke={`url(#${ids.accentGradient})`} strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="58" cy="31" r="6" fill={`url(#${ids.softGlowGradient})`} opacity="0.45" />
    </IconShell>
  );
}

export function PremiumPluginToolsIcon(props: PremiumIconProps) {
  const ids = useSharedIconIds('premium-plugin');

  return (
    <IconShell {...props} defs={<SharedIconDefs ids={ids} />}>
      <path d="M19 16H26C26 12.7 28.7 10 32 10C35.3 10 38 12.7 38 16H45V25C48.3 25 51 27.7 51 31C51 34.3 48.3 37 45 37V46H36C36 42.7 33.3 40 30 40C26.7 40 24 42.7 24 46H19V37C15.7 37 13 34.3 13 31C13 27.7 15.7 25 19 25V16Z" fill={`url(#${ids.panelGradient})`} stroke={`url(#${ids.panelStrokeGradient})`} strokeWidth="1.8" filter={`url(#${ids.shadowFilter})`} />
      <path d="M33 22H38.5C40.4 22 42 23.6 42 25.5V30" stroke={`url(#${ids.chromeGradient})`} strokeWidth="2" strokeLinecap="round" />
      <path d="M27 31H21.5C19.6 31 18 32.6 18 34.5V39" stroke={`url(#${ids.chromeGradient})`} strokeWidth="2" strokeLinecap="round" />
      <rect x="34.5" y="27.5" width="11.5" height="13" rx="2.8" fill={`url(#${ids.accentGradient})`} />
      <path d="M46 31.5H49.5C50.9 31.5 52 32.6 52 34V34C52 35.4 50.9 36.5 49.5 36.5H46" stroke={`url(#${ids.chromeGradient})`} strokeWidth="2" strokeLinecap="round" />
      <path d="M52 30L55.5 26.5" stroke={`url(#${ids.accentGradient})`} strokeWidth="2.4" strokeLinecap="round" />
      <path d="M54.5 33H59" stroke={`url(#${ids.accentGradient})`} strokeWidth="2.4" strokeLinecap="round" />
      <path d="M52 36L55.5 39.5" stroke={`url(#${ids.accentGradient})`} strokeWidth="2.4" strokeLinecap="round" />
      <CornerSpark x={57} y={26} r={1.7} glowId={ids.softGlowGradient} fillId={ids.accentGradient} />
      <CornerSpark x={59} y={33} r={1.6} glowId={ids.brightGlowGradient} fillId={ids.chromeGradient} />
      <CornerSpark x={56.5} y={40} r={1.5} glowId={ids.softGlowGradient} fillId={ids.accentAltGradient} />
    </IconShell>
  );
}

export const premiumWorkbenchIconCatalog = [
  { name: 'Junior Workbench', Icon: PremiumJuniorWorkbenchIcon },
  { name: 'AI Assistant', Icon: PremiumAIAssistantIcon },
  { name: 'Code Generation', Icon: PremiumCodeGenerationIcon },
  { name: 'Workflow Orchestration', Icon: PremiumWorkflowIcon },
  { name: 'Search & RAG', Icon: PremiumSearchRAGIcon },
  { name: 'Secure Mode', Icon: PremiumSecureModeIcon },
  { name: 'Run Execution', Icon: PremiumRunExecutionIcon },
  { name: 'Plugin / Tools', Icon: PremiumPluginToolsIcon }
] as const;