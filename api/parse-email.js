// api/parse-email.js
// Deploy to Vercel — this becomes: yourdomain.vercel.app/api/parse-email
// Set these in Vercel Environment Variables:
//   ANTHROPIC_API_KEY = your Claude API key (console.anthropic.com)
//   SUPABASE_URL = your Supabase project URL
//   SUPABASE_KEY = your Supabase service_role key (NOT anon key)
//   WEBHOOK_SECRET = any random string you choose (e.g. "sm-webhook-2025")

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Verify the request is from your Zapier webhook
  const secret = req.headers['x-webhook-secret'];
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { from, subject, body, date } = req.body;

  if (!body) return res.status(400).json({ error: 'No email body' });

  try {
    // Step 1: Use Claude to parse the email
    const parsed = await parseEmailWithClaude(from, subject, body);

    if (!parsed || parsed.action === 'ignore') {
      await logEmail({ from, subject, action: 'ignored', summary: 'Not a relevant carrier email' });
      return res.status(200).json({ status: 'ignored' });
    }

    // Step 2: Update Supabase based on parsed data
    const result = await updateSupabase(parsed, from, subject);

    // Step 3: Log the email
    await logEmail({
      from, subject,
      carrier: parsed.carrier,
      agent: parsed.agent_name,
      client: parsed.client_name,
      action: parsed.action,
      policy_id: result.policy_id,
      summary: parsed.summary
    });

    return res.status(200).json({ status: 'success', parsed, result });

  } catch (err) {
    console.error('Parse error:', err);
    await logEmail({ from, subject, action: 'error', error: err.message });
    return res.status(500).json({ error: err.message });
  }
}

// ── CLAUDE EMAIL PARSER ──
async function parseEmailWithClaude(from, subject, body) {
  const AGENT_LIST = `
    Luke H. (luke) - SM2
    Nathan G. (nathan) - SM3
    Ashton L. (ashton) - AG1
    Joseph H. (joseph) - AG2
    Dalton (dalton) - AG3
    Asher J. (asher) - AG3
    Paul H. (paul) - AG3
    Darryl T. (darryl) - AG3
  `;

  const CARRIER_DOMAINS = {
    'transamerica.com': 'Transamerica',
    'aegonusa.com': 'Transamerica',
    'aiglife.com': 'AIG/Corebridge',
    'corebridgefinancial.com': 'AIG/Corebridge',
    'mutualofomaha.com': 'Mutual of Omaha',
    'foresters.com': 'Foresters',
    'americo.com': 'Americo',
    'americanamicable.com': 'American Amicable',
    'libertybankers.com': 'Liberty Bankers',
    'gerberlife.com': 'Gerber',
    'ngl.com': 'NGL'
  };

  // Detect carrier from email domain
  let detectedCarrier = 'Unknown';
  for (const [domain, carrier] of Object.entries(CARRIER_DOMAINS)) {
    if (from && from.includes(domain)) { detectedCarrier = carrier; break; }
  }

  const prompt = `You are an AI assistant for a life insurance agency called SalesMafia (NASB).
You received this carrier email. Extract structured data from it.

FROM: ${from}
SUBJECT: ${subject}
BODY:
${body.substring(0, 3000)}

DETECTED CARRIER: ${detectedCarrier}

OUR AGENTS:
${AGENT_LIST}

Your job: Determine what happened and who it affects.

Return ONLY valid JSON with this exact structure:
{
  "action": "status_update" | "requirement_added" | "policy_issued" | "policy_submitted" | "ignore",
  "carrier": "carrier name or null",
  "agent_name": "matching agent name from our list or null",
  "agent_id": "agent id (luke/nathan/ashton/joseph/dalton/asher/paul/darryl) or null",
  "client_name": "insured/client full name or null",
  "policy_number": "policy number if mentioned or null",
  "annual_premium": number or null,
  "new_status": "submitted" | "pending" | "requirements" | "issued" | "lapse" | null,
  "requirement_title": "short title of requirement if action is requirement_added, else null",
  "requirement_desc": "full description of what is needed, else null",
  "requirement_priority": "urgent" | "standard" | "low" | null,
  "due_date": "YYYY-MM-DD if mentioned else null",
  "summary": "one sentence summary of what this email means",
  "confidence": "high" | "medium" | "low"
}

Rules:
- If this is not a life insurance policy status email, set action to "ignore"
- Match agent by looking for their name in the email body or case details
- For requirements: be specific about what document/action is needed
- Due dates are usually stated as "must receive by [date]" or "required within X days"
- If premium not stated, set to null
- Never guess - if unsure about agent, set agent fields to null`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await response.json();
  const text = data.content[0].text;

  // Parse the JSON response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude did not return valid JSON');

  return JSON.parse(jsonMatch[0]);
}

