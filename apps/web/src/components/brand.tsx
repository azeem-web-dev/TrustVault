'use client';

import { useId } from 'react';

export function Logo({ size = 28 }: { size?: number }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 32 32">
      <defs>
        <linearGradient id={`${id}-l`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6366f1" />
          <stop offset="1" stopColor="#a855f7" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${id}-l)`} />
      <rect width="32" height="16" rx="9" fill="#fff" fillOpacity="0.12" />
      <path d="M16 6.5 L23.5 9.3 V15.6 C23.5 20.3 20.4 23.6 16 25.5 C11.6 23.6 8.5 20.3 8.5 15.6 V9.3 Z" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M12.6 15.8 L15.1 18.3 L19.6 13.6" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 font-semibold tracking-tight ${className ?? ''}`}>
      <Logo />
      <span className="text-[1.0625rem]">Trust<span className="text-gradient">Vault</span></span>
    </span>
  );
}
