import { useAuth } from '@/hooks/useCognitoAuth';
import { useMyPositiveSum } from '@/hooks/positiveSum/usePositiveSum';
import { positiveSumBalance } from '@/lib/positiveSumBalance';

// The person's Positive Sum credit with one org, shown only when they have some.
export function StoreCredit({ orgId, orgName }: { orgId: string; orgName: string }) {
  const { user } = useAuth();
  const { data } = useMyPositiveSum(orgId);
  const credit = data && user?.userId ? Math.round(positiveSumBalance(data, user.userId)) : 0;
  if (credit <= 0) return null;
  return (
    <div className="text-right text-sm text-muted-foreground">
      Your credit{orgName ? ` with ${orgName}` : ''}:{' '}
      <span className="text-lg font-bold text-green-600 dark:text-green-400">₱{credit.toLocaleString()}</span>
    </div>
  );
}
