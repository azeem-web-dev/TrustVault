'use client';

import { useId, type ReactNode } from 'react';

/**
 * Hand-drawn SVG illustrations. Inline (no image requests), so they work
 * under the strict Content-Security-Policy and follow light/dark themes.
 */

/** Sign-in hero: a vault shield, documents locked to it, and the hash chain beneath. */
export function VaultHero({ className }: { className?: string }) {
  const id = useId().replace(/:/g, '');
  const g = (n: string) => `${id}-${n}`;
  return (
    <svg viewBox="0 0 480 400" className={className} role="img" aria-label="Documents locked inside a vault, linked by a chain of signed records">
      <defs>
        <linearGradient id={g('shield')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a5b4fc" />
          <stop offset="0.5" stopColor="#818cf8" />
          <stop offset="1" stopColor="#c084fc" />
        </linearGradient>
        <linearGradient id={g('shieldIn')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#312e81" />
          <stop offset="1" stopColor="#1e1b4b" />
        </linearGradient>
        <linearGradient id={g('card')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.22" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0.06" />
        </linearGradient>
        <radialGradient id={g('glow')} cx="0.5" cy="0.45" r="0.5">
          <stop offset="0" stopColor="#a78bfa" stopOpacity="0.55" />
          <stop offset="1" stopColor="#a78bfa" stopOpacity="0" />
        </radialGradient>
        <filter id={g('blur')} x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="0.6" /></filter>
      </defs>

      <circle cx="240" cy="175" r="170" fill={`url(#${g('glow')})`} />
      <g fill="none" stroke="#c7d2fe" strokeOpacity="0.25">
        <ellipse cx="240" cy="175" rx="185" ry="70" />
        <ellipse cx="240" cy="175" rx="140" ry="135" strokeDasharray="3 7" className="animate-dash" />
      </g>

      {/* floating document cards */}
      <g className="animate-float" style={{ animationDelay: '-1s' }}>
        <g transform="translate(52 92) rotate(-10)">
          <rect width="92" height="116" rx="12" fill={`url(#${g('card')})`} stroke="#ffffff" strokeOpacity="0.35" />
          <rect x="14" y="18" width="38" height="6" rx="3" fill="#fda4af" />
          <rect x="14" y="34" width="64" height="4" rx="2" fill="#fff" fillOpacity="0.5" />
          <rect x="14" y="44" width="56" height="4" rx="2" fill="#fff" fillOpacity="0.35" />
          <rect x="14" y="54" width="60" height="4" rx="2" fill="#fff" fillOpacity="0.35" />
          <rect x="14" y="78" width="30" height="22" rx="5" fill="#fb7185" fillOpacity="0.8" />
          <text x="29" y="93" textAnchor="middle" fontSize="9" fontWeight="700" fill="#fff" fontFamily="sans-serif">PDF</text>
        </g>
      </g>
      <g className="animate-float" style={{ animationDelay: '-3.5s' }}>
        <g transform="translate(338 70) rotate(9)">
          <rect width="92" height="116" rx="12" fill={`url(#${g('card')})`} stroke="#ffffff" strokeOpacity="0.35" />
          <rect x="14" y="18" width="44" height="6" rx="3" fill="#86efac" />
          <g fill="#fff" fillOpacity="0.35">
            <rect x="14" y="34" width="20" height="10" rx="2" /><rect x="38" y="34" width="20" height="10" rx="2" /><rect x="62" y="34" width="16" height="10" rx="2" />
            <rect x="14" y="48" width="20" height="10" rx="2" /><rect x="38" y="48" width="20" height="10" rx="2" /><rect x="62" y="48" width="16" height="10" rx="2" />
            <rect x="14" y="62" width="20" height="10" rx="2" /><rect x="38" y="62" width="20" height="10" rx="2" /><rect x="62" y="62" width="16" height="10" rx="2" />
          </g>
          <rect x="14" y="82" width="30" height="20" rx="5" fill="#22c55e" fillOpacity="0.85" />
          <text x="29" y="96" textAnchor="middle" fontSize="9" fontWeight="700" fill="#fff" fontFamily="sans-serif">XLS</text>
        </g>
      </g>
      <g className="animate-float" style={{ animationDelay: '-5s' }}>
        <g transform="translate(350 214) rotate(-6)">
          <rect width="78" height="96" rx="11" fill={`url(#${g('card')})`} stroke="#ffffff" strokeOpacity="0.3" />
          <rect x="12" y="16" width="34" height="5" rx="2.5" fill="#93c5fd" />
          <rect x="12" y="29" width="54" height="4" rx="2" fill="#fff" fillOpacity="0.45" />
          <rect x="12" y="38" width="46" height="4" rx="2" fill="#fff" fillOpacity="0.3" />
          <rect x="12" y="64" width="28" height="19" rx="5" fill="#3b82f6" fillOpacity="0.85" />
          <text x="26" y="77" textAnchor="middle" fontSize="8.5" fontWeight="700" fill="#fff" fontFamily="sans-serif">DOC</text>
        </g>
      </g>

      {/* connector lines from cards to the shield */}
      <g stroke="#c7d2fe" strokeOpacity="0.55" strokeWidth="1.5" fill="none" strokeDasharray="4 5" className="animate-dash">
        <path d="M140 160 C 175 165, 185 170, 200 172" />
        <path d="M345 140 C 310 150, 300 160, 282 168" />
        <path d="M352 255 C 320 240, 300 220, 282 205" />
      </g>

      {/* the shield */}
      <g>
        <path d="M240 62 L320 92 V168 C320 222 286 258 240 278 C194 258 160 222 160 168 V92 Z" fill={`url(#${g('shield')})`} />
        <path d="M240 76 L308 101 V168 C308 214 279 245 240 263 C201 245 172 214 172 168 V101 Z" fill={`url(#${g('shieldIn')})`} />
        <path d="M240 76 L308 101 V130 C270 120 220 140 172 128 V101 Z" fill="#fff" fillOpacity="0.06" />
        {/* lock */}
        <path d="M222 160 V146 a18 18 0 0 1 36 0 V160" fill="none" stroke="#c7d2fe" strokeWidth="7" strokeLinecap="round" />
        <rect x="208" y="158" width="64" height="52" rx="12" fill="#e0e7ff" />
        <circle cx="240" cy="178" r="7" fill="#4338ca" />
        <rect x="236.5" y="181" width="7" height="14" rx="3.5" fill="#4338ca" />
      </g>

      {/* check badge */}
      <g transform="translate(296 236)">
        <circle r="17" fill="#10b981" stroke="#fff" strokeOpacity="0.9" strokeWidth="3" />
        <path d="M-7 0 L-2 5 L8 -5" stroke="#fff" strokeWidth="3.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </g>

      {/* hash chain */}
      <g transform="translate(64 318)">
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i} transform={`translate(${i * 72} 0)`}>
            {i > 0 && <path d="M-16 20 H0" stroke="#a5b4fc" strokeWidth="2.5" strokeOpacity="0.7" />}
            <rect width="56" height="40" rx="10" fill="#ffffff" fillOpacity={i === 4 ? 0.22 : 0.1} stroke="#c7d2fe" strokeOpacity={i === 4 ? 0.9 : 0.4} />
            <rect x="10" y="11" width="24" height="4" rx="2" fill="#c7d2fe" fillOpacity="0.8" />
            <rect x="10" y="21" width="36" height="3" rx="1.5" fill="#fff" fillOpacity="0.35" />
            <rect x="10" y="28" width="18" height="3" rx="1.5" fill="#fff" fillOpacity="0.25" />
          </g>
        ))}
        <g transform="translate(334 -6)">
          <circle r="9" fill="#a78bfa" />
          <circle r="9" fill="none" stroke="#a78bfa" className="animate-pulse-ring" style={{ transformOrigin: 'center', transformBox: 'fill-box' }} />
        </g>
      </g>
    </svg>
  );
}

