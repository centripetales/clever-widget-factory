// Changes a part's stock by an amount (positive adds, negative removes) and
// logs it to parts_history, in one transaction, reading the quantity from the
// database with the part's row locked. So two changes at once, or a page with
// an old quantity, can't overwrite each other. Stock never goes below zero.
// Returns { part, history }, or null when the part is not in orgIds.
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

    await client.query('COMMIT');
    return { part: updated, history };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

module.exports = { changeStock };
