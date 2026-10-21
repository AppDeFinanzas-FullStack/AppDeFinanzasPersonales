import { ProblemSchema } from '@finanzas/contracts';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { messageForError } from '@/lib/i18n-errors';
import { online } from '@/lib/online';
import { uiStore } from '@/lib/ui-store';

const EXPORT_PATH = '/api/me/export';
const FALLBACK_FILE_NAME = 'finanzas-export.zip';
const SESSION_EXPIRED = 'SESSION_EXPIRED';
const INTERNAL_ERROR = 'INTERNAL_ERROR';
/** Time the browser gets to start the download before the blob URL is released. */
const REVOKE_DELAY_MS = 1000;

type ExportState =
  | { status: 'idle' }
  | { status: 'downloading'; received: number }
  | { status: 'done' }
  | { status: 'error'; code: string };

async function errorCodeOf(response: Response): Promise<string> {
  try {
    const problem = ProblemSchema.safeParse(await response.json());
    return problem.success ? problem.data.code : INTERNAL_ERROR;
  } catch {
    return INTERNAL_ERROR;
  }
}

function fileNameOf(response: Response): string {
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  return match?.[1] ?? FALLBACK_FILE_NAME;
}

/** Reads the streamed ZIP chunk by chunk so the received size can be shown. */
async function readBlob(response: Response, onProgress: (received: number) => void): Promise<Blob> {
  const type = response.headers.get('content-type') ?? 'application/zip';
  if (response.body === null) return new Blob([await response.arrayBuffer()], { type });
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(new Uint8Array(value));
    received += value.byteLength;
    onProgress(received);
  }
  return new Blob(chunks, { type });
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, REVOKE_DELAY_MS);
}

/**
 * "Exportar mis datos" (RF-M1-14, plan §4.1.4): downloads `GET /api/me/export` with `fetch` +
 * `blob`, showing how much has arrived, and hands the ZIP to the browser.
 */
export function ExportButton({ label }: { label: string }) {
  const { t } = useTranslation('profile');
  const [state, setState] = useState<ExportState>({ status: 'idle' });
  const downloading = state.status === 'downloading';

  const download = async () => {
    setState({ status: 'downloading', received: 0 });
    let response: Response;
    try {
      response = await fetch(EXPORT_PATH, {
        method: 'GET',
        headers: { accept: 'application/zip' },
        credentials: 'include',
      });
    } catch (error) {
      if (error instanceof TypeError) online.setOffline();
      setState({ status: 'error', code: INTERNAL_ERROR });
      return;
    }
    if (!response.ok) {
      const code = await errorCodeOf(response);
      if (code === SESSION_EXPIRED) uiStore.openSessionExpired();
      setState({ status: 'error', code });
      return;
    }
    try {
      const blob = await readBlob(response, (received) => {
        setState({ status: 'downloading', received });
      });
      saveBlob(blob, fileNameOf(response));
      setState({ status: 'done' });
    } catch {
      setState({ status: 'error', code: INTERNAL_ERROR });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="outline"
        className="h-11"
        disabled={downloading}
        aria-busy={downloading}
        onClick={() => {
          void download();
        }}
      >
        {downloading ? t('export.downloading') : label}
      </Button>
      {state.status === 'downloading' && (
        <p role="status" className="text-sm text-muted-foreground tabular-nums">
          {t('export.progress', { size: Math.ceil(state.received / 1024) })}
        </p>
      )}
      {state.status === 'done' && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('export.done')}
        </p>
      )}
      {state.status === 'error' && (
        <p role="alert" className="text-sm text-destructive">
          {messageForError({ code: state.code })}
        </p>
      )}
    </div>
  );
}
