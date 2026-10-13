const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = value => typeof value === 'string' && UUID_RE.test(value);

// Deletes an action and what hangs off it, but only once the action is known
// to sit inside the caller's organization filter. Returns the deleted id, or
// null when no such action is visible to the caller (nothing is touched).
// orgCondition is the trusted SQL fragment from buildOrganizationFilter.
async function deleteAction(client, actionId, orgCondition) {
  const orgClause = orgCondition ? `AND ${orgCondition}` : '';
  await client.query('BEGIN');
  try {
    const found = await client.query(`SELECT id FROM actions WHERE id = $1 ${orgClause} FOR UPDATE`, [actionId]);
    if (found.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    // An action that's a component of an experience needs its
    // experience_components row cleaned up first — and if this was the
    // experience's last remaining component (no other actions, no initial
    // or final states left), the now-empty experience is deleted too
    // rather than left behind as a blank write-up nobody can see the point of.
    const affected = await client.query(
      'DELETE FROM experience_components WHERE action_id = $1 RETURNING experience_id',
      [actionId]
    );
    const experienceIds = [...new Set(affected.rows.map(r => r.experience_id))];
    if (experienceIds.length > 0) {
      await client.query(
        `DELETE FROM experiences e WHERE e.id = ANY($1::uuid[])
           AND NOT EXISTS (SELECT 1 FROM experience_components ec WHERE ec.experience_id = e.id)`,
        [experienceIds]
      );
    }

    // An observation linked to this action (state_links entity_type='action')
    // is deliberately hidden from the History feed as a standalone entry —
    // it's meant to surface via the action's own card instead (see
    // docs/specs/azolla-impact-power-model.md — "states as action context").
    // Without this cleanup, deleting the action leaves that state_links row
    // behind pointing at nothing, so the observation is suppressed from
    // history everywhere with no card to surface it from — effectively
    // invisible, not just re-homed.
    await client.query(`DELETE FROM state_links WHERE entity_type = 'action' AND entity_id = $1`, [actionId]);

    const deleted = await client.query(`DELETE FROM actions WHERE id = $1 ${orgClause} RETURNING id`, [actionId]);
    await client.query('COMMIT');
    return deleted.rows[0].id;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

module.exports = { isUuid, deleteAction };
