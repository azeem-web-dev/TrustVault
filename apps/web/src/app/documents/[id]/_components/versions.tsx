'use client';

import { useState, type FormEvent } from 'react';
import { Biohazard, CloudArrowUp, DownloadSimple, Prohibit, Stack, EyeSlash, HandPalm } from '@phosphor-icons/react';
import { removedNotice, type UploadResult } from '@/lib/sanitized';
import { Badge, Button, ButtonLink, Card, FileIcon, Input, Label, cx, relativeTime, staggerClass } from '@/components/ui';
import { api, errorText, formatBytes, formatDate } from '@/lib/api';
import type { Doc } from './types';

export function Versions({ doc, canDownload, canDownloadNow, needsApproval, canUpload, onUploaded, onError }: {
  doc: Doc; canDownload: boolean; canDownloadNow: boolean; needsApproval: boolean; canUpload: boolean;
  onUploaded: (removedNote: string | null) => void; onError: (m: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  // Remounts the file input so it clears after a successful upload (P9).
  const [inputKey, setInputKey] = useState(0);
  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    const form = new FormData();
    form.set('file', file);
    try {
      const r = await api.upload<UploadResult>(`/documents/${doc.id}/versions`, form);
      setFile(null);
      setInputKey((k) => k + 1);
      onUploaded(removedNotice(r?.sanitized?.removed));
    } catch (err) {
      onError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Versions" icon={<Stack size={20} />} description="Every version is kept, encrypted and hash-checked on download.">
      <ol className="relative space-y-1">
        {doc.versions.map((v, i) => (
          <li key={v.versionNo} className={cx('relative flex animate-rise gap-4 pb-4 last:pb-0', staggerClass(i))}>
            {i < doc.versions.length - 1 && <span className="absolute left-5 top-11 h-[calc(100%-2.75rem)] w-px bg-line-strong" />}
            <FileIcon fileName={v.fileName} />
            <div className={cx('min-w-0 flex-1 rounded-xl border p-3 transition', i === 0 ? 'border-brand-200 bg-brand-50/40 dark:border-brand-400/25 dark:bg-brand-500/5' : 'border-line', v.quarantine && 'border-danger-300/60 bg-danger-50/50 dark:border-danger-500/30 dark:bg-danger-500/5')}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    Version {v.versionNo}{i === 0 && <Badge tone="violet">Current</Badge>}
                  </p>
                  <p className="truncate text-xs text-fg-subtle" title={v.fileName}>{v.fileName} · {formatBytes(v.sizeBytes)} · by {v.uploadedBy}, {relativeTime(v.createdAt)}</p>
                </div>
                {v.quarantine ? (
                  <Badge tone="red" icon={<Prohibit size={11} />}>Download blocked</Badge>
                ) : !canDownload ? (
                  <Badge icon={<EyeSlash size={11} />}>View only</Badge>
                ) : !canDownloadNow ? (
                  // The API refuses this download (P5): say why instead of offering a link that fails.
                  needsApproval
                    ? <Badge tone="amber" icon={<HandPalm size={11} />}>Needs approval</Badge>
                    : <Badge icon={<EyeSlash size={11} />}>View only</Badge>
                ) : (
                  <ButtonLink size="sm" href={`/api/documents/${doc.id}/versions/${v.versionNo}/download`} icon={<DownloadSimple size={14} />}>Download</ButtonLink>
                )}
              </div>
              {v.quarantine && (
                <p className="mt-2 flex items-start gap-2 break-words text-xs font-medium text-danger-700 dark:text-danger-300">
                  <Biohazard size={16} className="shrink-0" />Quarantined {formatDate(v.quarantine.foundAt)}: the malware scanner found {v.quarantine.signature}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
      {canUpload && (
        <form onSubmit={upload} className="mt-5 flex flex-wrap items-end gap-3 rounded-xl border border-dashed border-line-strong p-4 transition-colors focus-within:border-brand-400 dark:focus-within:border-brand-400/60">
          <div className="min-w-[12.5rem] flex-1"><Label label="Upload a new version" hint="Scanned for malware and encrypted before it is stored."><Input key={inputKey} type="file" disabled={busy} onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Label></div>
          <Button type="submit" variant="primary" icon={<CloudArrowUp size={18} />} disabled={!file} loading={busy}>{busy ? 'Uploading…' : 'Upload version'}</Button>
        </form>
      )}
    </Card>
  );
}
