// Plain, branded account emails. Every value placed in HTML is escaped.
// Links are always built from PUBLIC_ORIGIN, never from the request's Host
// header, so nobody can make the server email a link to their own site.

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

interface Layout {
  title: string;
  intro: string;
  lines?: string[];
  button?: { label: string; url: string };
  footer: string;
}

export function render(name: string, l: Layout): { text: string; html: string } {
  const text = [
    `Hi ${name},`,
    '',
    l.intro,
    ...(l.lines?.length ? ['', ...l.lines] : []),
    ...(l.button ? ['', `${l.button.label}: ${l.button.url}`] : []),
    '',
    l.footer,
    '',
    '— TrustVault',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f8fafc;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px">
<tr><td style="padding:22px 28px;border-bottom:1px solid #f1f5f9;font-size:17px;font-weight:600">Trust<span style="color:#6d4ce0">Vault</span></td></tr>
<tr><td style="padding:24px 28px">
<h1 style="margin:0 0 12px;font-size:20px;font-weight:600">${esc(l.title)}</h1>
<p style="margin:0 0 12px;font-size:14px;line-height:22px">Hi ${esc(name)},</p>
<p style="margin:0 0 12px;font-size:14px;line-height:22px">${esc(l.intro)}</p>
${(l.lines ?? []).map((x) => `<p style="margin:0 0 6px;font-size:13px;line-height:20px;color:#475569">${esc(x)}</p>`).join('')}
${l.button ? `<p style="margin:22px 0"><a href="${esc(l.button.url)}" style="display:inline-block;background:#5546e0;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 20px;border-radius:10px">${esc(l.button.label)}</a></p><p style="margin:0 0 12px;font-size:12px;color:#64748b;word-break:break-all">${esc(l.button.url)}</p>` : ''}
<p style="margin:18px 0 0;font-size:12px;line-height:18px;color:#64748b">${esc(l.footer)}</p>
</td></tr></table>
<p style="font-size:11px;color:#94a3b8;margin:14px 0 0">Sent by TrustVault. You get this because you have an account.</p>
</td></tr></table></body></html>`;
  return { text, html };
}

const when = (d: Date) => d.toUTCString();

export const mailTemplates = {
  signInLink(name: string, url: string, minutes: number, ip: string | null, at: Date) {
    return {
      subject: 'Confirm your TrustVault sign-in',
      ...render(name, {
        title: 'Confirm it’s you signing in',
        intro: 'Someone signed in to your TrustVault account with the right password from a device it has not used before. Your account has had many failed sign-in attempts recently, so we need one more step.',
        lines: [`When: ${when(at)}`, `From: ${ip ?? 'unknown address'}`, `If this was you, open the link on the device you are signing in on. It works once and expires in ${minutes} minutes.`],
        button: { label: 'Finish signing in', url },
        footer: 'If this was not you, do not open the link: someone knows your password. Reset it now from the sign-in page (Forgot password?).',
      }),
    };
  },
  resetLink(name: string, url: string, minutes: number, byAdmin: boolean) {
    return {
      subject: 'Reset your TrustVault password',
      ...render(name, {
        title: 'Reset your password',
        intro: byAdmin
          ? 'An administrator asked TrustVault to send you a password reset link. Nobody but you will see your new password.'
          : 'Someone (hopefully you) asked to reset your TrustVault password.',
        button: { label: 'Choose a new password', url },
        lines: [`The link works once and expires in ${minutes} minutes. Your second factor is still needed when you sign in.`],
        footer: "If you didn't ask for this, ignore this email: your password stays as it is.",
      }),
    };
  },

  invitation(name: string, url: string, role: string, hours: number, accessEndsAt: Date | null) {
    const as = role === 'ADMIN' ? 'an administrator' : role === 'OWNER' ? 'a document owner' : role === 'EXTERNAL' ? 'an external guest (read-only)' : 'a viewer';
    return {
      subject: "You've been invited to TrustVault",
      ...render(name, {
        title: "You've been invited to TrustVault",
        intro: `An administrator created a TrustVault account for you, as ${as}. Choose your name and password to start using it.`,
        button: { label: 'Accept the invitation', url },
        lines: [
          `The link works once and expires in ${hours} hours. Nobody else, not even the administrator, will know your password.`,
          ...(accessEndsAt ? [`Your access ends ${when(accessEndsAt)}.`] : []),
          ...(role === 'ADMIN' ? ['Administrators set up a second factor (an authenticator app or passkey) the first time they sign in.'] : []),
        ],
        footer: "If you weren't expecting this, ignore this email: the account stays unused and the link expires.",
      }),
    };
  },

  welcome(name: string, origin: string) {
    return {
      subject: 'Your TrustVault account is ready',
      ...render(name, {
        title: 'Your account is ready',
        intro: 'You accepted your invitation and chose a password. You can now sign in.',
        button: { label: 'Sign in', url: `${origin}/login` },
        footer: "If this wasn't you, tell your administrator now.",
      }),
    };
  },

  passwordChanged(name: string, how: string, at: Date, origin: string) {
    return {
      subject: 'Your TrustVault password was changed',
      ...render(name, {
        title: 'Your password was changed',
        intro: `Your password was changed ${how}, and every session was signed out.`,
        lines: [`When: ${when(at)}`],
        button: { label: 'Sign in', url: `${origin}/login` },
        footer: "If this wasn't you, reset your password now and tell your administrator.",
      }),
    };
  },

  newSignIn(name: string, at: Date, ip: string | null, device: string | null, origin: string) {
    return {
      subject: 'New sign-in to TrustVault',
      ...render(name, {
        title: 'New sign-in to your account',
        intro: 'Your account was just signed in to.',
        lines: [`When: ${when(at)}`, `From: ${ip ?? 'unknown address'}`, `Device: ${(device ?? 'unknown').slice(0, 140)}`],
        button: { label: "This wasn't me: reset my password", url: `${origin}/forgot` },
        footer: 'If it was you, there is nothing to do.',
      }),
    };
  },

  secondFactorChanged(name: string, what: string, at: Date, origin: string) {
    return {
      subject: 'Your TrustVault sign-in security changed',
      ...render(name, {
        title: 'Your second factor changed',
        intro: what,
        lines: [`When: ${when(at)}`],
        button: { label: 'Review your account', url: `${origin}/account` },
        footer: "If this wasn't you, reset your password now and tell your administrator.",
      }),
    };
  },

  breakGlassApproved(name: string, title: string, requester: string, approver: string, reason: string, url: string) {
    return {
      subject: 'Emergency access to your document was approved',
      ...render(name, {
        title: 'An administrator may open your document',
        intro: `${approver} approved ${requester}'s request for one hour of emergency read access to “${title}”.`,
        lines: [`Reason given: ${reason}`, 'The hour starts when they use it. Every open and download is in the document’s history.'],
        button: { label: 'See the document’s history', url },
        footer: 'If you did not expect this, tell your security contact.',
      }),
    };
  },

  captureAttempt(name: string, who: string, whoEmail: string, title: string, method: string, at: Date, url: string) {
    return {
      subject: `Someone tried to capture “${title}”`,
      ...render(name, {
        title: 'Someone tried to take a screenshot of your document',
        intro: `${who} (${whoEmail}) pressed a screen-capture key while viewing “${title}”.`,
        lines: [
          `When: ${when(at)}`,
          `How: ${method}`,
          'The page was blanked for a moment, and they were not told about this report. A web page cannot block an operating-system screenshot or a camera, so a picture may still have been taken: every page carries their name, the time and a trace code.',
          'You get at most one email an hour per person and document; every attempt is in the document’s history.',
        ],
        button: { label: 'See the document’s history', url },
        footer: 'If this is unexpected, consider removing their access or talking to your security contact.',
      }),
    };
  },

  sharedWithYou(name: string, sharer: string, title: string, level: string, expiresAt: Date | null, url: string) {
    const can = level === 'VIEW' ? 'view (but not download)' : level === 'READ' ? 'read and download' : level === 'EDIT' ? 'edit' : 'manage';
    return {
      subject: `${sharer} shared a document with you`,
      ...render(name, {
        title: 'A document was shared with you',
        intro: `${sharer} gave you access to “${title}”. You can ${can} it.`,
        lines: expiresAt ? [`Your access ends ${when(expiresAt)}.`] : [],
        button: { label: 'Open in TrustVault', url },
        footer: 'Every time you open or download it is recorded in its history.',
      }),
    };
  },

  downloadRequested(name: string, requester: string, title: string, versionNo: number, reason: string, url: string) {
    return {
      subject: `${requester} asks to download “${title}”`,
      ...render(name, {
        title: 'A download is waiting for your approval',
        intro: `${requester} asked to download version ${versionNo} of “${title}”.`,
        lines: [`Their reason: ${reason.slice(0, 500)}`],
        button: { label: 'Review the request', url },
        footer: 'Approve only if you expected this. Nothing is downloaded until you approve, and every use is recorded.',
      }),
    };
  },

  downloadDecided(name: string, decider: string, title: string, versionNo: number, approved: boolean, validUntil: Date | null, uses: number | null, note: string | null, url: string) {
    return {
      subject: approved ? `Download approved: “${title}”` : `Download not approved: “${title}”`,
      ...render(name, {
        title: approved ? 'Your download was approved' : 'Your download was not approved',
        intro: approved
          ? `${decider} approved your request to download version ${versionNo} of “${title}”.`
          : `${decider} did not approve your request to download version ${versionNo} of “${title}”.`,
        lines: [
          ...(approved && validUntil ? [`You can download it ${uses === 1 ? 'once' : `${uses} times`} until ${when(validUntil)}.`] : []),
          ...(note ? [`Note: ${note.slice(0, 500)}`] : []),
        ],
        button: { label: 'Open in TrustVault', url },
        footer: 'Every download is recorded in the document history.',
      }),
    };
  },

  overrideGiven(name: string, owner: string, title: string, until: Date, reason: string, url: string) {
    return {
      subject: `Temporary exception on “${title}”`,
      ...render(name, {
        title: 'You were given a temporary exception',
        intro: `${owner} lifted the time, network and download-approval conditions of your share of “${title}” until ${when(until)}.`,
        lines: [`Reason given: ${reason.slice(0, 500)}`],
        button: { label: 'Open in TrustVault', url },
        footer: 'Everything you do with it is recorded. Organisation-wide rules for your role still apply.',
      }),
    };
  },

  overrideReceipt(name: string, person: string, title: string, until: Date, reason: string, url: string) {
    return {
      subject: `You gave an exception on “${title}”`,
      ...render(name, {
        title: 'Receipt: emergency exception',
        intro: `You lifted the conditions of ${person}'s share of “${title}” until ${when(until)}.`,
        lines: [`Reason: ${reason.slice(0, 500)}`],
        button: { label: 'Review access', url },
        footer: "If this wasn't you, end the exception from the share sheet and change your password now.",
      }),
    };
  },
};
