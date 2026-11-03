/**
 * What the API says it removed from an uploaded PDF (THREATS.md C9):
 * `sanitized.removed` on POST /documents and POST /documents/:id/versions.
 * The labels are the API's stable strings; this turns them into words.
 */
export interface UploadResult {
  sanitized?: { removed: string[] } | null;
}

const WORDS: Record<string, string> = {
  JavaScript: 'JavaScript',
  OpenAction: 'actions that run on opening',
  'Automatic actions (AA)': 'automatic actions',
  'Launch action': 'commands that start programs',
  'Links to other files (GoToR/GoToE)': 'links to other files',
  'ImportData action': 'form data import',
  'SubmitForm action': 'form submission',
  EmbeddedFiles: 'attachments',
  'FileAttachment annotation': 'attachments',
  'RichMedia/3D/multimedia': 'embedded media',
  'XFA form': 'form fields',
  'Form fields (AcroForm)': 'form fields',
  'Non-web link (URI)': 'links to local files',
};

/** "Interactive content was removed for safety: JavaScript, attachments." or null when nothing was removed. */
export function removedNotice(removed: string[] | null | undefined): string | null {
  if (!removed?.length) return null;
  const words = [...new Set(removed.map((r) => WORDS[r] ?? r))];
  return `Interactive content was removed for safety: ${words.join(', ')}.`;
}
