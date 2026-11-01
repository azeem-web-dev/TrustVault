import { createServer, type Server } from 'node:net';

/**
 * A stand-in for ClamAV's daemon that speaks the real INSTREAM protocol, so
 * the tests exercise the production ClamdScanner code end to end. It flags
 * the EICAR test file (the standard harmless "virus" every scanner detects)
 * and can be switched to misbehave.
 *
 * The EICAR string is assembled at runtime so this source file is not
 * itself flagged by antivirus on a developer machine.
 */
export const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS', '-TEST-FILE!$H+H*'].join('');

export type FakeMode = 'normal' | 'down' | 'garbage' | 'silent';

export interface FakeClamd {
  address: string;
  mode: FakeMode;
  scans: number;
  /** Extra signatures, as a signature update would add: bytes -> name. */
  signatures: Map<string, string>;
  close: () => Promise<void>;
}

export async function startFakeClamd(): Promise<FakeClamd> {
  const state: FakeClamd = { address: '', mode: 'normal', scans: 0, signatures: new Map(), close: async () => {} };
  const server: Server = createServer((sock) => {
    if (state.mode === 'down') return sock.destroy();
    let buf = Buffer.alloc(0);
    let headerSeen = false;
    const body: Buffer[] = [];
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!headerSeen) {
        const nul = buf.indexOf(0);
        if (nul < 0) return;
        const cmd = buf.subarray(0, nul).toString();
        if (cmd === 'zVERSION') return sock.end(`ClamAV 1.4.3/${27000 + state.signatures.size}/Sat Nov  1 03:00:00 2026\0`);
        if (cmd !== 'zINSTREAM') return sock.end('UNKNOWN COMMAND\0');
        headerSeen = true;
        buf = buf.subarray(nul + 1);
      }
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          state.scans++;
          if (state.mode === 'silent') return; // never answers: the client must time out
          if (state.mode === 'garbage') return sock.end('stream: maybe\0');
          const data = Buffer.concat(body);
          if (data.includes(EICAR)) return sock.end('stream: Eicar-Test-Signature FOUND\0');
          for (const [bytes, name] of state.signatures) if (data.includes(bytes)) return sock.end(`stream: ${name} FOUND\0`);
          return sock.end('stream: OK\0');
        }
        if (buf.length < 4 + len) return;
        body.push(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
      }
    });
    sock.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('fake clamd failed to listen');
  state.address = `tcp://127.0.0.1:${addr.port}`;
  state.close = () => new Promise((resolve) => server.close(() => resolve()));
  return state;
}
