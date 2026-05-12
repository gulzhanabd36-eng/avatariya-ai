exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const EXTELLA_TOKEN = process.env.EXTELLA_API_TOKEN;
  if (!EXTELLA_TOKEN) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'EXTELLA_API_TOKEN not configured' }) };
  }

  try {
    const { expert_name, params = {} } = JSON.parse(event.body || '{}');
    if (!expert_name) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'expert_name is required' }) };
    }

    // Allowed experts (whitelist for security)
    const ALLOWED_EXPERTS = [
      'analyze_contract',
      'summarize_document',
      'compare_documents',
      'analyze_excel_data',
      'write_business_document',
      'process_advisor',
      'search_knowledge_base'
    ];

    if (!ALLOWED_EXPERTS.includes(expert_name)) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: `Expert '${expert_name}' not allowed` }) };
    }

    // Inject OpenAI key from env if not provided
    const expertParams = { ...params };
    if (!expertParams.openai_api_key && process.env.OPENAI_API_KEY) {
      expertParams.openai_api_key = process.env.OPENAI_API_KEY;
    }
    if (!expertParams.supabase_url && process.env.SUPABASE_URL) {
      expertParams.supabase_url = process.env.SUPABASE_URL;
    }
    if (!expertParams.supabase_key && process.env.SUPABASE_KEY) {
      expertParams.supabase_key = process.env.SUPABASE_KEY;
    }

    // Call Extella API
    const res = await fetch('https://api.extella.ai/api/expert/run', {
      method: 'POST',
      headers: {
        'X-Auth-Token': EXTELLA_TOKEN,
        'Content-Type': 'application/json',
        'X-Profile-Id': 'default',
        'X-Agent-Id': 'agent_extella_default'
      },
      body: JSON.stringify({
        expert_name,
        params: expertParams
      })
    });

    const data = await res.json();

    if (!res.ok) {
      return { statusCode: res.status, headers, body: JSON.stringify({ error: data }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status: 'success',
        expert_name,
        result: data.result,
        execution_log: data.execution_log
      })
    };

  } catch (err) {
    console.error('Expert proxy error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
