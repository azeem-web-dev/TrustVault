import { type Access } from '@/lib/api';

interface Version {
  versionNo: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  sha256: string;
  uploadedBy: string;
  /** Set when the nightly malware re-scan found something in this version. */
  quarantine: { signature: string; foundAt: string } | null;
}

export interface Doc {
  id: string;
  title: string;
  category: string;
  description: string | null;
  status: 'ACTIVE' | 'DELETED';
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  owner: { id: string; displayName: string; email: string };
  isOwner: boolean;
  myAccess: Access;
  /** Downloads need the owner's approval (a condition on the share). */
  downloadNeedsApproval?: boolean;
  /**
   * Download state for the current viewer (sent by the API). `allowed`: a
   * Download button is shown. `requestable`: a view-only viewer may ask the
   * owner for a one-file download. `requestStatus`: where that ask stands.
   * Absent on older responses, in which case we fall back gracefully.
   */
  download?: { allowed: boolean; requestable: boolean; requestStatus: 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED' };
  folder: { id: string; name: string } | null;
  versions: Version[];
}

export type Tab = 'pages' | 'overview' | 'versions' | 'access' | 'history';
export const LEVEL_WORD: Record<string, string> = { VIEW: 'view', READ: 'read', EDIT: 'edit', MANAGE: 'manage', OWNER: 'own' };
export const RANK: Record<Access, number> = { NONE: 0, VIEW: 1, READ: 2, EDIT: 3, MANAGE: 4, OWNER: 5 };
