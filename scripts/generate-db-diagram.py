#!/usr/bin/env python3
"""
Generate database schema diagram in Mermaid ERD format
Usage: python3 scripts/generate-db-diagram.py > docs/architecture/DATABASE_SCHEMA.md
"""

import json
import subprocess

# Query to get table structure
TABLES_QUERY = """
SELECT 
  t.table_name,
  json_agg(
    json_build_object(
      'column', c.column_name,
      'type', c.data_type,
      'nullable', c.is_nullable,
      'is_pk', CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN true ELSE false END
    ) ORDER BY c.ordinal_position
  ) as columns
FROM information_schema.tables t
JOIN information_schema.columns c ON t.table_name = c.table_name
LEFT JOIN information_schema.key_column_usage kcu 
  ON c.table_name = kcu.table_name AND c.column_name = kcu.column_name
LEFT JOIN information_schema.table_constraints tc 
  ON kcu.constraint_name = tc.constraint_name AND tc.constraint_type = 'PRIMARY KEY'
WHERE t.table_schema = 'public' 
  AND t.table_type = 'BASE TABLE'
  AND t.table_name NOT IN ('spatial_ref_sys')
GROUP BY t.table_name
ORDER BY t.table_name;
"""

# Query to get foreign key relationships
RELATIONSHIPS_QUERY = """
SELECT DISTINCT
  tc.table_name as from_table,
  ccu.table_name as to_table,
  kcu.column_name as from_column
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu 
  ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage ccu 
  ON ccu.constraint_name = tc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = 'public'
ORDER BY tc.table_name, ccu.table_name;
"""

def run_query(query):
    """Execute SQL query via AWS Lambda"""
    payload = json.dumps({"sql": query})
    result = subprocess.run(
        [
            "aws", "lambda", "invoke",
            "--function-name", "cwf-db-migration",
            "--payload", payload,
            "--region", "us-west-2",
            "--cli-binary-format", "raw-in-base64-out",
            "/tmp/db-query-result.json"
        ],
        capture_output=True,
        text=True
    )
    
    with open("/tmp/db-query-result.json", "r") as f:
        response = json.load(f)
        if "body" in response:
            body = json.loads(response["body"])
            return body.get("rows", [])
        return []

def generate_mermaid_diagram():
    """Generate Mermaid ERD diagram"""
    print("# Database Schema Diagram\n")
    print("Auto-generated — do not hand-edit, it will be overwritten on the next run.\n")
    print("Regenerate with:")
    print("```bash")
    print("python3 scripts/generate-db-diagram.py > docs/architecture/DATABASE_SCHEMA.md")
    print("```")
    print("Or let the Kiro hook do it automatically on migration changes — see")
    print("`.kiro/hooks/update-schema-diagram.md`. For a PDF export, see")
    print("`scripts/generate-db-pdf.sh`.\n")
    print("```mermaid")
    print("erDiagram")
    
    # Get tables
    tables = run_query(TABLES_QUERY)
    
    # Print table definitions
    for table in tables:
        table_name = table["table_name"]
        columns = json.loads(table["columns"]) if isinstance(table["columns"], str) else table["columns"]
        
        print(f"  {table_name} {{")
        for col in columns:
            type_str = col["type"]
            pk_str = " PK" if col.get("is_pk") else ""
            null_str = "" if col["nullable"] == "YES" else " NOT NULL"
            print(f"    {type_str} {col['column']}{pk_str}{null_str}")
        print("  }")
    
    # Get relationships
    relationships = run_query(RELATIONSHIPS_QUERY)
    
    # Print relationships
    for rel in relationships:
        from_table = rel["from_table"]
        to_table = rel["to_table"]
        from_col = rel["from_column"]
        print(f"  {to_table} ||--o{{ {from_table} : {from_col}")
    
    print("```")

if __name__ == "__main__":
    generate_mermaid_diagram()
