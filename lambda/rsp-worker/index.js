const { Client } = require('pg');
const { BedrockAgentRuntimeClient, InvokeAgentCommand } = require('@aws-sdk/client-bedrock-agent-runtime');

const bedrockClient = new BedrockAgentRuntimeClient({ region: process.env.AWS_REGION || 'us-west-2' });

const AGENT_ID = process.env.MAXWELL_AGENT_ID || 'CNV04Q1OAZ'; // Fallback if missing
const AGENT_ALIAS_ID = process.env.MAXWELL_AGENT_ALIAS_ID_DEEP || 'XVS45ZMCA6';

// Database configuration
const dbConfig = {
  host: process.env.DB_HOST || 'cwf-dev-postgres.ctmma86ykgeb.us-west-2.rds.amazonaws.com',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'postgres',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
};

async function invokeLLM(prompt) {
  const command = new InvokeAgentCommand({
    agentId: AGENT_ID,
    agentAliasId: AGENT_ALIAS_ID,
    sessionId: `rsp-${Date.now()}`,
    inputText: prompt,
    enableTrace: false
  });

  const response = await bedrockClient.send(command);
  
  let reply = '';
  for await (const chunk of response.completion) {
    if (chunk.chunk?.bytes) {
      reply += new TextDecoder().decode(chunk.chunk.bytes);
    }
  }
  return reply;
}

