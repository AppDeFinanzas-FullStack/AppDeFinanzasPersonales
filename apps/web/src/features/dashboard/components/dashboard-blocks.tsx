import { DEFAULT_DASHBOARD_BLOCKS, type DashboardViewDto } from '@finanzas/contracts';
import type { ReactNode } from 'react';

import { useSettings } from '@/features/settings/hooks/use-settings';

import { BalancesBlock } from './balances-block';
import { CategoryBars } from './category-bars';
import { PaceChart } from './pace-chart';
import { RecentBlock } from './recent-block';

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

  // A hidden block comes without data, so a block with no data is not drawn.
  const render: Record<string, () => ReactNode> = {
    byCategory: () =>
      data.byCategory !== undefined && (
        <CategoryBars data={data.byCategory} month={month} symbol={symbol} />
      ),
    pace: () => data.pace !== undefined && <PaceChart data={data.pace} />,
    balances: () =>
      data.balances !== undefined && (
        <BalancesBlock data={data.balances} baseCode={baseCode} otherCode={otherCode} />
      ),
    recent: () => data.recent !== undefined && <RecentBlock data={data.recent} symbol={symbol} />,
  };

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