/** A row of linked blocks: the audit hash chain, drawn intact or broken. */
export function ChainArt({ ok = true, className }: { ok?: boolean; className?: string }) {
  const color = ok ? '#10b981' : '#ef4444';
  return (
    <svg viewBox="0 0 220 64" className={className} aria-hidden>
      {[0, 1, 2, 3].map((i) => {
        const broken = !ok && i === 2;
        return (
          <g key={i} transform={`translate(${6 + i * 54} 12)`}>
            {i > 0 && <path d={broken ? 'M-14 20 h5 m4 0 h5' : 'M-14 20 H0'} stroke={broken ? '#ef4444' : color} strokeWidth="3" strokeLinecap="round" opacity="0.7" />}
            <rect width="40" height="40" rx="10" fill={broken ? '#fee2e2' : ok ? '#d1fae5' : '#f1f5f9'} stroke={broken ? '#ef4444' : color} strokeOpacity="0.6" strokeWidth="1.5" />
            {broken ? (
              <path d="M14 14 L26 26 M26 14 L14 26" stroke="#ef4444" strokeWidth="3" strokeLinecap="round" />
            ) : (
              <path d="M13 20 L18 25 L28 15" stroke={color} strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            )}
          </g>
        );
      })}
    </svg>
  );
}

const SPOT_TONES = {
  brand: ['#6366f1', '#a855f7'],
  green: ['#10b981', '#14b8a6'],
  amber: ['#f59e0b', '#f97316'],
  red: ['#ef4444', '#f43f5e'],
  slate: ['#64748b', '#94a3b8'],
} as const;

/** Spot illustration for empty states: a glowing tile with an icon and small floating shapes. */
export function SpotArt({ icon, tone = 'brand' }: { icon: ReactNode; tone?: keyof typeof SPOT_TONES }) {
  const id = useId().replace(/:/g, '');
  const [a, b] = SPOT_TONES[tone];
  return (
    <div className="relative size-32">
      <svg viewBox="0 0 128 128" className="absolute inset-0" aria-hidden>
        <defs>
          <radialGradient id={`${id}-glow`} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor={a} stopOpacity="0.22" />
            <stop offset="1" stopColor={a} stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`${id}-tile`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={a} />
            <stop offset="1" stopColor={b} />
          </linearGradient>
        </defs>
        <circle cx="64" cy="64" r="62" fill={`url(#${id}-glow)`} />
        <circle cx="64" cy="64" r="46" fill="none" stroke={a} strokeOpacity="0.25" strokeDasharray="3 6" className="animate-dash" />
        <rect x="38" y="38" width="52" height="52" rx="16" fill={`url(#${id}-tile)`} />
        <rect x="38" y="38" width="52" height="26" rx="16" fill="#fff" fillOpacity="0.12" />
        <circle cx="22" cy="40" r="4" fill={b} fillOpacity="0.5" className="animate-float" />
        <rect x="100" y="28" width="10" height="10" rx="3" fill={a} fillOpacity="0.45" transform="rotate(20 105 33)" className="animate-float" style={{ animationDelay: '-2s' }} />
        <circle cx="104" cy="98" r="5" fill={a} fillOpacity="0.35" className="animate-float" style={{ animationDelay: '-4s' }} />
        <path d="M20 92 l4 4 m0 -4 l-4 4" stroke={b} strokeOpacity="0.6" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-white">{icon}</span>
    </div>
  );
}