exports.handler = async (event) => {
  const client = new Client(dbConfig);
  try {
    await client.connect();

    // 1. Fetch pending outbox records
    const outboxSql = `
      SELECT id, state_id, idempotency_key
      FROM rsp_outbox
      WHERE status = 'PENDING'
      ORDER BY triggered_at ASC
      LIMIT 10
    `;
    const pendingRecords = (await client.query(outboxSql)).rows;

    for (const record of pendingRecords) {
      try {
        // Mark as processing
        await client.query(`UPDATE rsp_outbox SET status = 'PROCESSING', attempt_count = attempt_count + 1 WHERE id = $1`, [record.id]);

        // 2. Fetch full state context, including embedded EXIF/GPS metadata
        const stateSql = `
          SELECT 
            s.id, s.state_text, s.captured_at,
            (
              SELECT json_agg(
                jsonb_build_object(
                  'id', sp.id,
                  'photo_url', sp.photo_url,
                  'photo_description', sp.photo_description,
                  'photo_order', sp.photo_order,
                  'gps_latitude', pme.gps_latitude,
                  'gps_longitude', pme.gps_longitude,
                  'gps_altitude', pme.gps_altitude,
                  'exif_captured_at', pme.captured_at
                )
              ) 
              FROM state_photos sp 
              LEFT JOIN photo_metadata_extractions pme ON sp.photo_url = pme.photo_url 
              WHERE sp.state_id = s.id
            ) as photos,
            (SELECT json_agg(ms) FROM metric_snapshots ms WHERE ms.state_id = s.id) as metrics
          FROM states s
          WHERE s.id = $1
        `;
        const stateResult = await client.query(stateSql, [record.state_id]);
        if (stateResult.rows.length === 0) throw new Error('State not found');
        const state = stateResult.rows[0];

        // 3. Prompt LLM to extract 3 strata
        const strataPrompt = `
You are the Reality Stratification Pipeline (RSP) Engine. Your task is to extract three distinct strata from the following system state observation.
Do not invent data or gaps. Be strictly objective.
If there are localized idioms or terms you do not understand, DO NOT invent an uncertainty gap.

Observation Text: ${state.state_text || 'None'}
Timestamp: ${state.captured_at}
Photos: ${JSON.stringify(state.photos || [])}
Metrics: ${JSON.stringify(state.metrics || [])}

Output exactly valid JSON with three top-level keys: "HARD", "HUMAN", "ENTROPY".
"HARD" properties: {"image_timeline": [...], "physical_vars": [...], "timestamps": [...], "http_error_codes": [...]}
"HUMAN" properties: {"intended_trajectory": "...", "manual_tactics": "...", "unbacked_assertions": "..."}
"ENTROPY" must have these exact properties: {"estimated_hours_consumed": <number or null>, "root_cause_diagnosis": "...", "status": "OPEN", "entropy_delta": null}
`;
        
        console.log("\n=== BEDROCK PROMPT START ===\n" + strataPrompt + "\n=== BEDROCK PROMPT END ===\n");
        const llmOutput = await invokeLLM(strataPrompt);
        console.log("\n=== BEDROCK RAW OUTPUT START ===\n" + llmOutput + "\n=== BEDROCK RAW OUTPUT END ===\n");
        let strataJson;
        try {
          // Attempt to extract JSON from markdown block if necessary
          const match = llmOutput.match(/```json\n([\s\S]*?)\n```/) || llmOutput.match(/{[\s\S]*}/);
          strataJson = JSON.parse(match ? match[0].replace(/```json|```/g, '') : llmOutput);
        } catch (e) {
          throw new Error('Failed to parse LLM JSON output: ' + e.message);
        }

        // 4. Handle Epistemic Links (ΔE Calculation)
        const linkSql = `
          SELECT target_state_id 
          FROM epistemic_links 
          WHERE source_state_id = $1
        `;
        const links = (await client.query(linkSql, [record.state_id])).rows;
        
        if (links.length > 0) {
          // If linked to an older baseline, calculate ΔE
          const targetStateId = links[0].target_state_id;
          
          // Fetch target state's HARD stratum
          const targetHardSql = `
            SELECT payload FROM state_strata
            WHERE state_id = $1 AND stratum_type = 'HARD'
            ORDER BY created_at DESC LIMIT 1
          `;
          const targetHard = (await client.query(targetHardSql, [targetStateId])).rows[0];
          
          if (targetHard) {
             const deltaPrompt = `
Compare the New Hard Stratum against the Original Hard Stratum baseline to compute a fluid entropy delta percentage (ΔE).
Original Baseline: ${JSON.stringify(targetHard.payload)}
New Observation: ${JSON.stringify(strataJson.HARD)}

Determine if the new observation accelerates entropy (+ΔE) by introducing conflicting data or corrupt directives, mitigates it partially (-ΔE), or absolutely resolves it (-100).
Return only a valid JSON object with the property "entropy_delta" holding an integer between -100 and 100.
`;
             const deltaOutput = await invokeLLM(deltaPrompt);
             try {
                const deltaMatch = deltaOutput.match(/{[\s\S]*}/);
                const deltaJson = JSON.parse(deltaMatch ? deltaMatch[0] : deltaOutput);
                strataJson.ENTROPY.entropy_delta = deltaJson.entropy_delta;
                
                if (deltaJson.entropy_delta === -100) {
                  strataJson.ENTROPY.status = 'RESOLVED';
                } else if (deltaJson.entropy_delta < 0) {
                  strataJson.ENTROPY.status = 'MITIGATED';
                } else if (deltaJson.entropy_delta > 0) {
                  strataJson.ENTROPY.status = 'COMPOUNDING';
                }
             } catch (e) {
                console.error("Delta LLM parse failed", e);
             }
          }
        }

        // 5. Append to state_strata (Transaction)
        await client.query('BEGIN');
        const insertStrataSql = `
          INSERT INTO state_strata (state_id, stratum_type, payload)
          VALUES ($1, $2, $3::jsonb)
        `;
        await client.query(insertStrataSql, [record.state_id, 'HARD', JSON.stringify(strataJson.HARD)]);
        await client.query(insertStrataSql, [record.state_id, 'HUMAN', JSON.stringify(strataJson.HUMAN)]);
        await client.query(insertStrataSql, [record.state_id, 'ENTROPY', JSON.stringify(strataJson.ENTROPY)]);
        
        await client.query(`UPDATE rsp_outbox SET status = 'DONE', processed_at = NOW() WHERE id = $1`, [record.id]);
        await client.query('COMMIT');

      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`Error processing outbox record ${record.id}:`, err);
        await client.query(`UPDATE rsp_outbox SET status = 'FAILED', last_error = $1 WHERE id = $2`, [err.message, record.id]);
      }
    }
    
    return { statusCode: 200, body: JSON.stringify({ processed: pendingRecords.length }) };
  } catch (error) {
    console.error('RSP Worker error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  } finally {
    await client.end();
  }
};
