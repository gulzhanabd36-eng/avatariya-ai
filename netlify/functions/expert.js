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
  if (!EXTELLA_TOKEN) return { statusCode: 500, headers, body: JSON.stringify({ error: 'EXTELLA_API_TOKEN not configured' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const { expert_name, params = {} } = body;
    if (!expert_name) return { statusCode: 400, headers, body: JSON.stringify({ error: 'expert_name is required' }) };

    const ALLOWED_EXPERTS = [
      'analyze_contract', 'summarize_document', 'compare_documents',
      'analyze_excel_data', 'write_business_document', 'process_advisor', 'search_knowledge_base'
    ];
    if (!ALLOWED_EXPERTS.includes(expert_name)) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: `Expert '${expert_name}' not allowed` }) };
    }

    // Experts that need Supabase credentials
    const NEEDS_SUPABASE = ['process_advisor', 'search_knowledge_base'];

    const expertParams = { ...params };

    // Always inject OpenAI key
    if (!expertParams.openai_api_key && process.env.OPENAI_API_KEY) {
      expertParams.openai_api_key = process.env.OPENAI_API_KEY;
    }

    // Only inject Supabase for experts that need it
    if (NEEDS_SUPABASE.includes(expert_name)) {
      if (!expertParams.supabase_url && process.env.SUPABASE_URL) expertParams.supabase_url = process.env.SUPABASE_URL;
      if (!expertParams.supabase_key && process.env.SUPABASE_KEY) expertParams.supabase_key = process.env.SUPABASE_KEY;
    }

    const res = await fetch('https://api.extella.ai/api/expert/run', {
      method: 'POST',
      headers: {
        'X-Auth-Token': EXTELLA_TOKEN,
        'Content-Type': 'application/json',
        'X-Profile-Id': 'default',
        'X-Agent-Id': 'agent_extella_default'
      },
      body: JSON.stringify({ expert_name, params: expertParams })
    });

    const data = await res.json();
    if (!res.ok) return { statusCode: res.status, headers, body: JSON.stringify({ error: data }) };

    // Smart text extraction from Python dict result string
    let textResult = data.result || '';
    if (typeof textResult === 'string') {
      const fields = ['text', 'analysis', 'summary', 'advice', 'comparison', 'document'];
      for (const field of fields) {
        const marker = "'" + field + "': '";
        const idx = textResult.indexOf(marker);
        if (idx !== -1) {
          const start = idx + marker.length;
          let end = start;
          while (end < textResult.length) {
            if (textResult[end] === '\\') { end += 2; continue; }
            if (textResult[end] === "'") break;
            end++;
          }
          textResult = textResult.slice(start, end)
            .replace(/\\n/g, '\n')
            .replace(/\\'/g, "'")
            .replace(/\\"/g, '"');
          break;
        }
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ status: 'success', expert_name, result: data.result, text: textResult })
    };

  } catch (err) {
    console.error('Expert proxy error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