// ── SUPABASE UPDATER ──
async function updateSupabase(parsed, fromEmail, subject) {
  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_KEY;

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + SUPA_KEY,
    'apikey': SUPA_KEY,
    'Prefer': 'return=representation'
  };

  const result = { policy_id: null, action_taken: [] };

  // ── Handle new policy submission ──
  if (parsed.action === 'policy_submitted' && parsed.agent_id && parsed.client_name) {
    const policy = {
      agent_id: parsed.agent_id,
      client_name: parsed.client_name,
      carrier: parsed.carrier,
      product: 'TBD',
      annual_premium: parsed.annual_premium || 0,
      status: 'submitted',
      policy_number: parsed.policy_number,
      source: 'email_auto',
      notes: 'Auto-created from carrier email: ' + subject
    };

    const polRes = await fetch(SUPA_URL + '/rest/v1/policies', {
      method: 'POST', headers,
      body: JSON.stringify(policy)
    });
    const polData = await polRes.json();
    if (polData[0]) {
      result.policy_id = polData[0].id;
      result.action_taken.push('created_policy');

      // Log activity
      await logActivity(SUPA_URL, SUPA_KEY, parsed.agent_id,
        'policy_submitted', parsed.client_name + ' submitted with ' + parsed.carrier, result.policy_id);
    }
  }

  // ── Handle status update (issued, pending, lapse) ──
  if ((parsed.action === 'status_update' || parsed.action === 'policy_issued') && parsed.client_name) {
    // Find the existing policy
    let searchUrl = SUPA_URL + '/rest/v1/policies?client_name=ilike.*' +
      encodeURIComponent(parsed.client_name) + '*&order=created_at.desc&limit=1';
    if (parsed.agent_id) searchUrl += '&agent_id=eq.' + parsed.agent_id;

    const findRes = await fetch(searchUrl, { headers });
    const policies = await findRes.json();

    if (policies && policies.length > 0) {
      const pol = policies[0];
      result.policy_id = pol.id;

      // Update status
      const newStatus = parsed.new_status ||
        (parsed.action === 'policy_issued' ? 'issued' : 'pending');

      await fetch(SUPA_URL + '/rest/v1/policies?id=eq.' + pol.id, {
        method: 'PATCH', headers,
        body: JSON.stringify({
          status: newStatus,
          policy_number: parsed.policy_number || pol.policy_number,
          issued_date: newStatus === 'issued' ? new Date().toISOString().split('T')[0] : null
        })
      });
      result.action_taken.push('updated_status_to_' + newStatus);

      // Update agent's current AP if issued
      if (newStatus === 'issued' && pol.annual_premium && parsed.agent_id) {
        const agentRes = await fetch(SUPA_URL + '/rest/v1/agents?id=eq.' + parsed.agent_id, { headers });
        const agents = await agentRes.json();
        if (agents && agents[0]) {
          const newCur = (agents[0].cur || 0) + pol.annual_premium;
          await fetch(SUPA_URL + '/rest/v1/agents?id=eq.' + parsed.agent_id, {
            method: 'PATCH', headers,
            body: JSON.stringify({ cur: newCur })
          });
        }
        result.action_taken.push('updated_agent_ap');
      }

      // Log activity
      const agId = parsed.agent_id || pol.agent_id;
      if (agId) {
        await logActivity(SUPA_URL, SUPA_KEY, agId,
          'policy_' + newStatus,
          parsed.client_name + ' policy ' + newStatus + ' by ' + parsed.carrier,
          pol.id);
      }
    }
  }

  // ── Handle new requirement ──
  if (parsed.action === 'requirement_added' && parsed.requirement_title) {
    // Find or create the policy
    let polId = result.policy_id;

    if (!polId && parsed.client_name) {
      let searchUrl = SUPA_URL + '/rest/v1/policies?client_name=ilike.*' +
        encodeURIComponent(parsed.client_name) + '*&order=created_at.desc&limit=1';
      const findRes = await fetch(searchUrl, { headers });
      const policies = await findRes.json();
      if (policies && policies[0]) polId = policies[0].id;
    }

    const req = {
      policy_id: polId,
      agent_id: parsed.agent_id,
      title: parsed.requirement_title,
      description: parsed.requirement_desc || parsed.summary,
      priority: parsed.requirement_priority || 'standard',
      due_date: parsed.due_date,
      status: 'open',
      source: 'email_auto'
    };

    await fetch(SUPA_URL + '/rest/v1/requirements', {
      method: 'POST', headers,
      body: JSON.stringify(req)
    });
    result.action_taken.push('created_requirement');

    // Update policy status to requirements
    if (polId) {
      await fetch(SUPA_URL + '/rest/v1/policies?id=eq.' + polId, {
        method: 'PATCH', headers,
        body: JSON.stringify({ status: 'requirements' })
      });
    }

    // Log activity
    if (parsed.agent_id) {
      await logActivity(SUPA_URL, SUPA_KEY, parsed.agent_id,
        'requirement_added',
        'New requirement: ' + parsed.requirement_title + ' for ' + parsed.client_name,
        polId);
    }
  }

  return result;
}

// ── LOG HELPERS ──
async function logEmail(data) {
  try {
    await fetch(process.env.SUPABASE_URL + '/rest/v1/email_log', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.SUPABASE_KEY,
        'apikey': process.env.SUPABASE_KEY
      },
      body: JSON.stringify({
        from_address: data.from,
        subject: data.subject,
        carrier_detected: data.carrier,
        agent_matched: data.agent,
        client_matched: data.client,
        action_taken: data.action,
        policy_id_affected: data.policy_id,
        raw_summary: data.summary,
        error: data.error || null
      })
    });
  } catch(e) { console.error('Log error:', e); }
}

async function logActivity(supaUrl, supaKey, agentId, eventType, description, policyId) {
  try {
    await fetch(supaUrl + '/rest/v1/activity_log', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + supaKey,
        'apikey': supaKey
      },
      body: JSON.stringify({
        agent_id: agentId,
        event_type: eventType,
        description: description,
        policy_id: policyId
      })
    });
  } catch(e) { console.error('Activity log error:', e); }
}
