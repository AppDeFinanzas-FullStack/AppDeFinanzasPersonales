import { DEFAULT_DASHBOARD_BLOCKS, type DashboardViewDto } from '@finanzas/contracts';
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { useSettings } from '@/features/settings/hooks/use-settings';

import { BalancesBlock } from './balances-block';
import { BudgetBlock } from './budget-block';
import { CategoryBars } from './category-bars';
import { RecentBlock } from './recent-block';

type Pace = NonNullable<DashboardViewDto['pace']>;

// The chart pulls in recharts, so it downloads apart and the cards do not wait for it (RNF-03).
const PaceChart = lazy(async () => {
  const { PaceChart: component } = await import('./pace-chart');
  return { default: component };
});

/** Keeps the title and the room of the chart while it is not drawn, so the blocks below do not jump. */
function PaceChartPlaceholder({ placeRef }: { placeRef?: RefObject<HTMLElement | null> }) {
  const { t } = useTranslation('dashboard');
  return (
    <section ref={placeRef} className="flex flex-col gap-3" aria-labelledby="dashboard-pace">
      <h2 id="dashboard-pace" className="text-base font-semibold">
        {t('pace.title')}
      </h2>
      <div aria-hidden="true" className="h-52" />
    </section>
  );
}

/**
 * Downloads and draws the chart only when its place reaches the screen. Below the fold, neither the
 * download nor running recharts holds back the first paint of the Inicio (RNF-03).
 */
function DeferredPaceChart({ data }: { data: Pace }) {
  const place = useRef<HTMLElement>(null);
  const [onScreen, setOnScreen] = useState(typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    const element = place.current;
    if (onScreen || element === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setOnScreen(true);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [onScreen]);

  if (!onScreen) return <PaceChartPlaceholder placeRef={place} />;
  return (
    <Suspense fallback={<PaceChartPlaceholder />}>
      <PaceChart data={data} />
    </Suspense>
  );
}

/** Runs the callback when the browser is idle. Safari has no idle callbacks, so a timer stands in. */
function whenIdle(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(callback);
    return () => {
      window.cancelIdleCallback(handle);
    };
  }
  const timer = window.setTimeout(callback, 1);
  return () => {
    window.clearTimeout(timer);
  };
}

/**
 * True once the browser is idle after the cards above the blocks were committed. The blocks are
 * drawn only then, so building them never holds back the first paint of the Inicio (RNF-03).
 */
function useWhenIdle(): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(
    () =>
      whenIdle(() => {
        setIdle(true);
      }),
    [],
  );
  return idle;
}

interface Props {
  data: DashboardViewDto;
  month: string;
  baseCode: string;
  otherCode: string;
  symbol: string;
}

/** The blocks of the Inicio in the order of `dashboard_blocks`; hidden ones are skipped (RF-M8-10). */
export function DashboardBlocks({ data, month, baseCode, otherCode, symbol }: Props) {
  const settings = useSettings();
  const blocks = settings.data?.dashboardBlocks ?? DEFAULT_DASHBOARD_BLOCKS;
  const idle = useWhenIdle();

  // A hidden block comes without data, so a block with no data is not drawn.
  const render: Record<string, () => ReactNode> = {
    budget: () =>
      data.budgets !== undefined && <BudgetBlock data={data.budgets} month={month} symbol={symbol} />,
    byCategory: () =>
      data.byCategory !== undefined && (
        <CategoryBars data={data.byCategory} month={month} symbol={symbol} />
      ),
    pace: () => data.pace !== undefined && <DeferredPaceChart data={data.pace} />,
    balances: () =>
      data.balances !== undefined && (
        <BalancesBlock data={data.balances} baseCode={baseCode} otherCode={otherCode} />
      ),
    recent: () => data.recent !== undefined && <RecentBlock data={data.recent} symbol={symbol} />,
  };

  if (!idle) return null;

  return (
    <>
      {blocks
        .filter((block) => block.visible && block.key in render)
        .map((block) => (
          <div key={block.key}>{render[block.key]?.()}</div>
        ))}
    </>
  );
}
