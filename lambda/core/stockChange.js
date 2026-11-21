// Changes a part's stock by an amount (positive adds, negative removes) and
// logs it to parts_history, in one transaction, reading the quantity from the
// database with the part's row locked. So two changes at once, or a page with
// an old quantity, can't overwrite each other. Stock never goes below zero.
// Returns { part, history, stockMetricId }, or null when the part is not in orgIds.

// The part's Inventory metric: its readings are the quantity after each change,
// recorded with an observation. Every part has one, found by this name (the metrics
// service keeps it from being renamed or deleted). It is created the first time a
// part changes. Runs under the part's row lock, so two first changes can't make two.
// It is best effort (a savepoint), so a problem with metrics never blocks a change
// of stock; stockMetricId is null then.
const INVENTORY_METRIC = 'Inventory';

async function ensureStockMetric(client, part) {
  await client.query('SAVEPOINT stock_metric');
  try {
    const found = (await client.query(
      `SELECT metric_id::text AS id FROM metrics
       WHERE entity_type = 'part' AND entity_id::text = $1 AND name = $2 AND organization_id = $3 AND active
       ORDER BY created_at LIMIT 1`,
      [part.id, INVENTORY_METRIC, part.organization_id]
    )).rows[0];
    if (found) {
      await client.query('RELEASE SAVEPOINT stock_metric');
      return found.id;
    }
    const created = (await client.query(
      `INSERT INTO metrics (entity_type, entity_id, name, unit, value_type, min_value, details, organization_id)
       VALUES ('part', $1, $2, $3, 'number', 0, $4, $5)
       RETURNING metric_id::text AS id`,
      [part.id, INVENTORY_METRIC, part.unit || null, 'How much of this part there is. Each reading is the quantity after a change.', part.organization_id]
    )).rows[0];
    await client.query('RELEASE SAVEPOINT stock_metric');
    return created ? created.id : null;
  } catch (err) {
    console.error('Could not set up the Inventory metric of part', part.id, err.message);
    await client.query('ROLLBACK TO SAVEPOINT stock_metric');
    return null;
  }
}

async function changeStock(client, { partId, change, reason, userId, orgIds }) {
  await client.query('BEGIN');
  try {
    const part = (await client.query(
      'SELECT current_quantity FROM parts WHERE id::text = $1 AND organization_id = ANY($2::uuid[]) FOR UPDATE',
      [partId, orgIds]
    )).rows[0];
    if (!part) {
      await client.query('ROLLBACK');
      return null;
    }

    const oldQuantity = Number(part.current_quantity) || 0;
    const newQuantity = Math.max(0, oldQuantity + change);
    const updated = (await client.query(
      'UPDATE parts SET current_quantity = $2, updated_at = NOW() WHERE id::text = $1 RETURNING *',
      [partId, newQuantity]
    )).rows[0];
    const history = (await client.query(
      `INSERT INTO parts_history (part_id, change_type, old_quantity, new_quantity, quantity_change,
                                  changed_by, change_reason, organization_id, changed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
       RETURNING *`,
      [partId, change < 0 ? 'quantity_remove' : 'quantity_add', oldQuantity, newQuantity, change,
        userId, reason || null, updated.organization_id]
    )).rows[0];
    const stockMetricId = await ensureStockMetric(client, { id: partId, unit: updated.unit, organization_id: updated.organization_id });

    await client.query('COMMIT');
    return { part: updated, history, stockMetricId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

module.exports = { changeStock };
