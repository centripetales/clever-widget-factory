// Completes an action and uses up its required stock in one transaction, so
// the app and the Claude connector share one rule and stock stays right when
// two people complete at once. set and where are the action UPDATE's SET list
// and WHERE condition (already scoped to the caller's organization); it only
// applies while the action is not yet completed, so stock is never used twice. Returns the
// updated action rows (none when it was already completed or not visible),
// and the ids of the parts whose quantity changed.
async function completeAction(client, { set, where, requiredStock, userId, actionTitle }) {
  await client.query('BEGIN');
  try {
    const { rows } = await client.query(`UPDATE actions SET ${set} WHERE ${where} AND status <> 'completed' RETURNING *`);
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return { rows, partIds: [] };
    }

    const partIds = [];
    for (const item of requiredStock || []) {
      const quantity = Number(item.quantity);
      if (!item.part_id || !quantity) continue;
      const part = (await client.query(
        'SELECT current_quantity, organization_id FROM parts WHERE id = $1 FOR UPDATE',
        [item.part_id]
      )).rows[0];
      if (!part) {
        const error = new Error(
          `Stock item "${item.part_name || 'Unknown part'}" (ID: ${item.part_id}) no longer exists in inventory. ` +
          `Please remove this item from the action's required stock before completing.`
        );
        error.statusCode = 400;
        throw error;
      }

      // A negative quantity is produced by the action. Stock never goes below 0.
      const oldQuantity = Number(part.current_quantity) || 0;
      const newQuantity = Math.max(0, oldQuantity - quantity);
      await client.query('UPDATE parts SET current_quantity = $2, updated_at = NOW() WHERE id = $1', [item.part_id, newQuantity]);
      await client.query(
        `INSERT INTO parts_history (part_id, change_type, old_quantity, new_quantity, quantity_change,
                                    changed_by, change_reason, organization_id, changed_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
        [
          item.part_id,
          quantity < 0 ? 'quantity_add' : 'quantity_remove',
          oldQuantity,
          newQuantity,
          -quantity,
          userId,
          quantity < 0
            ? `Produced by action: ${actionTitle} - ${-quantity} ${item.part_name}`
            : `Used for action: ${actionTitle} - ${quantity} ${item.part_name}`,
          part.organization_id,
        ]
      );
      partIds.push(item.part_id);
    }

    await client.query('COMMIT');
    return { rows, partIds };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

module.exports = { completeAction };
