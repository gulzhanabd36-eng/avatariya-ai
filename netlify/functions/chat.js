exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const GROQ_API_KEY = process.env.GROQ_API_KEY;

  try {
    const { message, role } = JSON.parse(event.body || '{}');
    if (!message || !role) return { statusCode: 400, headers, body: JSON.stringify({ error: 'message и role обязательны' }) };

    // 1. Load knowledge base
    let chunks = [];
    try {
      const sbRes = await fetch(
        `${SUPABASE_URL}/rest/v1/knowledge_base?or=(role.eq.${role},role.eq.all)&select=id,content,source_file,category,keywords&limit=500`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      if (sbRes.ok) chunks = await sbRes.json();
    } catch(e) {
      console.error('Supabase error:', e.message);
    }

    // 2. Keyword scoring
    const normalize = (str) => str.toLowerCase()
      .replace(/[^а-яёa-z0-9\s]/gi, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);

    const queryWords = normalize(message);
    let contextText = '';
    let hasRelevantDocs = false;
    let sources = [];

    if (Array.isArray(chunks) && chunks.length > 0) {
      const scored = chunks.map(c => {
        const haystack = normalize([
          c.content || '',
          Array.isArray(c.keywords) ? c.keywords.join(' ') : (c.keywords || ''),
          c.category || '',
          c.source_file || ''
        ].join(' '));
        const categoryHay = normalize((c.category || '') + ' ' + (c.source_file || ''));
        let score = 0;
        for (const w of queryWords) {
          if (categoryHay.includes(w)) score += 3;
          else if (haystack.includes(w)) score += 1;
        }
        return { ...c, score };
      }).sort((a, b) => b.score - a.score);

      // Top 3 chunks, max 1500 chars each — fits within Groq free tier limits
      const top = scored[0]?.score >= 1 ? scored.slice(0, 3) : [];
      hasRelevantDocs = top.length > 0;

      if (top.length > 0) {
        contextText = top.map((c, i) => {
          const content = (c.content || '').slice(0, 1500);
          return `[${i + 1}. ${c.source_file || c.category}]\n${content}`;
        }).join('\n\n───\n\n');
        sources = [...new Set(top.map(c => c.source_file).filter(Boolean))];
      }
    }

    let systemPrompt, userContent;

    if (hasRelevantDocs) {
      systemPrompt = `Ты — AI-ассистент рестопарка Avatariya (Алматы). Отвечай ТОЛЬКО на основе документов. Отвечай на языке вопроса. Отвечай чётко и структурированно.`;
      userContent = `База знаний:\n\n${contextText}\n\n═══\n\nВопрос: ${message}`;
    } else {
      systemPrompt = `Ты — опытный наставник сотрудников рестопарка Avatariya (Алматы). Дай конкретный пошаговый совет. Отвечай на языке вопроса. В конце добавляй: "💡 Для точных регламентов — уточни у менеджера смены."` ;
      userContent = `Ситуация: ${message}`;
    }

    let gptRes;
    try {
      gptRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent }
          ],
          max_tokens: 1000,
          temperature: hasRelevantDocs ? 0.1 : 0.3
        })
      });
    } catch (fetchErr) {
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ answer: `⚠️ Не удалось подключиться к Groq: ${fetchErr.message}`, sources: [], from_kb: false })
      };
    }

    const gptRaw = await gptRes.text();
    let gptData;
    try { gptData = JSON.parse(gptRaw); }
    catch(e) {
      return { statusCode: 200, headers, body: JSON.stringify({ answer: `⚠️ Ошибка: ${gptRaw.slice(0, 200)}`, sources: [], from_kb: false }) };
    }

    if (gptData.error) {
      return { statusCode: 200, headers, body: JSON.stringify({ answer: `⚠️ Groq: ${gptData.error.message}`, sources: [], from_kb: false }) };
    }

    const answer = gptData.choices?.[0]?.message?.content || '⚠️ Ответ не получен.';
    return { statusCode: 200, headers, body: JSON.stringify({ answer, sources, from_kb: hasRelevantDocs }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: `Ошибка: ${err.message}` }) };
  }
};
