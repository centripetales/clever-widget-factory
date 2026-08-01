# Tool Audit System Requirements

## Overview
Create a comprehensive tool audit system to verify tool locations and conditions through random sampling and systematic tracking.

## Core Flow
1. **Audit Initiation** → 2. **Type Selection** (Tools) → 3. **Vicinity Selection** → 4. **Quantity Selection** → 5. **Generate Audit** → 6. **Execute Audit**

## Detailed Requirements

### 1. Audit Dashboard
- New "Audit" page accessible from main navigation
- Initial choice: "Tools" or "Inventory"

### 2. Vicinity Selection
- Display all storage vicinities from existing data (tools or inventory based on selection)
- Single selection only (no multi-vicinity audits for tools OR inventory)
- Show count of available items per vicinity

### 3. Audit Generation Parameters
- **Quantity Selector**: Default 5 items, allow 1-20 range
- **Selection Algorithm**:
  1. Prioritize tools never audited (`last_audited_at` is null)
  2. Then prioritize least recently audited
  3. Apply random selection to reach requested quantity
  4. Filter: Only tools with `status = 'available'`

### 4. Audit Execution Form
**For each selected tool, auditor completes:**

#### Required Fields:
- **Photo Upload**: 1-3 images of the tool in its current location
- **Location Verification**: 
  - "Found in expected Storage Vicinity?" (Yes/No)
  - "Found in expected Storage Location?" (Yes/No)
- **Condition Assessment**: Dropdown (Good/Fair/Poor/Missing)
- **Audit Comments**: Text area

#### Action Buttons:
- **"Flag for Maintenance"**: Creates maintenance request
- **"Edit Tool Details"**: Opens tool edit form in modal
- **"Mark as Missing"**: Sets tool status and location

### 5. Data Model Extensions

#### New `tool_audits` Table:
```sql
- id (uuid, primary key)
- tool_id (uuid, foreign key to tools)
- audited_by (uuid, foreign key to profiles.user_id)
- audited_at (timestamp)
- found_in_vicinity (boolean)
- found_in_location (boolean)
- condition_found (enum: good/fair/poor/missing)
- audit_comments (text)
- photo_urls (text array)
- flagged_for_maintenance (boolean)
- last_user_identified (uuid, nullable - who used it last week)
- created_at (timestamp)
```

#### Modify `tools` Table:
```sql
- ADD COLUMN last_audited_at (timestamp, nullable)
- ADD COLUMN audit_status (text, default 'never_audited')
```

### 6. Business Logic

#### Last User Identification:
- Query `checkins` table for tools returned within past 7 days
- Associate audit with the most recent user

#### Audit Completion Actions:
- Update `tools.last_audited_at = now()`
- Update `tools.audit_status = 'audited'`
- If missing: Update `tools.status = 'missing'`
- If flagged for maintenance: Create maintenance request record

#### Maintenance Flagging:
- Create entry in maintenance tracking system
- Notify maintenance team
- Update tool status if necessary

### 7. User Interface Requirements

#### Audit List View:
- Show generated audit list with tool names, expected locations
- Progress indicator (X of Y completed)
- "Start Audit" / "Continue Audit" buttons

#### Audit Form:
- Clean, mobile-friendly interface
- Large photo capture buttons
- Clear Yes/No toggles for location verification
- Prominent "Complete Audit" button

#### Results Summary:
- Show completed audit results
- Highlight discrepancies (missing tools, wrong locations)
- Generate audit report for management

### 8. Reporting & Analytics
- Audit completion rates by vicinity
- Tool discrepancy trends
- Missing tool reports
- Maintenance request generation from audits

#### Tool Acquisition Efficiency Metric:
- **Benchmark**: 1 minute for 5 items (baseline efficiency)
- **Penalties**:
  - 10 minutes per item not in correct location
  - 10 minutes per item marked as "functional but not efficient"
- **Formula**: 1 ÷ total_penalty_minutes = efficiency percentage
- **Examples**:
  - All items in correct location: 1 ÷ 1 = 100% efficiency
  - 2 items out of place: 1 ÷ 20 = 5% efficiency
  - 1 missing + 1 inefficient: 1 ÷ 20 = 5% efficiency

### 9. Permissions & Security
- Audit feature available to all authenticated users
- Audit records are immutable once submitted
- Photo uploads stored in dedicated `audit-photos` bucket

### 10. Future Enhancements (Phase 2)
- Inventory part audits
- Multi-vicinity audits
- Scheduled/recurring audits
- Audit assignment to specific users
- Integration with maintenance scheduling

## Technical Implementation Notes
- Leverage existing tool management infrastructure
- Reuse photo upload components from tool check-in system
- Integrate with existing user management and permissions
- Use existing UI component library for consistency