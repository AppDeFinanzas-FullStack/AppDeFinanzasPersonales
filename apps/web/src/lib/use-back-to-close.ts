import { useEffect, useRef } from 'react';

const MARKER = 'backToClose';

function isMarked(state: unknown): boolean {
  return typeof state === 'object' && state !== null && MARKER in state;
}

/** Lets the Back button close an open dialog without leaving the screen (RF-M2-06). */
export function useBackToClose(open: boolean, onClose: () => void): void {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    let closedByBack = false;
    const current: unknown = window.history.state;
    const base = typeof current === 'object' && current !== null ? current : {};
    window.history.pushState({ ...base, [MARKER]: true }, '');

    const onPopState = () => {
      closedByBack = true;
      onCloseRef.current();
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      if (!closedByBack && isMarked(window.history.state)) window.history.back();
    };
  }, [open]);
}
