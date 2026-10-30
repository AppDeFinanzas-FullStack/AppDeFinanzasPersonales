import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

/** Goes back inside the app, or to the parent screen when the user arrived by a direct link (EC-M2-04). */
export function BackButton({ parent }: { parent: string }) {
  const { t } = useTranslation('navigation');
  const navigate = useNavigate();
  const onClick = () => {
    const state = window.history.state as { idx?: number } | null;
    if (typeof state?.idx === 'number' && state.idx > 0) void navigate(-1);
    else void navigate(parent);
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t('back')}
      className="-ml-2 mr-1 inline-flex size-11 shrink-0 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowLeft aria-hidden="true" className="size-5" />
    </button>
  );
}
