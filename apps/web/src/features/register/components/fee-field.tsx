import { useTranslation } from 'react-i18next';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCategories } from '@/features/categories/hooks/use-categories';

interface FeeFieldProps {
  amount: string;
  onAmount: (amount: string) => void;
  /** Shown only once the API asks for it: there is no "Comisiones bancarias" (EC-M6-08). */
  askCategory: boolean;
  categoryId: string;
  onCategory: (id: string) => void;
}

/** The fee of a transfer (RF-M6-05): its own expense, by default in "Comisiones bancarias". */
export function FeeField({ amount, onAmount, askCategory, categoryId, onCategory }: FeeFieldProps) {
  const { t } = useTranslation('register');
  const expense = useCategories({ kind: 'expense', status: 'active' });
  const categories = (expense.data ?? []).flatMap((root) => [root, ...root.children]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="register-fee">{t('second.fee')}</Label>
        <Input
          id="register-fee"
          inputMode="decimal"
          className="h-11 tabular-nums"
          value={amount}
          onChange={(event) => {
            onAmount(event.target.value);
          }}
        />
      </div>
      {askCategory && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="register-fee-category">{t('second.feeCategory')}</Label>
          <p className="text-sm text-muted-foreground">{t('second.feeCategoryHint')}</p>
          <select
            id="register-fee-category"
            value={categoryId}
            onChange={(event) => {
              onCategory(event.target.value);
            }}
            className="flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
          >
            <option value="">{t('second.pickCategory')}</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
