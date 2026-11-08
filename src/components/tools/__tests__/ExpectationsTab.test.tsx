import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExpectationsTab } from '@/components/tools/ExpectationsTab';
import { buildToolExpectations } from '@/lib/expectationModels';
import type { StateSpaceModelRecord } from '@/lib/stateSpaceApi';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const record = (inputs?: object) => ({
  id: 'm1', organization_id: 'org-a', name: 'Azolla across Lower Fields', description: null, version: '1', author: 'Stefan',
  is_public: false, created_by: null, created_at: '2026-11-08T00:00:00Z', updated_at: '2026-11-08T00:00:00Z',
  model_definition: {
    kind: 'expectation',
    model_metadata: { name: 'Azolla across Lower Fields', version: '1', author: 'Stefan Hamilton', description: 'Scaled from the pond' },
    anchor: '2026-11-08', time_step_days: 1, horizon_days: 30,
    variables: { value: { name: 'Value/day', unit: 'PHP/day', distribution: 'fixed', params: { value: inputs ? 'area * 0.25' : 2 } } },
    ...(inputs && { inputs }),
    rationale: 'r', evidence: { summary: 's', observation_ids: [], experience_ids: [] },
  },
}) as unknown as StateSpaceModelRecord;

describe('ExpectationsTab', () => {
  it('shows a slider per input, starting at the agreed value, and a what-if can be put back', () => {
    const now = new Date('2026-11-10T04:00:00Z');
    vi.useFakeTimers({ now, toFake: ['Date'] });
    const expectations = buildToolExpectations([record({ area: { label: 'Area', unit: 'm²', value: 8, min: 8, max: 40000, step: 1 } })], [], now);
    render(<ExpectationsTab expectations={expectations} />);
    expect(screen.getByText('8 m²')).toBeTruthy();
    expect(screen.getByText(/Expected today: 2 PHP\/day/)).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('slider'), { key: 'End' });
    expect(screen.getByText('40,000 m²')).toBeTruthy();
    expect(screen.getByText(/Expected today: 10000 PHP\/day/)).toBeTruthy();
    expect(screen.getByText(/What-if: not saved/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Back to agreed values' }));
    expect(screen.getByText('8 m²')).toBeTruthy();
    vi.useRealTimers();
  });

  it('has no sliders for a model without inputs', () => {
    render(<ExpectationsTab expectations={buildToolExpectations([record()], [])} />);
    expect(screen.queryByRole('slider')).toBeNull();
  });
});
