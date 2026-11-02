/**
 * Tests for changing a part's stock on the server.
 * Run with: node --test stockChange.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { changeStock } = require('./stockChange');

// Records every statement; answers by matching the start of the SQL.
function fakeClient(answers = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      const key = Object.keys(answers).find(k => sql.trim().startsWith(k));
      if (answers[key] instanceof Error) throw answers[key];
      return { rows: key ? answers[key] : [] };
    },
  };
}

const args = { partId: 'part-1', reason: 'Bought 3 at the hardware store', userId: 'user-1', orgIds: ['org-a'] };

describe('changeStock', () => {
  test('adds to the quantity read from the database, logs it, in one transaction', async () => {
    const client = fakeClient({
      'SELECT current_quantity': [{ current_quantity: '5.000' }],
      'UPDATE parts': [{ id: 'part-1', current_quantity: 8, organization_id: 'org-a' }],
      'INSERT INTO parts_history': [{ id: 'h-1' }],
    });
    const result = await changeStock(client, { ...args, change: 3 });

    assert.deepStrictEqual(result, { part: { id: 'part-1', current_quantity: 8, organization_id: 'org-a' }, history: { id: 'h-1' } });
    const sql = client.calls.map(c => c.sql);
    assert.strictEqual(sql[0], 'BEGIN');
    assert.match(sql[1], /organization_id = ANY\(\$2::uuid\[\]\) FOR UPDATE$/);
    assert.deepStrictEqual(client.calls[1].params, ['part-1', ['org-a']]);
    assert.deepStrictEqual(client.calls[2].params, ['part-1', 8]);
    assert.deepStrictEqual(client.calls[3].params, ['part-1', 'quantity_add', 5, 8, 3, 'user-1', 'Bought 3 at the hardware store', 'org-a']);
    assert.strictEqual(sql[4], 'COMMIT');
  });

  test('removes, and never goes below zero', async () => {
    const client = fakeClient({
      'SELECT current_quantity': [{ current_quantity: '2' }],
      'UPDATE parts': [{ id: 'part-1', organization_id: 'org-a' }],
    });
    await changeStock(client, { ...args, change: -5 });
    assert.deepStrictEqual(client.calls[2].params, ['part-1', 0]);
    assert.strictEqual(client.calls[3].params[1], 'quantity_remove');
    assert.strictEqual(client.calls[3].params[4], -5);
  });

  test('a part outside the caller orgs changes nothing', async () => {
    const client = fakeClient();
    assert.strictEqual(await changeStock(client, { ...args, change: 1 }), null);
    assert.deepStrictEqual(client.calls.map(c => c.sql.split(' ')[0]), ['BEGIN', 'SELECT', 'ROLLBACK']);
  });

  test('a failure rolls back the quantity too', async () => {
    const client = fakeClient({
      'SELECT current_quantity': [{ current_quantity: '2' }],
      'UPDATE parts': [{ id: 'part-1', organization_id: 'org-a' }],
      'INSERT INTO parts_history': new Error('insert failed'),
    });
    await assert.rejects(changeStock(client, { ...args, change: 1 }), /insert failed/);
    assert.strictEqual(client.calls[client.calls.length - 1].sql, 'ROLLBACK');
  });
});
