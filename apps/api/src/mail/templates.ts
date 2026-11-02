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

function render(name: string, l: Layout): { text: string; html: string } {
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

  sharedWithYou(name: string, sharer: string, title: string, level: string, expiresAt: Date | null, url: string) {
    const can = level === 'READ' ? 'read' : level === 'EDIT' ? 'edit' : 'manage';
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
};
