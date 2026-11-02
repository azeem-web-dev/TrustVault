'use client';

import type { ReactNode } from 'react';
import { IconContext } from '@phosphor-icons/react';
import { SessionProvider } from './session';
import { StepUpProvider } from './step-up';
import { ThemeProvider } from './theme';
import { ToastProvider } from './toast';

const ICONS = { weight: 'duotone', size: 18, 'aria-hidden': true } as const;

export function Providers({ children }: { children: ReactNode }) {
  return (
    <IconContext.Provider value={ICONS}>
      <ThemeProvider>
        <ToastProvider>
          <SessionProvider>
            <StepUpProvider>{children}</StepUpProvider>
          </SessionProvider>
        </ToastProvider>
      </ThemeProvider>
    </IconContext.Provider>
  );
}
