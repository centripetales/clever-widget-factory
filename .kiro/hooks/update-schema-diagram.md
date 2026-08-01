# Database Schema Diagram Update Hook

## Trigger Conditions

Run this hook when:
- Migration files in `migrations/*.sql` are added or modified
- User explicitly requests schema diagram update
- PR preparation phase (agent can suggest if migrations detected)

## Hook Actions

1. **Detect if schema update needed**
   - Check git diff for `migrations/*.sql` changes
   - Ask user: "I noticed migration changes. Should I update the schema diagram?"

2. **Generate schema diagram**
   ```bash
   python3 scripts/generate-db-diagram.py > docs/architecture/DATABASE_SCHEMA.md
   ```

3. **Verify output**
   - Check if file was generated successfully
   - Verify Mermaid syntax is valid
   - Compare with previous version to see what changed

4. **Add to PR with context**
   - Stage the file: `git add docs/architecture/DATABASE_SCHEMA.md`
   - Provide explanation: "Updated schema diagram to reflect [specific changes]"
   - Agent can describe what tables/relationships changed

## Error Handling

If script fails:
- Show error output to user
- Check AWS credentials are configured
- Verify Lambda function is accessible
- Suggest manual run for debugging

## Manual Override

User can always run manually:
```bash
python3 scripts/generate-db-diagram.py > docs/architecture/DATABASE_SCHEMA.md
```

## Benefits of Kiro Hook Approach

- **Contextual**: Only runs when relevant
- **Reviewable**: Changes go through PR process
- **Debuggable**: Agent can fix issues and retry
- **Smart**: Agent understands what changed and why
- **No automation noise**: Only updates when needed
