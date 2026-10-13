const { isUuid, deleteAction } = require('./deleteAction');

const ACTION_ID = '11111111-2222-4333-8444-555555555555';
const ORG = `actions.organization_id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'::uuid`;

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

describe('isUuid', () => {
  it('accepts a UUID and rejects anything else', () => {
    expect(isUuid(ACTION_ID)).toBe(true);
    expect(isUuid(`${ACTION_ID}/`)).toBe(false);
    expect(isUuid(`${ACTION_ID}' OR '1'='1`)).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});

describe('deleteAction', () => {
  it('touches nothing when the action is outside the org filter', async () => {
    const client = fakeClient();
    expect(await deleteAction(client, ACTION_ID, ORG)).toBeNull();
    expect(client.calls.map(c => c.sql.split(' ')[0])).toEqual(['BEGIN', 'SELECT', 'ROLLBACK']);
    expect(client.calls[1].sql).toContain(ORG);
    expect(client.calls[1].params).toEqual([ACTION_ID]);
  });

  it('checks the org first, then cleans up and deletes, with the id as a parameter', async () => {
    const client = fakeClient({
      'SELECT id FROM actions': [{ id: ACTION_ID }],
      'DELETE FROM experience_components': [{ experience_id: 'e1' }, { experience_id: 'e1' }],
      'DELETE FROM actions': [{ id: ACTION_ID }],
    });
    expect(await deleteAction(client, ACTION_ID, ORG)).toBe(ACTION_ID);
    expect(client.calls.map(c => c.sql.split(' ').slice(0, 3).join(' '))).toEqual([
      'BEGIN',
      'SELECT id FROM',
      'DELETE FROM experience_components',
      'DELETE FROM experiences',
      'DELETE FROM state_links',
      'DELETE FROM actions',
      'COMMIT',
    ]);
    expect(client.calls[3].params).toEqual([['e1']]);
    expect(client.calls[5].sql).toContain(ORG);
    for (const call of client.calls) expect(call.sql).not.toContain(ACTION_ID);
  });

  it('leaves experiences alone when the action was in none', async () => {
    const client = fakeClient({
      'SELECT id FROM actions': [{ id: ACTION_ID }],
      'DELETE FROM actions': [{ id: ACTION_ID }],
    });
    await deleteAction(client, ACTION_ID, '');
    expect(client.calls.some(c => c.sql.startsWith('DELETE FROM experiences'))).toBe(false);
  });

  it('rolls back and rethrows when a statement fails', async () => {
    const client = fakeClient({ 'SELECT id FROM actions': [{ id: ACTION_ID }] });
    const query = client.query;
    client.query = async (sql, params) => {
      if (sql.startsWith('DELETE FROM state_links')) throw new Error('boom');
      return query(sql, params);
    };
    await expect(deleteAction(client, ACTION_ID, ORG)).rejects.toThrow('boom');
    expect(client.calls.at(-1).sql).toBe('ROLLBACK');
  });
});
