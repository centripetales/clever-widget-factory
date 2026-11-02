const { completeAction } = require('./completeAction');

// Records every statement; answers by matching the start of the SQL.
function fakeClient(answers = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      const key = Object.keys(answers).find(k => sql.trim().startsWith(k));
      return { rows: key ? answers[key] : [] };
    },
  };
}

const args = {
  set: `status = 'completed', updated_at = NOW()`,
  where: `id = 'action-1' AND actions.organization_id = 'org-a'::uuid`,
  userId: 'user-1',
  actionTitle: 'Spray the eggplants',
};

describe('completeAction', () => {
  it('completes the action, uses up each part and logs it, in one transaction', async () => {
    const client = fakeClient({
      'UPDATE actions': [{ id: 'action-1', status: 'completed' }],
      'SELECT current_quantity': [{ current_quantity: '5.000', organization_id: 'org-a' }],
    });
    const result = await completeAction(client, {
      ...args,
      requiredStock: [{ part_id: 'part-1', quantity: 2, part_name: 'Beauveria' }, { part_id: 'part-2', quantity: -3, part_name: 'Compost' }],
    });

    expect(result).toEqual({ rows: [{ id: 'action-1', status: 'completed' }], partIds: ['part-1', 'part-2'] });
    const sql = client.calls.map(c => c.sql);
    expect(sql[0]).toBe('BEGIN');
    expect(sql[1]).toBe(`UPDATE actions SET ${args.set} WHERE ${args.where} AND status <> 'completed' RETURNING *`);
    expect(sql[2]).toMatch(/FOR UPDATE$/);
    expect(client.calls[3].params).toEqual(['part-1', 3]);
    expect(client.calls[4].params).toEqual(['part-1', 'quantity_remove', 5, 3, -2, 'user-1', 'Used for action: Spray the eggplants - 2 Beauveria', 'org-a']);
    expect(client.calls[6].params).toEqual(['part-2', 8]);
    expect(client.calls[7].params[1]).toBe('quantity_add');
    expect(client.calls[7].params[6]).toBe('Produced by action: Spray the eggplants - 3 Compost');
    expect(sql[sql.length - 1]).toBe('COMMIT');
  });

  it('stock never goes below zero', async () => {
    const client = fakeClient({
      'UPDATE actions': [{ id: 'action-1' }],
      'SELECT current_quantity': [{ current_quantity: '1', organization_id: 'org-a' }],
    });
    await completeAction(client, { ...args, requiredStock: [{ part_id: 'part-1', quantity: 4, part_name: 'Beauveria' }] });
    expect(client.calls[3].params).toEqual(['part-1', 0]);
  });

  it('uses no stock when the action was already completed', async () => {
    const client = fakeClient();
    const result = await completeAction(client, { ...args, requiredStock: [{ part_id: 'part-1', quantity: 2, part_name: 'Beauveria' }] });
    expect(result).toEqual({ rows: [], partIds: [] });
    expect(client.calls.map(c => c.sql)).toEqual(['BEGIN', expect.stringMatching(/^UPDATE actions/), 'ROLLBACK']);
  });

  it('rolls everything back when a part no longer exists', async () => {
    const client = fakeClient({ 'UPDATE actions': [{ id: 'action-1' }] });
    await expect(completeAction(client, { ...args, requiredStock: [{ part_id: 'gone', quantity: 1, part_name: 'Old twine' }] }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('"Old twine" (ID: gone) no longer exists in inventory') });
    expect(client.calls[client.calls.length - 1].sql).toBe('ROLLBACK');
  });
});
