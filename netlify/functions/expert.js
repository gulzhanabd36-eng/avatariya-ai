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
  if (!EXTELLA_TOKEN) return { statusCode: 200, headers, body: JSON.stringify({ status: 'error', text: '⚠️ EXTELLA_API_TOKEN not configured' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const { expert_name, params = {} } = body;
    if (!expert_name) return { statusCode: 200, headers, body: JSON.stringify({ status: 'error', text: 'expert_name is required' }) };

    const ALLOWED_EXPERTS = [
      'analyze_contract', 'summarize_document', 'compare_documents',
      'analyze_excel_data', 'write_business_document', 'process_advisor', 'search_knowledge_base'
    ];
    if (!ALLOWED_EXPERTS.includes(expert_name)) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'error', text: `Expert '${expert_name}' not allowed` }) };
    }

    const expertParams = { ...params };
    delete expertParams.role;

    if (!expertParams.openai_api_key && process.env.OPENAI_API_KEY) {
      expertParams.openai_api_key = process.env.OPENAI_API_KEY;
    }

    const NEEDS_SUPABASE = ['process_advisor', 'search_knowledge_base'];
    if (NEEDS_SUPABASE.includes(expert_name)) {
      if (!expertParams.supabase_url && process.env.SUPABASE_URL) expertParams.supabase_url = process.env.SUPABASE_URL;
      if (!expertParams.supabase_key && process.env.SUPABASE_KEY) expertParams.supabase_key = process.env.SUPABASE_KEY;
    }

    let res;
    try {
      res = await fetch('https://api.extella.ai/api/expert/run', {
        method: 'POST',
        headers: {
          'X-Auth-Token': EXTELLA_TOKEN,
          'Content-Type': 'application/json',
          'X-Profile-Id': 'default',
          'X-Agent-Id': 'agent_extella_default'
        },
        body: JSON.stringify({ expert_name, params: expertParams })
      });
    } catch (fetchErr) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          status: 'error',
          text: `⚠️ Не удалось подключиться к Extella: ${fetchErr.message}`
        })
      };
    }

    const rawText = await res.text();

    if (!rawText || rawText.trim() === '') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          status: 'error',
          text: `⚠️ Extella вернул пустой ответ (HTTP ${res.status}). Убедись что Extella Desktop запущена на твоём компьютере.`
        })
      };
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (parseErr) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          status: 'error',
          text: `⚠️ Ошибка ответа Extella: ${rawText.slice(0, 200)}`
        })
      };
    }

    if (!res.ok || data.status === 'error') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          status: 'error',
          text: `⚠️ ${data.message || JSON.stringify(data)}`
        })
      };
    }

    const resultStr = data.result || '';
    if (typeof resultStr === 'string' && resultStr.includes('[Execution Error]')) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: 'error', text: `⚠️ ${resultStr}` })
      };
    }

    // Extract text from result
    let textResult = resultStr;
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
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ status: 'error', text: `⚠️ Ошибка: ${err.message}` })
    };
  }
};
